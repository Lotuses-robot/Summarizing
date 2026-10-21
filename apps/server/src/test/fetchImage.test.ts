import { describe, expect, it } from "vitest";
import { fetchImage } from "../agent0/fetchImage";

// fetch_image 执行层（2026-10-21 瘦身后）：SSRF 五道闸已随下载器上移
// shared/imageDownloader.ts（那里有全套闸门单测）。本文件只测 agent0 特有的三件事：
//   ① 2 MiB 读取闸（图要进模型上下文）；② content-type image/* + 魔数一致；
//   ③ data URL 编码。任何失败归一成 { ok:false, reason }——不抛（不许中断消化）。

/** 替身下载器：收 url，回剧本（不打网、不过闸）。 */
function stub(
  resp: { bytes?: Uint8Array; contentType?: string; throws?: string } = {},
): (url: string) => Promise<{ bytes: Uint8Array; contentType: string }> {
  return async () => {
    if (resp.throws !== undefined) throw new Error(resp.throws);
    return { bytes: resp.bytes ?? new Uint8Array(0), contentType: resp.contentType ?? "" };
  };
}

/** 典型的 JPEG 头字节（magic 校验通过）。 */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe("fetch_image 执行层", () => {
  it("正常图片 → 返回 data URL", async () => {
    const r = await fetchImage("https://x/a.jpg", stub({ bytes: JPEG, contentType: "image/jpeg" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("content-type 非 image → 拒绝", async () => {
    const r = await fetchImage(
      "https://x/page",
      stub({ bytes: new Uint8Array([0x3c, 0x68]), contentType: "text/html" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("不是图片");
  });

  it("声明 image/png 但字节不是 PNG → 拒绝（防伪装成图片的任意字节灌 LLM）", async () => {
    const r = await fetchImage(
      "https://x/x.png",
      stub({ bytes: new Uint8Array([0x00, 0x01, 0x02]), contentType: "image/png" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("不符");
  });

  it("超过 2 MiB → 拒绝（图要进模型上下文，base64 后体积还涨）", async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    // 头两字节仍是 JPEG 魔数（先过 MIME 校验，再由大小闸拦下——验证顺序）
    big[0] = 0xff;
    big[1] = 0xd8;
    big[2] = 0xff;
    const r = await fetchImage(
      "https://x/big.jpg",
      stub({ bytes: big, contentType: "image/jpeg" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("大小");
  });

  it("下载失败（替身抛错）→ 归一成人话 reason，不抛给调用方", async () => {
    const r = await fetchImage("https://x/a.jpg", stub({ throws: "取图失败：HTTP 404" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("404");
  });
});
