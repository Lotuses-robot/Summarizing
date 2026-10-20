// 图片字节校验单一出处（009）：上传、信源缓存、agent0 取图三条路共用。
// 只认白名单 MIME + 魔数一致——防「content-type 谎报 image 却是别的字节」。

/** 允许的图片 MIME（前缀 image/ 再收窄到真实可渲染、且 sharp 能处理的类型）。
 *  **不收 SVG**（可携带脚本，放大 XSS 面；也不便压缩）。 */
export const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
]);

/** MIME → 该类型文件头应匹配的判据（缺字节时不匹配——Uint8Array 越界读为 undefined）。 */
export function matchesMagic(mime: string, b: Uint8Array): boolean {
  /** 头几字节逐一比对。 */
  const at = (...bytes: number[]): boolean => bytes.every((x, i) => b[i] === x);
  switch (mime) {
    case "image/jpeg":
      return at(0xff, 0xd8, 0xff);
    case "image/png":
      return at(0x89, 0x50, 0x4e, 0x47);
    case "image/gif":
      return at(0x47, 0x49, 0x46, 0x38); // GIF8
    case "image/bmp":
      return at(0x42, 0x4d); // BM
    case "image/webp":
      // RIFF....WEBP
      return at(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45;
    case "image/tiff":
      return at(0x49, 0x49, 0x2a) || at(0x4d, 0x4d, 0x00);
    default:
      return false;
  }
}

/** 从魔数猜 MIME（客户端给 application/octet-stream 时兜底）。猜不出返回 null。 */
export function sniffImageMime(b: Uint8Array): string | null {
  for (const mime of ALLOWED_IMAGE_MIME) {
    if (matchesMagic(mime, b)) return mime;
  }
  return null;
}

/** MIME → 存储扩展名（文件名由 sha256 决定，扩展名只为人眼可读）。 */
export function mediaExt(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    default:
      return "bin";
  }
}
