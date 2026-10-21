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
//   后台跑：失败只留痕，绝不阻塞进站回执（信源等的是 202）；kickDigest 等它跑完再开始消化
//   （否则执行器写证据时 media 行可能还没落，引用就抬不了 90 天）；
//   并发上限 2：单机个人中枢够用，又不会把网关或对方 CDN 打疼；
//   已在缓存（同 URL）→ 跳过（内容寻址天然去重，但省一次 HTTP 更省事）；
//   抓取失败只对瞬态错误重试（超时/连接中断/DNS，最多 3 次），4xx/超限/格式问题不重试。

/** 后台下载的最大并发（个人中枢够用；不打疼对方 CDN）。 */
const MAX_CONCURRENT = 2;

/** 单张图的最多尝试次数：**只对瞬态错误重试**（超时/连接中断/DNS），4xx、超限、格式不符不重试。 */
const MAX_ATTEMPTS = 3;

/** 重试退避基数（毫秒）：第 1 次失败等 300ms，第 2 次等 600ms。 */
const RETRY_BACKOFF_MS = 300;

/** 进站后缓存本批的图片（返回 Promise，**不阻塞进站回执**——调用方自己决定等不等）。
 *  内部已兜底：任何失败都只留痕，不会 reject。 */
export function cacheIngestImages(db: Db, mediaDir: string, rawInputId: string): Promise<void> {
  return run(db, mediaDir, rawInputId).catch((err: unknown) => {
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

/** 缓存一张：已在库 → 跳过；否则下载（瞬态错误重试）→ 存储。返回三态之一（调用方计数）。 */
async function cacheOne(
  db: Db,
  mediaDir: string,
  url: string,
): Promise<"cached" | "skipped" | "failed"> {
  if (repo.getMediaByOriginUrl(db, url) !== null) return "skipped";

  /** 下载字节；瞬态失败按 MAX_ATTEMPTS 重试，最终失败返回 null（已留痕）。 */
  const download = async (): Promise<Uint8Array | null> => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const { bytes } = await downloadImageBytes(url);
        return bytes;
      } catch (err) {
        const transient = isTransient(err);
        if (!transient || attempt === MAX_ATTEMPTS) {
          process.stderr.write(
            `[media] 抓图失败（${url}，第 ${attempt}/${MAX_ATTEMPTS} 次${transient ? "，已重试" : "，不重试"}）：${errText(err)}\n`,
          );
          return null;
        }
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
    return null;
  };

  const bytes = await download();
  if (bytes === null) return "failed";
  try {
    await storeImageBytes(db, mediaDir, Buffer.from(bytes), { originUrl: url });
    return "cached";
  } catch (err) {
    // 下载成功但存储拒收（超限/格式/像素）——与网络失败分开留痕，排障时分得清
    process.stderr.write(`[media] 图片不合格，未入库（${url}）：${errText(err)}\n`);
    return "failed";
  }
}

/** 是否值得重试：超时/中断/网络类（带 `code`）算瞬态；HTTP 4xx、超限、格式不符等一律不重试。 */
function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  return "code" in err && typeof err.code === "string";
}

/** 退避等待（毫秒）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
