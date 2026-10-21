import { useState } from "react";
import { mediaIdFromUrl, type MediaMap, type MediaRef } from "@summarizing/shared";

// 原文里的图片占位渲染（009）：`[图片](url)` → 出图；未命中按来源回退——
// 本地占位（/api/media/<id>）= 已过期 →「图片已过期」；外部 URL（QQ 图）= 原链接。
// 点图在新标签打开原图（v1 不做站内灯箱）。**不静默**：过期/失效必须看得见。
// ⚠️ 切分用**本地正则**，不复用 shared 的 extractImageUrls——那份为服务端判定服务、刻意去重
//    （同一张图算一次），而渲染要求「每一处占位都出图」。判据本身（`[图片](url)`）两边一致。
// ⚠️ 出图一律走 `/api/media/<id>`（缓存副本），**绝不**拿占位里的原链接当 src——原链接会过期，
//    用它等于把缓存白存（spec 009 US2：断开原 URL 后仍能显示）。

/** 拆分后的片段：文本段 or 图片占位。 */
type Segment = { kind: "text"; text: string } | { kind: "image"; url: string };

/** 占位正则（与 shared 的 extractImageUrls 同一判据：url 到 `)` 或空白为止）。 */
const PLACEHOLDER_RE = /\[图片\]\(([^)\s]+)\)/g;

/** 渲染一段文本里的图片占位；无占位原样返回。
 *  mediaMap = 详情接口随带的映射（原文占位 URL → 本地媒体）。
 *  - **传了 map**（详情/引文/原文弹层）：表里没有这一项 = 未命中（过期/未缓存）→ 按来源回退；
 *  - **不传 map**（对话气泡）：本地占位直接出图——登录态下浏览器自带 cookie 请求。 */
export function MediaText({
  text,
  mediaMap,
  className,
}: {
  text: string;
  mediaMap?: MediaMap;
  className?: string;
}) {
  const segments = splitByPlaceholders(text);
  // 一段且是文本 = 没有占位，原样输出（省掉无谓的 span 嵌套）
  if (segments.length === 1 && segments[0]?.kind === "text") {
    return <span className={className}>{text}</span>;
  }
  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <MediaImage
            key={i}
            url={seg.url}
            media={mediaMap?.[mediaKey(seg.url)]}
            hasMap={mediaMap !== undefined}
          />
        ),
      )}
    </span>
  );
}

/** 映射查找键：服务端的 map 对本地媒体一律用规范形态 `/api/media/<id>` 作键，
 *  而原文里可能是 `…/api/media/<id>.jpg` 或带域名的绝对形式——查找前归一，否则活图被判「已过期」。 */
function mediaKey(url: string): string {
  const id = mediaIdFromUrl(url);
  return id === null ? url : `/api/media/${id}`;
}

/** 按占位出现的位置切开文本（保序）：文本段与图片段交替。每一处占位都渲染。 */
function splitByPlaceholders(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const at = m.index ?? 0;
    const url = m[1];
    if (url === undefined) continue; // 正则保证有组，这里只做收窄
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    out.push({ kind: "image", url });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out.length === 0 ? [{ kind: "text", text }] : out;
}

/** 一枚图片（或它的回退形态）。
 *  三种情况：① 出图（命中详情映射 → 读本地副本；对话气泡不传 map，本地占位直接出图）；
 *  ② 详情页传了 map 但这一项不在里面 = 未命中（过期/未缓存）→ 按来源回退；
 *  ③ 出图失败（onError）：本地占位 →「图片已过期」；外部 URL → 原链接。 */
function MediaImage({ url, media, hasMap }: { url: string; media?: MediaRef; hasMap: boolean }) {
  const [broken, setBroken] = useState(false);
  const localId = mediaIdFromUrl(url);

  // 未命中或已崩：本地占位 = 过期/未缓存（不静默）；外部 URL = 回退原链接
  if ((hasMap && media === undefined) || broken) {
    return localId !== null ? (
      <span className="text-xs text-ink-muted">［图片已过期］</span>
    ) : (
      <a href={url} target="_blank" rel="noopener noreferrer" className="text-accent">
        ［图片链接］
      </a>
    );
  }
  // 命中缓存 → 读本地副本（`/api/media/<id>`）；原链接只是「这张图从哪来」的出处，可能早已失效
  const src = media !== undefined ? `/api/media/${media.id}` : url;
  return (
    <img
      src={src}
      alt="图片"
      loading="lazy"
      onClick={() => window.open(src, "_blank", "noopener")}
      onError={() => setBroken(true)}
      className="my-1 max-h-64 cursor-zoom-in rounded-md border border-line align-middle"
    />
  );
}
