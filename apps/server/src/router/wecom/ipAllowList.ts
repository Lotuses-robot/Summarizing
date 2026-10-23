import { isIP } from "node:net";

// 回调来源白名单（D-132）：只收企业微信服务器发来的回调。
//
// 为什么是 IP 而不是域名：我们是**接收方**，连接进来时只有来源 IP，没有对方的域名
// ——「仅限微信域名」在 HTTP 层做不到。
//
// 为什么用官方接口而不是自己搜一段 IP 写死：官方提供了 `getcallbackip`，且明确说明
// 「IP 段有变更可能，变更时新旧同时保留一段时间，建议每天定时拉取」——写死的清单会在
// 某次变更后**静默失效**（回调全被挡，且看起来像「企业微信没推消息」）。
//
// 为什么白名单为空时**放行**而不是全挡：白名单靠外部接口填充，接口挂了/还没拉到时
// 全挡会让线上直接断流；而验签（msg_signature + AES + receiveId）本来就是主防线——
// 这道白名单是**减少无效计算**的第二道闸，不是唯一防线。所以「白名单未就绪」按
// 「尚未开启」处理并留痕，不改变可用性。

/** CIDR 或单个 IP。 */
interface Cidr {
  /** 规范化后的网络地址（v4 为 4 字节，v6 为 16 字节）。 */
  bytes: Uint8Array;
  /** 前缀长度（单 IP 即满长）。 */
  prefix: number;
}

/** IPv4 点分十进制 → 4 字节；非法返回 null。 */
function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out[i] = n;
  }
  return out;
}

/** 展开 IPv6 简写（`::`）→ 16 字节；非法返回 null。
 *
 *  只处理官方清单里会出现的常规写法（含 `::` 简写与末尾内嵌 IPv4）。 */
function parseIpv6(text: string): Uint8Array | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  /** 把没有 `::` 的一侧拆成 16 位分组（允许末尾内嵌 IPv4）。 */
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const items = part.split(":");
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i] ?? "";
      if (item === "") return null;
      if (i === items.length - 1 && item.includes(".")) {
        const v4 = parseIpv4(item);
        if (v4 === null) return null;
        out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(item)) return null;
      out.push(parseInt(item, 16));
    }
    return out;
  };
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : null;
  if (head === null || (halves.length === 2 && tail === null)) return null;
  const tailGroups = tail ?? [];
  const fill = 8 - head.length - tailGroups.length;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else if (fill < 0) {
    return null;
  }
  const all = [
    ...head,
    ...Array.from({ length: halves.length === 1 ? 0 : fill }, () => 0),
    ...tailGroups,
  ];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const g = all[i] ?? 0;
    out[i * 2] = (g >> 8) & 0xff;
    out[i * 2 + 1] = g & 0xff;
  }
  return out;
}

/** 解析一条 IP 或 CIDR 为可比较的字节串；非法返回 null（调用方丢弃并留痕）。 */
function parseCidr(text: string): Cidr | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const slash = trimmed.indexOf("/");
  const addr = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const family = isIP(addr);
  if (family === 0) return null;
  const bytes = family === 4 ? parseIpv4(addr) : parseIpv6(addr);
  if (bytes === null) return null;
  const maxPrefix = family === 4 ? 32 : 128;
  if (slash === -1) return { bytes, prefix: maxPrefix };
  const prefixText = trimmed.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix < 0 || prefix > maxPrefix) return null;
  return { bytes, prefix };
}

/** 两个同长度地址在给定前缀下是否同网段。 */
function samePrefix(a: Uint8Array, b: Uint8Array, prefix: number): boolean {
  if (a.length !== b.length) return false;
  const fullBytes = Math.floor(prefix / 8);
  for (let i = 0; i < fullBytes; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  const restBits = prefix % 8;
  if (restBits === 0) return true;
  const mask = (0xff << (8 - restBits)) & 0xff;
  return ((a[fullBytes] ?? 0) & mask) === ((b[fullBytes] ?? 0) & mask);
}

/** 来源 IP 是否落在给定清单内。 */
export class IpAllowList {
  /** 已解析的网段（非法条目在构造时就被丢掉）。 */
  private readonly ranges: Cidr[];

  /** 造一个白名单。
   *
   *  @param entries IP 或 CIDR 字符串（官方 `getcallbackip` 的 `ip_list` 原样传入）
   *  `onInvalid` = 坏条目的留痕口（不静默吞）
   */
  constructor(entries: readonly string[], onInvalid: (entry: string) => void = () => undefined) {
    this.ranges = [];
    for (const entry of entries) {
      const parsed = parseCidr(entry);
      if (parsed === null) onInvalid(entry);
      else this.ranges.push(parsed);
    }
  }

  /** 清单是否为空（空 = 尚未就绪，调用方应放行并留痕）。 */
  get isEmpty(): boolean {
    return this.ranges.length === 0;
  }

  /** 这个来源 IP 是否在白名单内。
   *
   *  @param ip 来源地址（可能带 IPv6 前缀的 `::ffff:` 形态——由 parseIpv4/6 自行判断）
   */
  contains(ip: string): boolean {
    // `::ffff:1.2.3.4`（IPv4 映射地址）按 IPv4 比：Caddy/Nginx 反代后常见这种形态
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    const candidate = parseCidr(mapped?.[1] ?? ip);
    if (candidate === null) return false;
    return this.ranges.some(
      (r) =>
        r.bytes.length === candidate.bytes.length && samePrefix(r.bytes, candidate.bytes, r.prefix),
    );
  }
}
