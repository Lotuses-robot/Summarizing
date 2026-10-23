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
//   抓取失败只对瞬态错误重试一次（超时/连接中断/DNS），4xx/超限/格式问题不重试。

/** 后台下载的最大并发（个人中枢够用；不打疼对方 CDN）。 */
/** 信源的「占位 → 字节」实现（D-128）：只有非公开 URL 的占位才会用到它。 */
export type MediaFetcher = (
  placeholder: string,
) => Promise<{ bytes: Uint8Array; contentType: string | null } | null>;

const MAX_CONCURRENT = 2;

/** 单张图的尝试次数（**1 次重试**）：只对瞬态错误重试（超时/连接中断/DNS），4xx、超限、格式不符不重试。 */
const MAX_ATTEMPTS = 2;

/** 重试退避基数（毫秒）：失败后等 300ms 再试一次。 */
const RETRY_BACKOFF_MS = 300;

/** 进站后缓存本批的图片（返回 Promise，**不阻塞进站回执**——调用方自己决定等不等）。
 *  内部已兜底：任何失败都只留痕，不会 reject。 */
export function cacheIngestImages(
  db: Db,
  mediaDir: string,
  rawInputId: string,
  looksUpMedia?: MediaFetcher,
): Promise<void> {
  return run(db, mediaDir, rawInputId, looksUpMedia).catch((err: unknown) => {
    process.stderr.write(
      `[media] 进站图片缓存异常（不影响进站，raw=${rawInputId}）：${errText(err)}\n`,
    );
  });
}

/** 按信源名查「媒体占位取字节」实现（D-130）。
 *
 *  为什么是**查询函数**而不是一个现成的 fetcher：`kickDigest` 是消化的唯一发射口，
 *  它手上只有批次行（`raw.source`）——把 fetcher 当参数由各调用方自己传，曾导致
 *  重试、启动重试、对话三条路都没传（微信图片批重试时永远缓存不到图，且**连流水都不写**）。
 *  改成「给它一个能按 source 查的函数」，调用方只需把一个查表口传到底。 */
export type MediaFetcherLookup = (source: string) => MediaFetcher | undefined;

/** 缓存一批图片（真实执行体；cacheIngestImages 只包一层兜底）。 */
async function run(
  db: Db,
  mediaDir: string,
  rawInputId: string,
  looksUpMedia?: MediaFetcher,
): Promise<void> {
  const raw = repo.getRawInput(db, rawInputId);
  if (raw === null) return; // 批次不在了（并发清理）——没什么可做
  // 公开 URL 走通用下载器；**非 http(s) 的占位**（如企业微信的 `wecom-media:<id>`）
  // 要按批次的 source 找它登记的取字节实现（D-128）——那可能来自信源自己，也可能来自
  // 部署级的 Router（企业微信就是后者：凭据在 Router，信源不接触 token，D-130）。
  const allUrls = extractImageUrls(raw.content);
  const urls = allUrls.filter((u) => u.startsWith("http") || looksUpMedia !== undefined);
  // 非 http(s) 占位但没有取字节实现：**如实说出来**，不要让它静默消失。
  // 用户看到的是「这批图一直没缓存、也没有任何解释」——那正是「不静默」要防的形态（01§4.7）。
  const uncacheable = allUrls.filter((u) => !u.startsWith("http") && looksUpMedia === undefined);
  if (uncacheable.length > 0) {
    appendCacheEvent(
      db,
      rawInputId,
      "media_cache",
      `${uncacheable.length} 张图片无法缓存（信源 ${raw.source} 未提供取图方式），正文占位保留原样`,
    );
  }
  if (urls.length === 0) return;

  let cached = 0;
  let skipped = 0;
  let failed = 0;
  // 流水可见（用户要求）：缓存是进站流程的一段，开始/结束都写一条——状态卡与时间线都看得到
  appendCacheEvent(db, rawInputId, "media_cache", `开始缓存本批图片（${urls.length} 张）…`);
  try {
    // 简易并发：最多 MAX_CONCURRENT 个在飞，队列里逐个往外递
    const queue = [...urls];
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const outcome = await cacheOne(db, mediaDir, next, looksUpMedia);
        if (outcome === "cached") cached += 1;
        else if (outcome === "skipped") skipped += 1;
        else failed += 1;
      }
    });
    await Promise.all(workers);
  } finally {
    // 结束事件一定写（异常中断也留下部分计数）——否则时间线会永远停在「缓存中」
    appendCacheEvent(
      db,
      rawInputId,
      failed > 0 ? "media_cache_failed" : "media_cache_done",
      failed > 0
        ? `图片缓存：缓存 ${cached} / 已有 ${skipped} / 失败 ${failed}（失败的图会回退为原链接）`
        : `图片缓存完成：缓存 ${cached} / 已有 ${skipped}`,
    );
  }

  // 一次汇总留痕（不静默：抓失败要看得见）
  if (cached + skipped + failed > 0) {
    process.stderr.write(
      `[media] 进站图片缓存（raw=${rawInputId}）：缓存 ${cached} / 已有 ${skipped} / 失败 ${failed}\n`,
    );
  }
}

/** 写一条缓存流水（尽力而为：写失败只记 stderr——流水是可见性，不是缓存的前置条件）。 */
function appendCacheEvent(db: Db, rawInputId: string, action: string, detail: string): void {
  try {
    repo.appendPipelineEvent(db, {
      rawInputId,
      action,
      detail,
      by: { actor: "系统", model: null },
    });
  } catch (err) {
    process.stderr.write(`[media] 缓存流水写失败（${action}，尽力而为）：${errText(err)}\n`);
  }
}

/** 缓存一张：已在库 → 跳过；否则下载（瞬态错误重试）→ 存储。返回三态之一（调用方计数）。 */
async function cacheOne(
  db: Db,
  mediaDir: string,
  url: string,
  looksUpMedia?: MediaFetcher,
): Promise<"cached" | "skipped" | "failed"> {
  if (repo.getMediaByOriginUrl(db, url) !== null) return "skipped";

  // 非公开 URL 的占位：交给信源自己的取字节实现（重试语义由它定——私有凭据下的失败
  // 多半是配置问题，原地重试没意义；这里只试一次并留痕）
  if (!url.startsWith("http")) {
    if (looksUpMedia === undefined) {
      process.stderr.write(`[media] 占位不是公开 URL，且该信源未提供取字节实现，跳过：${url}
`);
      return "failed";
    }
    const got = await looksUpMedia(url);
    if (got === null) return "failed";
    try {
      // 把信源声明的 content-type 一并交下去：公开 URL 那条路有「声明 vs 魔数」交叉校验，
      // 私有媒体这条路原先把它丢了——等于少一道闸（声明是 image/png 而字节不是，就该入库失败）。
      await storeImageBytes(db, mediaDir, Buffer.from(got.bytes), {
        originUrl: url,
        ...(got.contentType === null ? {} : { declaredMime: got.contentType }),
      });
      return "cached";
    } catch (err) {
      process.stderr.write(`[media] 信源取回的字节不合格，未入库（${url}）：${errText(err)}
`);
      return "failed";
    }
  }

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
