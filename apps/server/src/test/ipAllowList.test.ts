import { describe, expect, it } from "vitest";
import { IpAllowList } from "../router/wecom/ipAllowList";

// 回调来源白名单（D-132）：只收企业微信服务器发来的回调。
//
// 为什么是 IP：我们是接收方，只有来源 IP，拿不到对方的域名。
// 清单来自官方 `getcallbackip`（文档明说「IP 段会变，建议每天拉」），所以匹配逻辑
// 必须能吃 CIDR，而不是只认单条地址。

describe("IpAllowList：IPv4", () => {
  it("单条 IP 精确命中；不在清单里的不命中", () => {
    const list = new IpAllowList(["1.2.3.4"]);
    expect(list.contains("1.2.3.4")).toBe(true);
    expect(list.contains("1.2.3.5")).toBe(false);
  });

  it("CIDR 命中网段内的地址，网段外不命中", () => {
    const list = new IpAllowList(["10.0.0.0/24"]);
    expect(list.contains("10.0.0.1")).toBe(true);
    expect(list.contains("10.0.0.255")).toBe(true);
    expect(list.contains("10.0.1.1")).toBe(false);
  });

  it("/0 命中一切 IPv4（边界：前缀为 0 时不做逐字节比较）", () => {
    const list = new IpAllowList(["0.0.0.0/0"]);
    expect(list.contains("8.8.8.8")).toBe(true);
    expect(list.contains("255.255.255.255")).toBe(true);
  });

  it("/32 只命中自己", () => {
    const list = new IpAllowList(["1.2.3.4/32"]);
    expect(list.contains("1.2.3.4")).toBe(true);
    expect(list.contains("1.2.3.5")).toBe(false);
  });

  it("非整字节前缀（如 /20）按位比较正确", () => {
    // 10.0.0.0/20 覆盖 10.0.0.0 – 10.0.15.255
    const list = new IpAllowList(["10.0.0.0/20"]);
    expect(list.contains("10.0.15.255")).toBe(true);
    expect(list.contains("10.0.16.0")).toBe(false);
  });
});

describe("IpAllowList：IPv6 与映射地址", () => {
  it("IPv6 单地址命中", () => {
    const list = new IpAllowList(["2001:db8::1"]);
    expect(list.contains("2001:db8::1")).toBe(true);
    expect(list.contains("2001:db8::2")).toBe(false);
  });

  it("IPv6 网段命中", () => {
    const list = new IpAllowList(["2001:db8::/32"]);
    expect(list.contains("2001:db8:1234::9")).toBe(true);
    expect(list.contains("2001:db9::1")).toBe(false);
  });

  it("`::ffff:` 映射地址按 IPv4 比（反代后常见形态）", () => {
    const list = new IpAllowList(["1.2.3.0/24"]);
    expect(list.contains("::ffff:1.2.3.4")).toBe(true);
    expect(list.contains("::ffff:9.9.9.9")).toBe(false);
  });
});

describe("IpAllowList：脏形态", () => {
  it("空清单 → isEmpty（调用方据此放行，不当成「谁都挡」）", () => {
    expect(new IpAllowList([]).isEmpty).toBe(true);
  });

  it("非法条目被丢弃并留痕（不静默吞）", () => {
    const bad: string[] = [];
    const list = new IpAllowList(["1.2.3.4", "不是IP", "1.2.3.4/99", "", "1.2.3"], (e) =>
      bad.push(e),
    );
    expect(bad).toEqual(["不是IP", "1.2.3.4/99", "", "1.2.3"]);
    expect(list.contains("1.2.3.4")).toBe(true); // 好的那条仍然生效
  });

  it("查询值本身非法 → 不命中（不抛）", () => {
    const list = new IpAllowList(["1.2.3.4"]);
    expect(list.contains("")).toBe(false);
    expect(list.contains("not-an-ip")).toBe(false);
  });

  it("IPv4 与 IPv6 网段互不误伤（长度不同不比较）", () => {
    const list = new IpAllowList(["0.0.0.0/0"]);
    expect(list.contains("2001:db8::1")).toBe(false);
  });
});
