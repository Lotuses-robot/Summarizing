import { BlockList, isIP } from "node:net";
import dns from "node:dns/promises";
import { errText } from "@summarizing/shared";

// 多模态取图执行层（2026-10-13）：agent0 遇到正文里的 `[图片](url)` 占位时，用它取回图片实际查看。
// 只读、无凭据、无用户上下文（Q27b 同款安全设计）——防 SSRF 的四道闸在 isFetchableImageUrl：
// ① 协议只许 http/https、端口只许 80/443；② 主机名**禁 IP 字面量**（含云元数据 169.254.169.254）；
// ③ 域名解析出的**每个 IP** 都过 BlockList（私网/回环/链路本地/保留段）——防 DNS 重绑定到内网；
// ④ **不跟随跳转**（redirect:"manual"）——302 到内网/任意域一律拒，绕不开前三道闸。
// 响应体：content-type 必须 image/*，且 magic bytes 与声明一致（防伪装成图片的任意字节直灌 LLM）。
// 结果以 data URL 交回调用方（digest.ts 注入模型消息）——**不落盘、不进库、不进流水**（正文只留占位）。

/** 取图上限（2 MiB）：单图 base64 后约 2.7 MiB 文本，够一般群消息配图；超限中止读取。 */
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** 取图超时（15s）：图片 CDN 通常很快，超时即判失败（降级为纯文本，不阻塞消化）。 */
const IMAGE_TIMEOUT_MS = 15_000;

/** 允许的图片 MIME（前缀 image/ 再收窄到真实可渲染的类型）。 */
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
]);

/** 私网/回环/链路本地/保留网段黑名单（防 SSRF 打到内网服务或云元数据接口）。
 *  169.254.0.0/16 覆盖阿里云/腾讯云等元数据端点 169.254.169.254。 */
const PRIVATE_NETS = new BlockList();
PRIVATE_NETS.addSubnet("0.0.0.0", 8, "ipv4"); // 本机/保留
PRIVATE_NETS.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_NETS.addSubnet("100.64.0.0", 10, "ipv4"); // 运营商级 NAT
PRIVATE_NETS.addSubnet("127.0.0.0", 8, "ipv4"); // 回环
PRIVATE_NETS.addSubnet("169.254.0.0", 16, "ipv4"); // 链路本地 + 云元数据
PRIVATE_NETS.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_NETS.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_NETS.addSubnet("198.18.0.0", 15, "ipv4"); // 基准测试保留
PRIVATE_NETS.addAddress("::1", "ipv6"); // 回环
PRIVATE_NETS.addSubnet("fc00::", 7, "ipv6"); // 唯一本地地址
PRIVATE_NETS.addSubnet("fe80::", 10, "ipv6"); // 链路本地

/** 取图结果：成功给 data URL；失败给一句人话原因（都回喂给模型，不抛——失败不许中断消化）。 */
export type FetchImageResult = { ok: true; dataUrl: string } | { ok: false; reason: string };

/** 校验并解析图片 URL —— 任何一条不过直接抛人话错（由 fetchImage 捕获转成 ok:false）。
 *  分两步：静态检查（协议/端口/主机形状）→ 动态检查（DNS 解析逐址过私网黑名单）。 */
async function assertSafeImageUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("不是合法的 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("只允许 http/https 链接");
  }
  // 只放行标准端口：非标端口常指向内网服务/管理台（SSRF 常见目标）
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    throw new Error("只允许 80/443 端口");
  }
  const host = url.hostname;
  // 主机名若是 IP 字面量一律拒——既挡直连内网，也堵 DNS 重绑定（域名形态才做解析校验）
  if (isIP(host) !== 0) {
    throw new Error("不允许直接使用 IP 地址");
  }
  // 域名解析：每个 A/AAAA 记录都必须落在公网（防域名解析到内网 = DNS 重绑定）
  const addrs = await dns.lookup(host, { all: true });
  if (addrs.length === 0) throw new Error("域名解析不到地址");
  for (const a of addrs) {
    const family = a.family === 6 ? "ipv6" : "ipv4";
    if (PRIVATE_NETS.check(a.address, family)) {
      throw new Error("目标地址落在内网/保留段，拒绝访问");
    }
  }
  return url;
}

/** 读响应体但不超过 maxBytes：边读边累计，超限即中止（不把超大响应读进内存）。 */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const cl = res.headers.get("content-length");
  if (cl !== null && Number(cl) > maxBytes) throw new Error("图片超过大小上限");
  const body: ReadableStream<Uint8Array> | null = res.body;
  const reader = body?.getReader();
  if (reader === undefined) throw new Error("响应无内容");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step: { done: boolean; value?: Uint8Array } = await reader.read();
    if (step.done) break;
    const chunk = step.value;
    if (chunk === undefined) break;
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("图片超过大小上限");
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** MIME → 该类型文件头应匹配的判据（防「content-type 谎报 image 却是别的字节」）。 */
function matchesMagic(mime: string, b: Uint8Array): boolean {
  /** 头几字节逐一比对（缺字节时不匹配——Uint8Array 越界读为 undefined）。 */
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

/** 取回一张图片并编码为 data URL（多模态工具 fetch_image 的执行体）。
 *  任何失败都归一成 { ok:false, reason }——回喂给模型（它可继续纯文本消化），绝不抛出中断消化。 */
export async function fetchImage(rawUrl: string): Promise<FetchImageResult> {
  try {
    const url = await assertSafeImageUrl(rawUrl);
    // 不跟随跳转：302 可能是 SSRF 绕过（跳内网/跳任意域），一律拒
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      headers: { accept: "image/*" },
    });
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, reason: "链接发生跳转，拒绝跟随（安全策略）" };
    }
    if (!res.ok) {
      return { ok: false, reason: `取图失败：HTTP ${res.status}` };
    }
    const mime = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ALLOWED_MIME.has(mime)) {
      return { ok: false, reason: `不是图片格式（content-type=${mime || "未知"}）` };
    }
    const bytes = await readCapped(res, IMAGE_MAX_BYTES);
    if (!matchesMagic(mime, bytes)) {
      return { ok: false, reason: "文件内容与声明的图片格式不符，拒绝" };
    }
    const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
    return { ok: true, dataUrl };
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
}
