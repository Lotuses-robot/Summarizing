import { BlockList, isIP } from "node:net";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { errText } from "@summarizing/shared";

// 多模态取图执行层（2026-10-13）：agent0 遇到正文里的 `[图片](url)` 占位时，用它取回图片实际查看。
// 只读、无凭据、无用户上下文（Q27b 同款安全设计）——防 SSRF 五道闸：
// ① 协议只许 http/https、端口只许 80/443；② 主机名**禁 IP 字面量**（含带方括号的 IPv6），
//    云元数据 169.254.169.254 / 100.100.100.200 都在后一道黑名单内；
// ③ 域名解析出的**每个 IP** 都过 BlockList（私网/回环/链路本地/保留段/多播/文档段）；
// ④ **连接钉死在 ③ 已核验的 IP 上**（自定义 lookup，不再让传输层二次解析域名）——
//    堵住「校验用一个解析结果、连接用另一个结果」的 DNS 重绑定 TOCTOU（2026-10-14 审查修复）；
// ⑤ **不跟随跳转**（node 原生不跟随）——302 到内网/任意域一律拒，绕不开前四道闸。
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
 *  169.254.0.0/16 覆盖 169.254.169.254（AWS/腾讯云元数据）；
 *  100.64.0.0/10 覆盖 100.100.100.200（阿里云元数据）。
 *  脏形态一次修全（审查 2026-10-14）：一条 add 对应一个保留段，新增段追加到末尾并配注释。 */
const PRIVATE_NETS = new BlockList();
PRIVATE_NETS.addSubnet("0.0.0.0", 8, "ipv4"); // 本网络/保留
PRIVATE_NETS.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_NETS.addSubnet("100.64.0.0", 10, "ipv4"); // 运营商级 NAT（含阿里云元数据）
PRIVATE_NETS.addSubnet("127.0.0.0", 8, "ipv4"); // 回环
PRIVATE_NETS.addSubnet("169.254.0.0", 16, "ipv4"); // 链路本地 + 云元数据
PRIVATE_NETS.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_NETS.addSubnet("192.0.0.0", 24, "ipv4"); // IETF 协议分配
PRIVATE_NETS.addSubnet("192.0.2.0", 24, "ipv4"); // TEST-NET-1（文档）
PRIVATE_NETS.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_NETS.addSubnet("198.18.0.0", 15, "ipv4"); // 基准测试保留
PRIVATE_NETS.addSubnet("198.51.100.0", 24, "ipv4"); // TEST-NET-2（文档）
PRIVATE_NETS.addSubnet("203.0.113.0", 24, "ipv4"); // TEST-NET-3（文档）
PRIVATE_NETS.addSubnet("224.0.0.0", 4, "ipv4"); // 多播
PRIVATE_NETS.addSubnet("240.0.0.0", 4, "ipv4"); // 保留（含 255.255.255.255）
PRIVATE_NETS.addAddress("::", "ipv6"); // 未指定地址
PRIVATE_NETS.addAddress("::1", "ipv6"); // 回环
PRIVATE_NETS.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64 知名前缀
PRIVATE_NETS.addSubnet("2001:db8::", 32, "ipv6"); // 文档
PRIVATE_NETS.addSubnet("fc00::", 7, "ipv6"); // 唯一本地地址
PRIVATE_NETS.addSubnet("fe80::", 10, "ipv6"); // 链路本地
PRIVATE_NETS.addSubnet("ff00::", 8, "ipv6"); // 多播

/** 取图结果：成功给 data URL；失败给一句人话原因（都回喂给模型，不抛——失败不许中断消化）。 */
export type FetchImageResult = { ok: true; dataUrl: string } | { ok: false; reason: string };

/** 已核验目标 → 单次 GET（不跟随跳转，读了体才返回）。生产实现把连接钉在已核验 IP 上；
 *  测试注入替身即可免网络断言各分支（签名带 ips/signal 供真实实现使用）。 */
export type ImageTransport = (
  url: URL,
  ips: { address: string; family: number }[],
  signal: AbortSignal,
) => Promise<{ status: number; contentType: string; bytes: Uint8Array }>;

/** 校验并解析图片 URL —— 任何一条不过直接抛人话错（由 fetchImage 捕获转成 ok:false）。
 *  分两步：静态检查（协议/端口/主机形状）→ 动态检查（DNS 解析逐址过私网黑名单）。
 *  返回的 ips 会由传输层钉进连接（校验与连接用同一批地址，防 TOCTOU）。 */
async function assertSafeImageUrl(
  rawUrl: string,
): Promise<{ url: URL; ips: { address: string; family: number }[] }> {
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
  // IPv6 字面量在 URL.hostname 里带方括号（如 "[::1]"），先剥再判——否则 isIP 全放行
  // （审查 2026-10-14：带括号字面量曾绕过此闸）
  const host =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  // 主机名若是 IP 字面量一律拒——既挡直连内网，也堵 DNS 重绑定（域名形态才做解析校验）
  if (isIP(host) !== 0) {
    throw new Error("不允许直接使用 IP 地址");
  }
  // 域名解析：每个 A/AAAA 记录都必须落在公网（防域名解析到内网）
  const addrs = await dns.lookup(host, { all: true });
  if (addrs.length === 0) throw new Error("域名解析不到地址");
  for (const a of addrs) {
    const family = a.family === 6 ? "ipv6" : "ipv4";
    if (PRIVATE_NETS.check(a.address, family)) {
      throw new Error("目标地址落在内网/保留段，拒绝访问");
    }
  }
  return { url, ips: addrs.map((a) => ({ address: a.address, family: a.family })) };
}

/** 生产传输：node http/https 单次 GET，连接钉死已核验 IP（lookup 不再解析域名），
 *  边读边计数封顶 IMAGE_MAX_BYTES；超时/中断经 signal 抛出，由 fetchImage 归一成人话。 */
const pinnedNetworkGet: ImageTransport = (url, ips, signal) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        headers: { accept: "image/*" },
        signal,
        // ⑤ 连接只用已核验的 IP——域名不再交给传输层二次解析（防 DNS 重绑定 TOCTOU）
        lookup: (_hostname, opts, cb) => {
          if (opts.all === true) {
            cb(
              null,
              ips.map((i) => ({ address: i.address, family: i.family })),
            );
          } else {
            const first = ips[0];
            if (first === undefined) {
              cb(new Error("没有已核验的地址"), "", 0);
              return;
            }
            cb(null, first.address, first.family);
          }
        },
      },
      (res: http.IncomingMessage) => {
        const status = res.statusCode ?? 0;
        // content-type 直取（@types/node 对 IncomingHttpHeaders["content-type"] 的声明就是 string，无数组形态）
        const contentType = res.headers["content-type"] ?? "";
        // 3xx / 非 2xx：不读体（跳转响应体无意义），直接归还好让上层判
        if (status < 200 || status >= 300) {
          res.resume();
          resolve({ status, contentType, bytes: new Uint8Array(0) });
          return;
        }
        const clHeader = res.headers["content-length"];
        if (clHeader !== undefined && Number(clHeader) > IMAGE_MAX_BYTES) {
          req.destroy();
          reject(new Error("图片超过大小上限"));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > IMAGE_MAX_BYTES) {
            reject(new Error("图片超过大小上限"));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, contentType, bytes: Buffer.concat(chunks) }));
        res.on("error", (err) => reject(err));
        res.on("aborted", () => reject(new Error("连接中断")));
      },
    );
    req.on("error", (err) => reject(err));
    req.end();
  });

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
export async function fetchImage(
  rawUrl: string,
  transport: ImageTransport = pinnedNetworkGet,
): Promise<FetchImageResult> {
  try {
    const { url, ips } = await assertSafeImageUrl(rawUrl);
    const { status, contentType, bytes } = await transport(
      url,
      ips,
      AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    );
    if (status >= 300 && status < 400) {
      return { ok: false, reason: "链接发生跳转，拒绝跟随（安全策略）" };
    }
    if (status < 200 || status >= 300) {
      return { ok: false, reason: `取图失败：HTTP ${status}` };
    }
    const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ALLOWED_MIME.has(mime)) {
      return { ok: false, reason: `不是图片格式（content-type=${mime || "未知"}）` };
    }
    if (!matchesMagic(mime, bytes)) {
      return { ok: false, reason: "文件内容与声明的图片格式不符，拒绝" };
    }
    const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
    return { ok: true, dataUrl };
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
}
