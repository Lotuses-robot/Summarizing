import { extractImageUrls } from "@summarizing/shared";
import { errText } from "@summarizing/shared";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import { downloadImageBytes } from "../shared/imageDownloader";
import { storeImageBytes } from "./media";

// 信源图片进站缓存（009 刀 3）：批次落档后扫原文里的 `[图片](http…)` 占位，
// 后台把它们抓下来存本地。QQ 图片链接约小时级过期——不抓就等于永久丢失。
// 设计约束：
//   **原文逐字不变**（占位文本照旧，界面按映射解析成图）——「改原文」会让引文与原文字符串
//   对不上，证据链当场断；
//   后台 + fire-and-forget：失败只留痕，绝不影响进站回执（信源等的是 202）；
//   并发上限 2：单机个人中枢够用，又不会把网关或对方 CDN 打疼；
//   已在缓存（同 URL）→ 跳过（内容寻址天然去重，但省一次 HTTP 更省事）。

/** 后台下载的最大并发（个人中枢够用；不打疼对方 CDN）。 */
const MAX_CONCURRENT = 2;

/** 进站后缓存本批的图片（fire-and-forget：调用方不 await，失败只留痕）。 */
export function cacheIngestImages(db: Db, mediaDir: string, rawInputId: string): void {
  // 命中已缓存的 URL 查一次库就跳过——下面循环里逐个判断
  void run(db, mediaDir, rawInputId).catch((err: unknown) => {
    process.stderr.write(
      `[media] 进站图片缓存异常（不影响进站，raw=${rawInputId}）：${errText(err)}\n`,
    );
  });
}

/** 缓存一批图片（真实执行体；cacheIngestImages 只包一层兜底）。 */
async function run(db: Db, mediaDir: string, rawInputId: string): Promise<void> {
  const raw = repo.getRawInput(db, rawInputId);
  if (raw === null) return; // 批次不在了（并发清理）——没什么可做
  const urls = extractImageUrls(raw.content).filter((u) => u.startsWith("http"));
  if (urls.length === 0) return;

  let cached = 0;
  let skipped = 0;
  let failed = 0;
  // 简易并发：最多 MAX_CONCURRENT 个在飞，队列里逐个往外递
  const queue = [...urls];
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const outcome = await cacheOne(db, mediaDir, next);
      if (outcome === "cached") cached += 1;
      else if (outcome === "skipped") skipped += 1;
      else failed += 1;
    }
  });
  await Promise.all(workers);

  // 一次汇总留痕（不静默：抓失败要看得见）
  if (cached + skipped + failed > 0) {
    process.stderr.write(
      `[media] 进站图片缓存（raw=${rawInputId}）：缓存 ${cached} / 已有 ${skipped} / 失败 ${failed}\n`,
    );
  }
}

/** 缓存一张：已在库 → 跳过；否则下载（过五道闸）→ 存储。返回三态之一（调用方计数）。 */
async function cacheOne(
  db: Db,
  mediaDir: string,
  url: string,
): Promise<"cached" | "skipped" | "failed"> {
  if (repo.getMediaByOriginUrl(db, url) !== null) return "skipped";
  try {
    const { bytes } = await downloadImageBytes(url);
    await storeImageBytes(db, mediaDir, Buffer.from(bytes), { originUrl: url });
    return "cached";
  } catch (err) {
    // 失败只留痕——原文占位保留，界面回退原链接（不静默、不阻塞）
    process.stderr.write(`[media] 缓存失败（${url}）：${errText(err)}\n`);
    return "failed";
  }
}
