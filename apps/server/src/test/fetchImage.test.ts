import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchImage, type ImageTransport } from "../agent0/fetchImage";

// 多模态取图执行层（2026-10-13；2026-10-14 审查改 transport 注入）：SSRF 闸门 + MIME/魔数断言。
// DNS 用替身（vi.mock）——全离线；连接钉 IP 的真实网络路径由真机联调覆盖（04 验收）。

/** DNS 替身：默认解析到一个公网地址（例 example.com 旧 A 记录），用例可按需覆盖。 */
const { lookupMock } = vi.hoisted(() => ({
  lookupMock:
    vi.fn<(host: string, opts: { all: true }) => Promise<{ address: string; family: number }[]>>(),
}));
vi.mock("node:dns/promises", () => ({ default: { lookup: lookupMock } }));

/** 假传输：记录每次调用的 url 与已核验 ips，按剧本返回响应（不打网）。 */
function fakeTransport(resp: { status?: number; contentType?: string; bytes?: number[] }) {
  const calls: { url: URL; ips: { address: string; family: number }[] }[] = [];
  /** 替身传输本体：记录入参、按剧本返回响应（不做任何真的网络/校验）。 */
  const transport: ImageTransport = async (url, ips) => {
    calls.push({ url, ips });
    return {
      status: resp.status ?? 200,
      contentType: resp.contentType ?? "",
      bytes: new Uint8Array(resp.bytes ?? []),
    };
  };
  return { transport, calls };
}

/** 典型的 JPEG 头字节（magic 校验通过）。 */
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("fetch_image 取图执行层", () => {
  it("正常图片：content-type + 魔数都对 → 返回 data URL；连接用的是已核验 IP（钉连接）", async () => {
    const { transport, calls } = fakeTransport({ contentType: "image/jpeg", bytes: JPEG_BYTES });
    const result = await fetchImage("https://example.com/a.jpg", transport);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    // 传输层收到的就是 DNS 已核验的那批地址（校验与连接同一批——防 DNS 重绑定 TOCTOU）
    expect(calls[0]?.ips).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(lookupMock).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("IPv6 公网地址解析 → 通过（v6 路径同样过黑名单校验）", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "2606:4700::1111", family: 6 }]);
    const { transport, calls } = fakeTransport({ contentType: "image/jpeg", bytes: JPEG_BYTES });
    const result = await fetchImage("https://example.com/a.jpg", transport);
    expect(result.ok).toBe(true);
    expect(calls[0]?.ips).toEqual([{ address: "2606:4700::1111", family: 6 }]);
  });

  it("IPv4 字面量 → 拒绝（防直连内网）", async () => {
    const { transport, calls } = fakeTransport({});
    const result = await fetchImage("http://169.254.169.254/latest/meta-data/", transport);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("IP");
    expect(calls).toHaveLength(0);
  });

  it("IPv6 字面量（带方括号）→ 也拒绝（审查修复：曾因不剥括号而被 isIP 放行）", async () => {
    const { transport, calls } = fakeTransport({});
    const result = await fetchImage("http://[::1]/a.png", transport);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("IP");
    expect(calls).toHaveLength(0);
  });

  it("域名解析到内网地址 → 拒绝", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.1.2.3", family: 4 }]);
    const { transport, calls } = fakeTransport({});
    const result = await fetchImage("https://evil.example.com/x.png", transport);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("内网");
    expect(calls).toHaveLength(0);
  });

  it("域名解析到多个地址、其中一个是内网 → 一并拒绝", async () => {
    lookupMock.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.10", family: 4 },
    ]);
    const { transport } = fakeTransport({});
    const result = await fetchImage("https://mixed.example.com/x.png", transport);
    expect(result.ok).toBe(false);
  });

  it("非 http(s) 协议 → 拒绝", async () => {
    const { transport } = fakeTransport({});
    const result = await fetchImage("file:///etc/passwd", transport);
    expect(result.ok).toBe(false);
  });

  it("非标准端口 → 拒绝", async () => {
    const { transport } = fakeTransport({});
    const result = await fetchImage("http://example.com:8080/x.png", transport);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("端口");
  });

  it("跳转（3xx 响应）→ 拒绝（SSRF 绕过防护，不跟随）", async () => {
    const { transport } = fakeTransport({ status: 302, contentType: "text/html" });
    const result = await fetchImage("https://example.com/redirect", transport);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("跳转");
  });

  it("content-type 非 image → 拒绝", async () => {
    const { transport } = fakeTransport({ contentType: "text/html", bytes: [0x3c, 0x68] });
    const result = await fetchImage("https://example.com/page", transport);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("不是图片");
  });

  it("声明 image/png 但字节不是 PNG → 拒绝（防伪装）", async () => {
    const { transport } = fakeTransport({ contentType: "image/png", bytes: [0x00, 0x01, 0x02] });
    const result = await fetchImage("https://example.com/x.png", transport);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("不符");
  });

  it("HTTP 404 → 失败回喂人话", async () => {
    const { transport } = fakeTransport({ status: 404, contentType: "text/plain" });
    const result = await fetchImage("https://example.com/missing.jpg", transport);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("404");
  });
});
