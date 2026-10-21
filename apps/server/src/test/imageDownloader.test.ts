import { beforeEach, describe, expect, it, vi } from "vitest";
import { downloadImageBytes, type ImageTransport } from "../shared/imageDownloader";

// SSRF 五道闸单测（2026-10-21 从 fetchImage.test.ts 迁来——闸随下载器上移 shared，
// 进站缓存与 agent0 取图共用同一套拦截标准）。
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

/** 典型的 JPEG 头字节（magic 校验通过——本文件只测闸，字节内容无所谓）。 */
const ANY_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("图片下载器的 SSRF 五道闸", () => {
  it("正常图片：下载到字节；传输层收到的就是 DNS 已核验的那批地址（防 DNS 重绑定 TOCTOU）", async () => {
    const { transport, calls } = fakeTransport({ contentType: "image/jpeg", bytes: ANY_BYTES });
    const got = await downloadImageBytes("https://example.com/a.jpg", transport);
    expect(got.contentType).toBe("image/jpeg");
    expect(got.bytes.length).toBe(ANY_BYTES.length);
    expect(calls[0]?.ips).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(lookupMock).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("IPv6 公网地址解析 → 通过（v6 路径同样过黑名单校验）", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "2606:4700::1111", family: 6 }]);
    const { transport, calls } = fakeTransport({ contentType: "image/jpeg", bytes: ANY_BYTES });
    await downloadImageBytes("https://example.com/a.jpg", transport);
    expect(calls[0]?.ips).toEqual([{ address: "2606:4700::1111", family: 6 }]);
  });

  it("IPv4 字面量 → 拒绝（防直连内网）", async () => {
    const { transport, calls } = fakeTransport({});
    await expect(
      downloadImageBytes("http://169.254.169.254/latest/meta-data/", transport),
    ).rejects.toThrow(/IP/);
    expect(calls).toHaveLength(0);
  });

  it("IPv6 字面量（带方括号）→ 也拒绝（审查修复：曾因不剥括号而被 isIP 放行）", async () => {
    const { transport, calls } = fakeTransport({});
    await expect(downloadImageBytes("http://[::1]/a.png", transport)).rejects.toThrow(/IP/);
    expect(calls).toHaveLength(0);
  });

  it("域名解析到内网地址 → 拒绝", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.1.2.3", family: 4 }]);
    const { transport, calls } = fakeTransport({});
    await expect(downloadImageBytes("https://evil.example.com/x.png", transport)).rejects.toThrow(
      /内网/,
    );
    expect(calls).toHaveLength(0);
  });

  it("域名解析到多个地址、其中一个是内网 → 一并拒绝", async () => {
    lookupMock.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.10", family: 4 },
    ]);
    const { transport } = fakeTransport({});
    await expect(
      downloadImageBytes("https://mixed.example.com/x.png", transport),
    ).rejects.toThrow();
  });

  it("云元数据地址（100.100.100.200）也在黑名单内", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "100.100.100.200", family: 4 }]);
    const { transport } = fakeTransport({});
    await expect(downloadImageBytes("https://ali.example/x", transport)).rejects.toThrow(/内网/);
  });

  it("非 http(s) 协议 → 拒绝", async () => {
    const { transport } = fakeTransport({});
    await expect(downloadImageBytes("file:///etc/passwd", transport)).rejects.toThrow();
  });

  it("非标准端口 → 拒绝", async () => {
    const { transport } = fakeTransport({});
    await expect(downloadImageBytes("http://example.com:8080/x.png", transport)).rejects.toThrow(
      /端口/,
    );
  });

  it("跳转（3xx 响应）→ 拒绝（SSRF 绕过防护，不跟随）", async () => {
    const { transport } = fakeTransport({ status: 302, contentType: "text/html" });
    await expect(downloadImageBytes("https://example.com/redirect", transport)).rejects.toThrow(
      /跳转|302/,
    );
  });

  it("HTTP 404 → 抛人话错（调用方据此人话留痕）", async () => {
    const { transport } = fakeTransport({ status: 404, contentType: "text/plain" });
    await expect(downloadImageBytes("https://example.com/missing.jpg", transport)).rejects.toThrow(
      /404/,
    );
  });
});
