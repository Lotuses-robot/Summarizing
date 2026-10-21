// 原文/引文里的图片占位解析（009）：`[图片](url)` 是信源与上传共用的占位写法。
// 纯字符串逻辑，前后端共用同一套判据——放 shared 是为了「改占位格式只改一处」
// （服务端：进站缓存/引用判定落盘；web：详情/引文/原文弹层渲染）。
// 前端从 @summarizing/shared 引；服务端同。

/** 全文里的图片占位 URL（去重、保序）。url 到第一个 `)` 或空白为止——与 nc 生成端一致。
 *  含空格/缺右括号的**畸形写法整条跳过**（截一半既打不开也可能误命中本地媒体）。 */
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
 *  兼容带本站域名的绝对路径（用户可能复制完整 URL 进来）。
 *  ⚠️ 容忍 URL 带图片扩展名（`/api/media/<sha256>.jpg`）：从地址栏复制时常见，
 *    服务端路由本身不收扩展名，但判「是不是本地媒体」不该因此误判成外链。 */
export function mediaIdFromUrl(url: string): string | null {
  const m = /^(?:https?:\/\/[^/]+)?\/api\/media\/([A-Za-z0-9]+)(?:\.[A-Za-z0-9]+)?$/.exec(url);
  return m?.[1] ?? null;
}
