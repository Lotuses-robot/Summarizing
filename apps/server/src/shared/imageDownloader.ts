import { BlockList, isIP } from "node:net";
import type { LookupAddress } from "node:dns";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";

// 带 SSRF 五道闸的图片下载器（009 从 agent0/fetchImage.ts 抽出）。
// 两个消费方共用：agent0 的 fetch_image（取回给模型看）、进站缓存（落盘给用户看）。
// 抽出来的理由：两条路必须同一套拦截标准——若进站缓存另写一份宽松版，
// 「agent0 拿不到但服务端存下来」的形状差就成了安全洞（审查视角：下载即攻击面）。
//
// 五道闸：
// ① 协议只许 http/https、端口只许 80/443；
// ② 主机名**禁 IP 字面量**（含带方括号的 IPv6）——域名形态才继续；
// ③ 域名解析出的**每个 IP** 都过 BlockList（私网/回环/链路本地/保留段/多播/文档段）；
// ④ **连接钉死在 ③ 已核验的 IP 上**（自定义 lookup）——堵「校验用一份解析、连接用另一份」的
//    DNS 重绑定 TOCTOU；
// ⑤ **不跟随跳转**（node 原生不跟随）——302 到内网/任意域一律拒。

/** 下载上限：单图硬顶（防磁盘/内存被单张图打爆）。 */
export const IMAGE_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** 下载超时（15s）：图片 CDN 通常很快，超时即判失败。 */
const DOWNLOAD_TIMEOUT_MS = 15_000;

/** 私网/回环/链路本地/保留网段黑名单（防 SSRF 打到内网服务或云元数据接口）。
 *  169.254.0.0/16 覆盖 169.254.169.254（AWS/腾讯云元数据）；
 *  100.64.0.0/10 覆盖 100.100.100.200（阿里云元数据）。
 *  脏形态一次修全：一条 add 对应一个保留段，新增段追加到末尾并配注释。 */
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

/** 已核验目标 → 单次 GET 的结果；bytes 是**读满的响应体**（调用方自行判大小）。 */
type ImageDownload = { status: number; contentType: string; bytes: Uint8Array };

/** 已核验目标 → 单次 GET（不跟随跳转）。生产实现把连接钉在已核验 IP 上；
 *  测试注入替身即可免网络断言各分支。 */
export type ImageTransport = (
  url: URL,
  ips: LookupAddress[],
  signal: AbortSignal,
) => Promise<ImageDownload>;

/** 校验并解析图片 URL——任何一条不过直接抛人话错。
 *  分两步：静态检查（协议/端口/主机形状）→ 动态检查（DNS 解析逐址过私网黑名单）。
 *  返回的 ips 会由传输层钉进连接（校验与连接用同一批地址，防 TOCTOU）。 */
async function assertSafeImageUrl(rawUrl: string): Promise<{ url: URL; ips: LookupAddress[] }> {
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
  const host =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  // 主机名若是 IP 字面量一律拒——既挡直连内网，也堵 DNS 重绑定（域名形态才做解析校验）
  if (isIP(host) !== 0) throw new Error("不允许直接使用 IP 地址");
  // 域名解析：每个 A/AAAA 记录都必须落在公网（防域名解析到内网）
  const addrs = await dns.lookup(host, { all: true });
  if (addrs.length === 0) throw new Error("域名解析不到地址");
  for (const a of addrs) {
    const family = a.family === 6 ? "ipv6" : "ipv4";
    if (PRIVATE_NETS.check(a.address, family)) {
      throw new Error("目标地址落在内网/保留段，拒绝访问");
    }
  }
  return { url, ips: addrs };
}

/** 生产传输：node http/https 单次 GET，连接钉死已核验 IP（lookup 不再解析域名），
 *  边读边计数封顶上限；超时/中断经 signal 抛出。 */
const pinnedNetworkGet: ImageTransport = (url, ips, signal) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        headers: { accept: "image/*" },
        signal,
        // 连接只用已核验的 IP——域名不再交给传输层二次解析（防 DNS 重绑定 TOCTOU）。
        // opts.family 是 Node 传下的家族偏好（0/缺席 = 不限）：先归一成 4/6 再过滤，
        // 滤空回退全集——连接地址恒出自 assertSafeImageUrl 核过的那批。
        // ⚠️ 回调形状跟着 `opts.all` 走：autoSelectFamily（Node 20+ 默认开）要数组，关掉时只要
        //    单个地址。恒回数组在关掉自动选择的配置下会 ERR_INVALID_IP_ADDRESS（实测）。
        lookup: (_hostname, opts, cb) => {
          const wish =
            opts.family === "IPv4" || opts.family === "IPv6"
              ? opts.family === "IPv4"
                ? 4
                : 6
              : opts.family;
          const preferred = ips.filter((a) => a.family === wish);
          const chosen = preferred.length > 0 ? preferred : ips;
          const first = chosen[0];
          if (first === undefined) {
            cb(new Error("域名解析不到地址"), "", 0);
            return;
          }
          if (opts.all === true) {
            cb(
              null,
              chosen.map((a) => ({ address: a.address, family: a.family })),
            );
          } else {
            cb(null, first.address, first.family);
          }
        },
      },
      (res: http.IncomingMessage) => {
        const status = res.statusCode ?? 0;
        // content-type 直取（@types/node 对 IncomingHttpHeaders["content-type"] 的声明就是 string）
        const contentType = res.headers["content-type"] ?? "";
        // 3xx / 非 2xx：不读体（跳转响应体无意义），直接归还让上层判
        if (status < 200 || status >= 300) {
          res.resume();
          resolve({ status, contentType, bytes: new Uint8Array(0) });
          return;
        }
        const clHeader = res.headers["content-length"];
        if (clHeader !== undefined && Number(clHeader) > IMAGE_DOWNLOAD_MAX_BYTES) {
          req.destroy();
          reject(new Error(`图片超过大小上限（${IMAGE_DOWNLOAD_MAX_BYTES / 1024 / 1024} MiB）`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > IMAGE_DOWNLOAD_MAX_BYTES) {
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

/** 经五道闸下载一张图的字节（009：进站缓存与 agent0 取图共用）。
 *  失败一律抛**人话错**（各闸与传输层的措辞）——调用方按自己场景处理（stderr 留痕 /
 *  回喂模型），此处**不吞**：吞掉了调用方就没法「如实留痕」。
 *  ⚠️ 不另设 try/catch 包一层：内部各处抛的已是人话，再包只会丢掉原栈（preserve-caught-error）。 */
export async function downloadImageBytes(
  rawUrl: string,
  transport: ImageTransport = pinnedNetworkGet,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const { url, ips } = await assertSafeImageUrl(rawUrl);
  const got = await transport(url, ips, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS));
  if (got.status < 200 || got.status >= 300) {
    throw new Error(`取图失败：HTTP ${got.status}`);
  }
  return { bytes: got.bytes, contentType: got.contentType };
}
