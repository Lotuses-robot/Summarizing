// 原文/引文里的图片占位解析（009）：`[图片](url)` 是信源与上传共用的占位写法。
// 纯字符串逻辑——执行器（引用判定）、进站缓存、前端渲染共用同一套判据。

/** 全文里的图片占位 URL（去重、保序）。url 到第一个 `)` 或空白为止（与 nc 生成端一致）。 */
export function extractImageUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\[图片\]\(([^)\s]+)\)/g;
  for (const m of text.matchAll(re)) {
    const url = m[1];
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** 本地媒体占位 → sha256 id；不是本地媒体占位返回 null。
 *  兼容带本站域名的绝对路径（用户可能复制完整 URL 进来）。 */
export function mediaIdFromUrl(url: string): string | null {
  const m = /^(?:https?:\/\/[^/]+)?\/api\/media\/([A-Za-z0-9]+)$/.exec(url);
  return m?.[1] ?? null;
}

/** 原文里是否出现某张图片的占位（引用判定用；本地图按 id、信源图按原 URL）。 */
export function textCitesMedia(
  text: string,
  opts: { mediaId: string; originUrl: string | null },
): boolean {
  for (const url of extractImageUrls(text)) {
    if (mediaIdFromUrl(url) === opts.mediaId) return true;
    if (opts.originUrl !== null && url === opts.originUrl) return true;
  }
  return false;
}
