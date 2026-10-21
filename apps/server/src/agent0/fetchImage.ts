import { errText } from "@summarizing/shared";
import { ALLOWED_IMAGE_MIME, matchesMagic } from "../shared/imageBytes";
import { downloadImageBytes } from "../shared/imageDownloader";

// 多模态取图执行层（2026-10-13 立；2026-10-21 瘦身）：agent0 遇到正文里的 `[图片](url)` 占位时，
// 用它取回图片实际查看。
// 下载与五道 SSRF 闸已**上移 shared/imageDownloader.ts**——进站缓存（009）与这里共用同一套
// 拦截标准（两条路各写一份 = 安全洞）。本文件只做 agent0 特有的事：
//   ① 2 MiB 读取闸（图要进模型上下文，base64 后体积再涨——上传允许 20 MiB 不代表模型吃得下）；
//   ② content-type image/* + 魔数一致（防伪装成图片的任意字节直灌 LLM）；
//   ③ 编码成 data URL 交回调用方（digest.ts 注入模型消息）。
// 本函数**自己不做任何存储**——它只负责「把一张网上的图变成模型能看的东西」；
// 顺手持久化（009 FR-008）由调用方 tools.ts 决定，好让本文件保持无状态、可单测。

/** 取图上限（2 MiB）：单图 base64 后约 2.7 MiB 文本，够一般群消息配图；超限中止读取。 */
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** 取图结果：成功给 data URL 与原字节（调用方据此决定是否持久化）；失败给一句人话原因
 *  （都回喂给模型，不抛——失败不许中断消化）。 */
export type FetchImageResult =
  { ok: true; dataUrl: string; bytes: Uint8Array; mime: string } | { ok: false; reason: string };

/** 取一张图的字节（供测试替身注入；生产走 shared/imageDownloader 的完整版）。
 *  窄签名：只收回字节与 content-type——SSRF 五道闸在 shared 侧，替身不涉网。 */
export type ImageBytes = { bytes: Uint8Array; contentType: string };

/** 取回一张图片并编码为 data URL（多模态工具 fetch_image 的执行体）。
 *  任何失败都归一成 { ok:false, reason }——回喂给模型（它可继续纯文本消化），绝不抛出中断消化。 */
export async function fetchImage(
  rawUrl: string,
  download: (url: string) => Promise<ImageBytes> = downloadImageBytes,
): Promise<FetchImageResult> {
  try {
    const got = await download(rawUrl);
    if (got.bytes.length > IMAGE_MAX_BYTES) {
      return { ok: false, reason: "图片超过大小上限（2 MiB）" };
    }
    const mime = got.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ALLOWED_IMAGE_MIME.has(mime)) {
      return { ok: false, reason: `不是图片格式（content-type=${mime || "未知"}）` };
    }
    if (!matchesMagic(mime, got.bytes)) {
      return { ok: false, reason: "文件内容与声明的图片格式不符，拒绝" };
    }
    const buf = Buffer.isBuffer(got.bytes) ? got.bytes : Buffer.from(got.bytes);
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString("base64")}`, bytes: buf, mime };
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
}
