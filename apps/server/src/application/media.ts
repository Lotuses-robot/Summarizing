import sharp from "sharp";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { errText } from "@summarizing/shared";
import * as repo from "../storage/repo";
import type { DbOrTx } from "../storage/db";
import { nowWallClock } from "../shared/time";
import { ALLOWED_IMAGE_MIME, mediaExt, matchesMagic, sniffImageMime } from "../shared/imageBytes";
import {
  MEDIA_MAX_INPUT_BYTES,
  MEDIA_MAX_PIXELS,
  MEDIA_TARGET_BYTES,
  initialMediaExpiry,
} from "../shared/mediaTtl";

// 图片存储执行层（009）。三条入口共用同一段逻辑：
//   前台上传 POST /api/media、信源图片进站缓存、agent0 取图成功后顺手持久化。
// 管线 = 校验 → 超限判定 → 压缩（>2 MiB 触发，目标 ≤1.9 MiB）→ sha256 去重 → 落盘 + 落行。
// ⚠️ 压缩**一律在这里做**，不在路上任何一处——同一张图不同入口进来必须有同样的结果。

/** 存储一帧图片（上传 / 进站缓存 / 取图持久化的共同入口）。
 *  失败一律抛 Error（人话，界面直接可见）——调用方按自己场景处理（HTTP 400 / stderr 留痕）。 */
export async function storeImageBytes(
  db: DbOrTx,
  mediaDir: string,
  bytes: Buffer,
  opts: { declaredMime?: string; originUrl?: string } = {},
): Promise<{
  id: string;
  mime: string;
  sizeBytes: number;
  animationCompressed: boolean;
}> {
  const declared = resolveMime(bytes, opts.declaredMime);
  const { data, mime, animationCompressed } = await compressImage(bytes, declared);

  const id = crypto.createHash("sha256").update(data).digest("hex");
  const createdAt = nowWallClock();
  const expiresAt = initialMediaExpiry(createdAt, data.length);
  const file = mediaFilePath(mediaDir, id, mime);
  if (!existsFile(file)) {
    // 幂等：先写临时文件再 rename，防并发写同一路径时半截文件被读走
    mkdirSync(mediaDir, { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const { writeFileSync, renameSync } = await import("node:fs");
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  }
  repo.insertMedia(db, {
    id,
    mime,
    sizeBytes: data.length,
    createdAt,
    expiresAt,
    originUrl: opts.originUrl ?? null,
  });
  return { id, mime, sizeBytes: data.length, animationCompressed };
}

/** 文件路径：`media/<uid>/<sha256>.<ext>`（内容寻址，字节永不改 → 可长期缓存）。 */
export function mediaFilePath(mediaDir: string, id: string, mime: string): string {
  return path.join(mediaDir, `${id}.${mediaExt(mime)}`);
}

/** 读一帧图片的字节（agent0 本地命中 / HTTP 读取共用）。文件缺失抛错（调用方转 404 / 降级）。 */
export function readMediaBytes(mediaDir: string, id: string, mime: string): Buffer {
  const file = mediaFilePath(mediaDir, id, mime);
  if (!existsFile(file)) throw new Error(`图片文件缺失：${id}`);
  return readFileSync(file);
}

/** MIME 判定：声明的可信但**必须与魔数一致**；不一致或以 binary 声明时按魔数兜底。
 *  白名单外（含 SVG）直接拒——SVG 可携带脚本，且不便压缩，收它只放大暴露面。 */
function resolveMime(bytes: Buffer, declared: string | undefined): string {
  if (bytes.length > MEDIA_MAX_INPUT_BYTES) {
    throw new Error("图片超过大小上限（20 MiB）");
  }
  const want = declared?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (want !== "" && ALLOWED_IMAGE_MIME.has(want) && matchesMagic(want, bytes)) return want;
  const sniffed = sniffImageMime(bytes);
  if (sniffed === null) {
    throw new Error(want === "" ? "图片文件不存在" : `不是支持的图片格式（${want}）`);
  }
  return sniffed;
}

/** 压缩（>2 MiB 触发）：质量阶梯 → 降采样；动图先降帧。压到最低档仍 ≥2 MiB → 拒。 */
async function compressImage(
  bytes: Buffer,
  mime: string,
): Promise<{ data: Buffer; mime: string; animationCompressed: boolean }> {
  const image = sharp(bytes, { failOn: "none" });
  const meta = await image.metadata().catch((err: unknown) => {
    throw new Error(`图片无法解析：${errText(err)}`);
  });

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) throw new Error("图片尺寸无法解析");
  if (width * height > MEDIA_MAX_PIXELS) {
    throw new Error("图片像素数超过上限（5000 万像素）");
  }

  // ≤2 MiB：原样入库（不重编码——避免无谓的画质损失与耗时）
  if (bytes.length <= MEDIA_TARGET_BYTES) {
    return { data: bytes, mime, animationCompressed: false };
  }

  // 动图（GIF / 多帧 WebP）：先降帧，仍超则按静图档继续压。
  // 代价是动画可能变短或变单帧——返回标记让界面提示，不静默（用户 2026-10-20 定）。
  const frames = meta.pages ?? 1;
  if (frames > 1) {
    const animated = await sharp(bytes, { animated: true })
      .resize(undefined, undefined, { withoutEnlargement: true })
      .gif({ effort: 6 })
      .toBuffer()
      .catch(() => null);
    if (animated !== null && animated.length <= MEDIA_TARGET_BYTES) {
      return { data: animated, mime: "image/gif", animationCompressed: true };
    }
  }

  // 静图档：**先缩到候选长边，再在小图上试质量**。
  // 顺序反了会极慢：对 4000 万像素的原图直接 mozjpeg 一次要数秒，而原尺寸多半压不到目标
  // （输入已 >2 MiB），等于白烧 CPU。先 resize 再编码，每档都在接近目标尺寸的图上工作。
  // 每档内质量从高到低，第一个 ≤目标的就返回（命中即止，不再糟蹋画质）。
  for (const longEdge of [2560, 1920, 1280]) {
    for (const quality of [85, 75, 65, 55]) {
      const buf = await sharp(bytes, { failOn: "none" })
        .rotate() // 按 EXIF orientation 归一（不存方向标记，读取侧也一致）
        .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer()
        .catch(() => null);
      if (buf !== null && buf.length <= MEDIA_TARGET_BYTES) {
        return { data: buf, mime: "image/jpeg", animationCompressed: false };
      }
    }
  }
  throw new Error("图片压到最小仍超过 2 MiB，无法入库");
}

/** 清理过期媒体：删文件 + 删行，stderr 一次汇总（张数/字节）。文件缺失只删行并留痕。 */
export function sweepExpiredMedia(
  db: DbOrTx,
  mediaDir: string,
  now = nowWallClock(),
): { removed: number; files: number; bytes: number; missingFiles: number } {
  const expired = repo.listExpiredMedia(db, now);
  let files = 0;
  let bytes = 0;
  let missingFiles = 0;
  for (const row of expired) {
    const file = mediaFilePath(mediaDir, row.id, row.mime);
    if (existsFile(file)) {
      try {
        bytes += statSync(file).size;
        rmSync(file, { force: true });
        files += 1;
      } catch (err) {
        process.stderr.write(`[media] 删文件失败（继续清理，稍后重试）：${file} ${errText(err)}\n`);
        continue; // 文件删不掉就不删行——否则行消失、文件成孤儿（反向不可收）
      }
    } else {
      missingFiles += 1;
      process.stderr.write(`[media] 文件已缺失，只清行：${row.id}\n`);
    }
    repo.deleteMediaRow(db, row.id);
  }
  if (expired.length > 0) {
    process.stderr.write(
      `[media] 清理过期图片：${expired.length} 行（文件 ${files} 个 / ${(bytes / 1024).toFixed(1)} KiB，缺失 ${missingFiles}）\n`,
    );
  }
  return { removed: expired.length, files, bytes, missingFiles };
}

/** 文件是否存在（用 statSync，比 existsSync 少一次竞态误判）。 */
function existsFile(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}
