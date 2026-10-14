import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchImage } from "../agent0/fetchImage";

// 多模态取图执行层（2026-10-13）：SSRF 四道闸 + MIME/魔数/大小 的单元断言。
// 网络用 vi.stubGlobal 替身——不打真网（真机 QQ 联调走 04 验收，见 docs）。

/** 造一个最小 Response 替身：指定状态/content-type/字节，供 fetch 替身返回。 */
function fakeResponse(opts: {
  status?: number;
  contentType?: string;
  bytes?: number[];
  location?: string;
}): Response {
  const body = new Uint8Array(opts.bytes ?? []);
  const headers = new Headers();
  if (opts.contentType !== undefined) headers.set("content-type", opts.contentType);
  if (opts.location !== undefined) headers.set("location", opts.location);
  return new Response(body, { status: opts.status ?? 200, headers });
}

/** 典型的 JPEG 头字节（magic 校验通过）。 */
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetch_image 取图执行层", () => {
  it("正常图片：content-type + 魔数都对 → 返回 data URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse({ contentType: "image/jpeg", bytes: JPEG_BYTES })),
    );
    // example.com 是公网可解析域名；DNS 校验用真 lookup（不打网），只查 A 记录归属
    const result = await fetchImage("https://example.com/a.jpg");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("IP 字面量 → 拒绝（防直连内网）", async () => {
    const result = await fetchImage("http://169.254.169.254/latest/meta-data/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("IP");
  });

  it("非 http(s) 协议 → 拒绝", async () => {
    const result = await fetchImage("file:///etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("非标准端口 → 拒绝", async () => {
    const result = await fetchImage("http://example.com:8080/x.png");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("端口");
  });

  it("跳转 → 拒绝（SSRF 绕过防护）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({
          status: 302,
          location: "http://169.254.169.254/",
          contentType: "text/html",
        }),
      ),
    );
    const result = await fetchImage("https://example.com/redirect");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("跳转");
  });

  it("content-type 非 image → 拒绝", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse({ contentType: "text/html", bytes: [0x3c, 0x68] })),
    );
    const result = await fetchImage("https://example.com/page");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("不是图片");
  });

  it("声明 image/png 但字节不是 PNG → 拒绝（防伪装）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({ contentType: "image/png", bytes: [0x00, 0x01, 0x02, 0x03] }),
      ),
    );
    const result = await fetchImage("https://example.com/x.png");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("不符");
  });

  it("HTTP 404 → 失败回喂人话", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse({ status: 404, contentType: "text/plain" })),
    );
    const result = await fetchImage("https://example.com/missing.jpg");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("404");
  });
});
