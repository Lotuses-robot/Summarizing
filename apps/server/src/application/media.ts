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
// 管线 = 校验 → 超限判定 → 压缩（>500 KiB 触发，目标 ≤500 KiB）→ sha256 去重 → 落盘 + 落行。
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
  alphaFlattened: boolean;
}> {
  const declared = resolveMime(bytes, opts.declaredMime);
  const { data, mime, animationCompressed, alphaFlattened } = await compressImage(bytes, declared);

  const id = crypto.createHash("sha256").update(data).digest("hex");
  const createdAt = nowWallClock();
  const expiresAt = initialMediaExpiry(createdAt, data.length);
  const file = mediaFilePath(mediaDir, id, mime);
  let wrote = false;
  if (!existsFile(file)) {
    // 幂等：先写临时文件再 rename，防并发写同一路径时半截文件被读走
    mkdirSync(mediaDir, { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const { writeFileSync, renameSync } = await import("node:fs");
    writeFileSync(tmp, data);
    renameSync(tmp, file);
    wrote = true;
  }
  try {
    repo.insertMedia(db, {
      id,
      mime,
      sizeBytes: data.length,
      createdAt,
      expiresAt,
      originUrl: opts.originUrl ?? null,
    });
  } catch (err) {
    // 落行失败 → 撤掉本次新建的文件：清理器按行扫，没有行指向的文件永远没人回收。
    // 只删「自己新建的」且「库里确实没有这一行」（并发插入同一 sha 时，文件要留给对方）。
    if (wrote) {
      try {
        if (repo.getMedia(db, id) === null) rmSync(file, { force: true });
      } catch {
        // 连读都失败就保守留着：最多一个孤儿文件，比误删别人在用的文件安全
      }
    }
    throw err;
  }
  return { id, mime, sizeBytes: data.length, animationCompressed, alphaFlattened };
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

/** 压缩（>500 KiB 触发）：质量阶梯 → 降采样；动图先降帧。压到最低档仍 >500 KiB → 拒。
 *  两个降级标记都不许静默：`animationCompressed`（动图变成静图/被重编码）、
 *  `alphaFlattened`（透明背景被填白——JPEG 没有 alpha 通道）。 */
async function compressImage(
  bytes: Buffer,
  mime: string,
): Promise<{ data: Buffer; mime: string; animationCompressed: boolean; alphaFlattened: boolean }> {
  const image = sharp(bytes, { failOn: "none" });
  const meta = await image.metadata().catch((err: unknown) => {
    throw new Error(`图片无法解析：${errText(err)}`);
  });

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const frames = meta.pages ?? 1;
  if (width <= 0 || height <= 0) throw new Error("图片尺寸无法解析");
  // 像素闸按**总解码量**算：多帧图的 height 是单帧高（实测 400×400 + pages=40），
  // 只乘一帧会放 2000 帧的图进来（首帧 1.44Mpx 过闸、实际解码 28.8 亿像素）
  const frameHeight = meta.pageHeight ?? height;
  if (width * frameHeight * frames > MEDIA_MAX_PIXELS) {
    throw new Error("图片像素数超过上限（2500 万像素）");
  }

  // ≤500 KiB：原样入库（不重编码——避免无谓的画质损失与耗时）
  if (bytes.length <= MEDIA_TARGET_BYTES) {
    return { data: bytes, mime, animationCompressed: false, alphaFlattened: false };
  }

  // 动图（GIF / 多帧 WebP）：先降帧，仍超则按静图档继续压。
  // 代价是动画可能变短或变单帧——返回标记让界面提示，不静默（用户 2026-10-20 定）。
  if (frames > 1) {
    const animated = await sharp(bytes, { animated: true })
      .resize(undefined, undefined, { withoutEnlargement: true })
      .gif({ effort: 6 })
      .toBuffer()
      .catch(() => null);
    if (animated !== null && animated.length <= MEDIA_TARGET_BYTES) {
      return {
        data: animated,
        mime: "image/gif",
        animationCompressed: true,
        alphaFlattened: false,
      };
    }
  }

  // 静图档：**先缩到候选长边，再在小图上试质量**。
  // 顺序反了会极慢：对 4000 万像素的原图直接 mozjpeg 一次要数秒，而原尺寸多半压不到目标
  // （输入已 >500 KiB），等于白烧 CPU。先 resize 再编码，每档都在接近目标尺寸的图上工作。
  // 每档内质量从高到低，第一个 ≤目标的就返回（命中即止，不再糟蹋画质）。
  // 候选长边按源图实际长边去重（`withoutEnlargement` 下，源图比候选小时几档其实是同一个尺寸——
  // 不去重就会把同一套质量阶梯重复编码好几次）。
  const flattenAlpha = meta.hasAlpha === true; // JPEG 无 alpha：透明区不填白就是默认黑
  const longSide = Math.max(width, height);
  const edges = [...new Set([2560, 1920, 1280].map((e) => Math.min(e, longSide)))];
  for (const longEdge of edges) {
    for (const quality of [85, 75, 65, 55]) {
      let pipeline = sharp(bytes, { failOn: "none" })
        .rotate() // 按 EXIF orientation 归一（不存方向标记，读取侧也一致）
        .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true });
      if (flattenAlpha) pipeline = pipeline.flatten({ background: "#ffffff" });
      const buf = await pipeline
        .jpeg({ quality, mozjpeg: true })
        .toBuffer()
        .catch(() => null);
      if (buf !== null && buf.length <= MEDIA_TARGET_BYTES) {
        return {
          data: buf,
          mime: "image/jpeg",
          // 走到静图档的动图 = 动画没了（sharp 默认只取第一帧）——必须报 true，否则界面不提示
          animationCompressed: frames > 1,
          alphaFlattened: flattenAlpha,
        };
      }
    }
  }
  throw new Error("图片压到最小仍超过 500 KiB，无法入库");
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

/** 清理节拍：每小时一次（个人中枢量级，够用且不打搅磁盘）。 */
const SWEEP_INTERVAL_MS = 3_600_000;

/** 上线清理器（009 FR-012）：装配空间时跑一次，此后每小时一次；返回停止函数（空间关停时调）。
 *  `unref()`：定时器不阻止进程退出——Ctrl-C 不必等它。单次失败只留痕，绝不影响服务。 */
export function startMediaSweeper(db: DbOrTx, mediaDir: string): () => void {
  /** 清一次；失败只留痕（下个整点再试，绝不影响服务）。 */
  const tick = (): void => {
    try {
      sweepExpiredMedia(db, mediaDir);
    } catch (err) {
      process.stderr.write(`[media] 过期清理失败（下次再试）：${errText(err)}\n`);
    }
  };
  tick(); // 启动即清一次：停机期间到期的图不必再等一小时
  const timer = setInterval(tick, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
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
