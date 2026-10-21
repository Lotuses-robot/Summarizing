import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { extractImageUrls, mediaIdFromUrl } from "@summarizing/shared";
import { cleanupAllTestAccounts, makeTestAccount, makeTestRealm } from "./helpers/app";
import { executeChanges } from "../executor/executor";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";
import {
  startMediaSweeper,
  storeImageBytes,
  sweepExpiredMedia,
  mediaFilePath,
} from "../application/media";
import { makeAgentTools } from "../agent0/tools";
import { retryRawInput } from "../agent0/digest";
import { cacheIngestImages } from "../application/mediaIngest";
import { FakeLlm } from "./helpers/fakeLlm";
import type * as downloaderModule from "../shared/imageDownloader";
import {
  MEDIA_MAX_INPUT_BYTES,
  baseMediaTtlMs,
  citedMediaExpiry,
  initialMediaExpiry,
  uncitedMediaExpiry,
} from "../shared/mediaTtl";
import { nowWallClock } from "../shared/time";

// 图片持久化（009 刀 1）：后端底座——TTL 纯函数、占位解析、上传校验/压缩、读取隔离、清理器。
// 全部走真实入口（真库 + 真 HTTP 经 makeTestAccount）；sharp 编解码真跑，不用 mock。

/** 下载替身：取图用例按需给一张图（`*.invalid` 域名本就解析不了，命中本地时根本走不到这里）。 */
const downloadStub = vi.hoisted(() => vi.fn());
vi.mock("../shared/imageDownloader", async (importOriginal) => {
  const actual = await importOriginal<typeof downloaderModule>();
  return { ...actual, downloadImageBytes: downloadStub };
});

afterEach(cleanupAllTestAccounts);
afterEach(() => downloadStub.mockReset());

/** 临时媒体目录（每个用例一套；句柄关掉后随 afterEach 删）。 */
const dirs: string[] = [];

/** 造一个临时媒体目录并登记（afterEach 统一删）。 */
function tmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "summarizing-media-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

/** 造一个至少 size 字节的 JPEG。用**随机噪声**（JPEG 压不动噪点）堆体积，
 *  方块边长随目标字节线性放大——既够大又不越 25MP 像素闸。 */
async function jpegAtLeast(size: number): Promise<Buffer> {
  // 噪声 JPEG 约每 1 万像素产 1.2KB；反推边长（再留 1.6 倍余量）
  const targetPixels = (size / 1200) * 10_000 * 1.6;
  const side = Math.max(64, Math.ceil(Math.sqrt(targetPixels)));
  const noise = crypto.randomBytes(side * side * 3);
  const buf = await sharp(noise, {
    raw: { width: side, height: side, channels: 3 },
  })
    .jpeg({ quality: 60 })
    .toBuffer();
  if (buf.length < size) {
    // 目标极大时再放大一轮（仍受 25MP 闸限制，测试目标 ≤3MiB 远够）
    return sharp(buf)
      .resize(Math.ceil(side * 1.2))
      .jpeg({ quality: 60 })
      .toBuffer();
  }
  return buf;
}

/** 造一个不超过 size 字节的小 JPEG。 */
async function smallJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 90, g: 160, b: 200 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

const DAY = 86_400_000;

describe("mediaTtl（留存三档纯函数）", () => {
  it("基础留存与大小反向：0 → 14 天、100 KiB ≈ 13.7 天、1 MiB → 10.5 天、2 MiB → 7 天", () => {
    expect(baseMediaTtlMs(0) / DAY).toBe(14);
    expect(baseMediaTtlMs(100 * 1024) / DAY).toBeCloseTo(13.66, 1);
    expect(baseMediaTtlMs(1024 * 1024) / DAY).toBeCloseTo(10.5, 1);
    expect(baseMediaTtlMs(2 * 1024 * 1024) / DAY).toBe(7);
  });

  it("clamp 边界：超 2 MiB 也不低于 7 天", () => {
    expect(baseMediaTtlMs(50 * 1024 * 1024) / DAY).toBe(7);
  });

  it("三档目标值：入库 = createdAt+基础；未引用 = readAt+3；引用 = citedAt+90", () => {
    const t0 = "2026-10-20T08:00:00";
    expect(initialMediaExpiry(t0, 0)).toBe("2026-11-03T08:00:00"); // 14 天
    expect(uncitedMediaExpiry("2026-10-20T08:00:00")).toBe("2026-10-23T08:00:00"); // 3 天
    expect(citedMediaExpiry("2026-10-20T08:00:00")).toBe("2027-01-18T08:00:00"); // 90 天
  });

  it("墙钟算术跨月/跨年正确（无时区依赖）", () => {
    expect(uncitedMediaExpiry("2026-12-30T23:00:00")).toBe("2027-01-02T23:00:00");
    expect(citedMediaExpiry("2026-12-31T00:00:00")).toBe("2027-03-31T00:00:00");
  });

  it("非法墙钟串抛错——不给脏值算命", () => {
    expect(() => uncitedMediaExpiry("2026-10-20")).toThrow();
    expect(() => uncitedMediaExpiry("")).toThrow();
  });
});

describe("图片占位解析", () => {
  it("抽取 `[图片](url)`：去重、保序、忽略无 URL 写法", () => {
    const text =
      "前 [图片](https://a/1.jpg) 中 [图片](https://a/2.jpg) 后 [图片](https://a/1.jpg) 末 [图片]";
    expect(extractImageUrls(text)).toEqual(["https://a/1.jpg", "https://a/2.jpg"]);
  });

  it("URL 到空格截止（带空格的脏 URL 当畸形写法跳过）", () => {
    // 占位写法约定是「[图片](url)」url 内不含空格/右括号——含空格说明原文坏了，跳过它
    // 比截一半更安全（半截 URL 既打不开也可能误命中本地媒体）
    expect(extractImageUrls("[图片](https://a/b c.jpg)")).toEqual([]);
    // 同样地，无右括号的畸形写法也跳过
    expect(extractImageUrls("[图片](https://a/b")).toEqual([]);
    // 正常的照样抽取
    expect(extractImageUrls("[图片](https://a/b.jpg)")).toEqual(["https://a/b.jpg"]);
  });

  it("本地占位识别：/api/media/<id> 与带域名的绝对写法都认；带扩展名也认；非本地返回 null", () => {
    expect(mediaIdFromUrl("/api/media/abc123")).toBe("abc123");
    expect(mediaIdFromUrl("https://sum.lotuses.cn/api/media/abc123")).toBe("abc123");
    // 从地址栏复制会带上扩展名——判「是不是本地媒体」不该因此漏判成外链
    expect(mediaIdFromUrl("/api/media/abc123.jpg")).toBe("abc123");
    expect(mediaIdFromUrl("https://sum.lotuses.cn/api/media/abc123.jpg")).toBe("abc123");
    expect(mediaIdFromUrl("https://a/1.jpg")).toBeNull();
    expect(mediaIdFromUrl("/api/board")).toBeNull();
    expect(mediaIdFromUrl("/api/media/")).toBeNull();
    expect(mediaIdFromUrl("")).toBeNull();
  });
});

describe("上传校验", () => {
  it("空 body / 零字节 → 拒", async () => {
    const db = makeDb(":memory:");
    await expect(storeImageBytes(db, tmpDir(), Buffer.alloc(0))).rejects.toThrow();
  });

  it("SVG → 拒（可携带脚本，且不便压缩）", async () => {
    const db = makeDb(":memory:");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await expect(
      storeImageBytes(db, tmpDir(), svg, { declaredMime: "image/svg+xml" }),
    ).rejects.toThrow();
  });

  it("content-type 谎报（声明 PNG 实为文本）→ 拒", async () => {
    const db = makeDb(":memory:");
    const notImage = Buffer.from("hello, world");
    await expect(
      storeImageBytes(db, tmpDir(), notImage, { declaredMime: "image/png" }),
    ).rejects.toThrow();
  });

  it("声明为 generic octet-stream 时按魔数兜底识别", async () => {
    const db = makeDb(":memory:");
    const bytes = await jpegAtLeast(30_000);
    const r = await storeImageBytes(db, tmpDir(), bytes, {
      declaredMime: "application/octet-stream",
    });
    expect(r.mime).toBe("image/jpeg");
  });

  it("超过 20 MiB → 拒", async () => {
    const db = makeDb(":memory:");
    const big = Buffer.concat([await smallJpeg(), Buffer.alloc(MEDIA_MAX_INPUT_BYTES)]);
    await expect(
      storeImageBytes(db, tmpDir(), big, { declaredMime: "image/png" }),
    ).rejects.toThrow();
  });

  it("同一内容两次上传 → 内容寻址去重，只存一份", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const bytes = await jpegAtLeast(30_000);
    const a = await storeImageBytes(db, dir, bytes);
    const b = await storeImageBytes(db, dir, bytes);
    expect(a.id).toBe(b.id);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});

describe("压缩（薄切 sharp；档位矩阵见本文件各分支用例）", () => {
  it("≤500 KiB 原样入库（不重编码）", async () => {
    const db = makeDb(":memory:");
    const bytes = await smallJpeg();
    const r = await storeImageBytes(db, tmpDir(), bytes);
    expect(r.sizeBytes).toBe(bytes.length);
    expect(r.mime).toBe("image/jpeg");
    expect(r.animationCompressed).toBe(false);
    expect(r.alphaFlattened).toBe(false);
  });

  it(">500 KiB 的静图压到 ≤500 KiB（agent0 读取闸稳过）", async () => {
    const db = makeDb(":memory:");
    // 1600×1600 噪声 JPEG ≈ 2.5 MiB——超过 500 KiB 但编码只要亚秒级
    const bytes = await sharp(crypto.randomBytes(1600 * 1600 * 3), {
      raw: { width: 1600, height: 1600, channels: 3 },
    })
      .jpeg({ quality: 85 })
      .toBuffer();
    expect(bytes.length).toBeGreaterThan(500 * 1024);
    const r = await storeImageBytes(db, tmpDir(), bytes);
    expect(r.sizeBytes).toBeLessThanOrEqual(500 * 1024);
  }, 30_000);

  it("大动图被压成单帧也必须报 animationCompressed（否则界面不提示，动画悄悄没了）", async () => {
    const db = makeDb(":memory:");
    // 4 帧 800×800 噪声 → GIF 压不动，动画分支也救不回 → 落进静图档（只取第一帧）
    const w = 800;
    const h = 800;
    const frames = 4;
    const gif = await sharp(crypto.randomBytes(w * h * 3 * frames), {
      raw: { width: w, height: h * frames, channels: 3, pageHeight: h },
    })
      .gif()
      .toBuffer();
    expect(gif.length).toBeGreaterThan(2 * 1024 * 1024);
    const r = await storeImageBytes(db, tmpDir(), gif);
    expect(r.mime).toBe("image/jpeg"); // 静图档
    expect(r.animationCompressed).toBe(true); // 动画已经没了——必须说
  }, 60_000);

  it("透明 PNG 压成 JPEG 时填白并报 alphaFlattened（不填白就是默认黑）", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const w = 900;
    const h = 900;
    const rgb = crypto.randomBytes(w * h * 3); // 噪声：PNG 压不动，才过得了 500 KiB 触发线
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      const x = i % w;
      const transparent = x < w / 2; // 左半透明、右半不透明
      rgba[i * 4] = rgb[i * 3] ?? 0;
      rgba[i * 4 + 1] = rgb[i * 3 + 1] ?? 0;
      rgba[i * 4 + 2] = rgb[i * 3 + 2] ?? 0;
      rgba[i * 4 + 3] = transparent ? 0 : 255;
    }
    const png = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
      .png()
      .toBuffer();
    expect(png.length).toBeGreaterThan(2 * 1024 * 1024);

    const r = await storeImageBytes(db, dir, png);
    expect(r.mime).toBe("image/jpeg");
    expect(r.alphaFlattened).toBe(true);
    // 透明区应为白（若没 flatten 会变成黑）
    const raw = await sharp(readFileSync(mediaFilePath(dir, r.id, r.mime)))
      .extract({ left: 10, top: 10, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect(raw[0]).toBeGreaterThan(240);
    expect(raw[1]).toBeGreaterThan(240);
    expect(raw[2]).toBeGreaterThan(240);
  });

  it("像素闸按总解码量算：多帧图只数首帧会被绕过", async () => {
    const db = makeDb(":memory:");
    // 350×350 × 420 帧 = 5145 万像素（首帧只有 12 万）——超过 2500 万像素硬闸。
    // 每帧首像素不同，防止编码器把相同帧合并成一帧（合并了就不是多帧图了，测不到这条闸）
    const w = 350;
    const h = 350;
    const frames = 420;
    const raw = Buffer.alloc(w * h * 3 * frames);
    for (let f = 0; f < frames; f += 1) raw[f * w * h * 3] = (f * 37) % 255;
    const gif = await sharp(raw, {
      raw: { width: w, height: h * frames, channels: 3, pageHeight: h },
    })
      .gif({ effort: 1 })
      .toBuffer();
    await expect(storeImageBytes(db, tmpDir(), gif)).rejects.toThrow(/像素数超过上限/);
  });
});

describe("读取隔离（HTTP 真实入口）", () => {
  it("未登录上传 → 401（裸打 app，不带 helper 自动 cookie）", async () => {
    const realm = await makeTestRealm();
    const res = await realm.app.inject({
      method: "POST",
      url: "/api/media",
      headers: { "content-type": "image/jpeg" },
      payload: await smallJpeg(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("未登录读取 → 401", async () => {
    const realm = await makeTestRealm();
    const t = await realm.addAccount();
    const up = await t.inject({
      method: "POST",
      url: "/api/media",
      headers: { "content-type": "image/jpeg" },
      payload: await smallJpeg(),
    });
    const { id } = up.json<{ id: string }>();
    const res = await realm.app.inject({ method: "GET", url: `/api/media/${id}` });
    expect(res.statusCode).toBe(401);
  });

  it("他人账户 → 404（同一图在别人库里查不到，不泄露存在性）", async () => {
    // 真造两个账户：同一实例、各自一库、各自 cookie
    const realm = await makeTestRealm();
    const a = await realm.addAccount();
    const b = await realm.addAccount();
    const up = await a.inject({
      method: "POST",
      url: "/api/media",
      headers: { "content-type": "image/jpeg" },
      payload: await smallJpeg(),
    });
    expect(up.statusCode).toBe(200);
    const { id } = up.json<{ id: string }>();

    expect((await a.inject({ method: "GET", url: `/api/media/${id}` })).statusCode).toBe(200);
    // b 的库里没有这行 → 404（与"不存在"同形）
    expect((await b.inject({ method: "GET", url: `/api/media/${id}` })).statusCode).toBe(404);
  });

  it("本账户读回：字节 + content-type + private 缓存头", async () => {
    const t = await makeTestAccount();
    const bytes = await smallJpeg();
    const up = await t.inject({
      method: "POST",
      url: "/api/media",
      headers: { "content-type": "image/jpeg" },
      payload: bytes,
    });
    expect(up.statusCode).toBe(200);
    const body = up.json<{ id: string; sizeBytes: number; url: string }>();
    expect(body.sizeBytes).toBe(bytes.length); // 小图不重编码
    expect(body.url).toBe(`/api/media/${body.id}`);

    const get = await t.inject({ method: "GET", url: `/api/media/${body.id}` });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("image/jpeg");
    expect(get.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(Buffer.from(get.rawPayload).equals(bytes)).toBe(true); // 字节逐字节一致
  });

  it("坏 id / 路径穿越字符 / 文件缺失 → 404", async () => {
    const t = await makeTestAccount();
    expect((await t.inject({ method: "GET", url: "/api/media/deadbeef" })).statusCode).toBe(404);
    expect((await t.inject({ method: "GET", url: "/api/media/../../etc/passwd" })).statusCode).toBe(
      404,
    );

    const dir = tmpDir();
    const bytes = await smallJpeg();
    const stored = await storeImageBytes(t.db, dir, bytes);
    rmSync(mediaFilePath(dir, stored.id, stored.mime));
    expect((await t.inject({ method: "GET", url: `/api/media/${stored.id}` })).statusCode).toBe(
      404,
    );
  });
});

describe("清理器", () => {
  it("过期 → 删文件 + 删行；未过期不动", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const bytes = await smallJpeg();
    const stored = await storeImageBytes(db, dir, bytes);
    expect(existsSync(mediaFilePath(dir, stored.id, stored.mime))).toBe(true);

    // 手工把到期时间改成过去，再跑清理
    db.$client
      .prepare("UPDATE media SET expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00", stored.id);
    const out = sweepExpiredMedia(db, dir, nowWallClock());
    expect(out.removed).toBe(1);
    expect(out.files).toBe(1);
    expect(existsSync(mediaFilePath(dir, stored.id, stored.mime))).toBe(false);
    expect(repo.getMedia(db, stored.id)).toBeNull();
  });

  it("文件缺失只删行、不炸", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const bytes = await smallJpeg();
    const stored = await storeImageBytes(db, dir, bytes);
    rmSync(mediaFilePath(dir, stored.id, stored.mime));
    db.$client
      .prepare("UPDATE media SET expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00", stored.id);
    const out = sweepExpiredMedia(db, dir, nowWallClock());
    expect(out.removed).toBe(1);
    expect(out.missingFiles).toBe(1);
    expect(repo.getMedia(db, stored.id)).toBeNull();
  });

  it("媒体目录异常（被换成文件）→ 清理器不炸（其余清理任务照常完成）", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const bytes = await smallJpeg();
    const stored = await storeImageBytes(db, dir, bytes);
    // 整个媒体目录被换成普通文件：之后任何文件 IO 必失败。断言的是「清理器不炸」——
    // 删不动的文件要不要留行是次要的（fs 层行为跨平台不一致，无稳定断言价值），
    // 真正要保住的契约是：异常目录不影响清理器跑完、不影响别的行被清。
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "i am a file, not a directory");
    db.$client
      .prepare("UPDATE media SET expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00", stored.id);
    expect(() => sweepExpiredMedia(db, dir, nowWallClock())).not.toThrow();
    rmSync(dir, { force: true });
  });
});

describe("TTL 三档在存储层的联动（bump / shorten）", () => {
  it("bump 只增不减；shorten 只减不增", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const bytes = await smallJpeg();
    const stored = await storeImageBytes(db, dir, bytes);

    expect(repo.bumpMediaExpiry(db, stored.id, "2020-01-01T00:00:00")).toBe(false); // 更早 → 不动
    expect(repo.bumpMediaExpiry(db, stored.id, "2099-01-01T00:00:00")).toBe(true);
    expect(repo.getMedia(db, stored.id)?.expiresAt).toBe("2099-01-01T00:00:00");

    expect(repo.shortenMediaExpiry(db, stored.id, "2099-01-02T00:00:00")).toBe(false); // 更晚 → 不动
    expect(repo.shortenMediaExpiry(db, stored.id, "2026-01-01T00:00:00")).toBe(true);
    expect(repo.getMedia(db, stored.id)?.expiresAt).toBe("2026-01-01T00:00:00");
  });

  it("行已删 → bump/shorten 都返回 false（更新不到就算了）", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const bytes = await smallJpeg();
    const stored = await storeImageBytes(db, dir, bytes);
    repo.deleteMediaRow(db, stored.id);
    expect(repo.bumpMediaExpiry(db, stored.id, "2099-01-01T00:00:00")).toBe(false);
    expect(repo.shortenMediaExpiry(db, stored.id, "2026-01-01T00:00:00")).toBe(false);
  });
});

describe("详情接口的 media 映射（009 刀 2；前端 MediaText 的唯一数据源）", () => {
  it("原文/引文的本地占位进映射；未缓存的外部 URL 不进（前端据此回退链接）", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const bytes = await smallJpeg();
    const stored = await storeImageBytes(db, dir, bytes);

    const raw = repo.insertRawInput(db, {
      content: `看这张 [图片](/api/media/${stored.id}) 还有这张 [图片](https://qq.example/expired.jpg)`,
      sourceType: "paste",
      sourceIdentity: { sourceLabel: "s" },
      receivedAt: "2026-09-28T10:00:00",
      eventTime: null,
    });
    executeChanges(
      db,
      raw,
      [
        {
          action: "create_item",
          elements: [
            {
              label: "name",
              text: "带图的事项",
              quotes: [`[图片](/api/media/${stored.id})`],
            },
          ],
          tags: [],
          doubtNote: null,
        },
      ],
      { actor: "agent0", model: "test" },
    );

    const item = repo.deriveItems(db)[0];
    expect(item).toBeDefined();
    if (item === undefined) return;
    const full = repo.getItemFull(db, item.id);
    expect(full).not.toBeNull();
    if (full === null) return;
    // 本地占位在映射里；未缓存的外部 URL 不在
    expect(Object.keys(full.media)).toEqual([`/api/media/${stored.id}`]);
    expect(full.media[`/api/media/${stored.id}`]?.id).toBe(stored.id);
  });

  it("无图片的详情 → media 为空对象（前端据「空」不做任何渲染分支）", async () => {
    const db = makeDb(":memory:");
    const raw = repo.insertRawInput(db, {
      content: "纯文字，没有图",
      sourceType: "paste",
      sourceIdentity: { sourceLabel: "s" },
      receivedAt: "2026-09-28T10:00:00",
      eventTime: null,
    });
    executeChanges(
      db,
      raw,
      [
        {
          action: "create_item",
          elements: [{ label: "name", text: "无图事项", quotes: [] }],
          tags: [],
          doubtNote: null,
        },
      ],
      { actor: "agent0", model: "test" },
    );
    const item = repo.deriveItems(db)[0];
    if (item === undefined) throw new Error("播种失败");
    expect(repo.getItemFull(db, item.id)?.media).toEqual({});
  });
});

describe("进站缓存走真实入口（刀 3：路由必须把媒体目录传下去）", () => {
  it("POST /api/ingest → 图片后台缓存落行，原文逐字不变", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' }); // 零变更合法：本用例只看缓存，不看消化结果
    const t = await makeTestAccount({ llm });
    const original = "看这张 [图片](https://pic.invalid/ingest.png) 图";
    downloadStub.mockResolvedValue({ bytes: await smallJpeg(), contentType: "image/jpeg" });

    const res = await t.inject({
      method: "POST",
      url: "/api/ingest",
      payload: { content: original, sourceType: "paste", sourceIdentity: { sourceLabel: "s" } },
    });
    expect(res.statusCode).toBe(202);

    // 缓存是后台的（fire-and-forget）：轮询到行出现
    await vi.waitFor(() =>
      expect(repo.getMediaByOriginUrl(t.db, "https://pic.invalid/ingest.png")).not.toBeNull(),
    );
    const rawId = z.object({ id: z.string() }).parse(res.json()).id;
    expect(repo.getRawInput(t.db, rawId)?.content).toBe(original);
  });
});

describe("agent0 取图：本地优先 + 成功持久化（009 FR-008）", () => {
  it("占位是本地媒体 → 读盘零网络，data URL 的 MIME 与库里一致", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const stored = await storeImageBytes(db, dir, await smallJpeg());
    const result = await makeAgentTools(db, dir).fetchImage({ url: `/api/media/${stored.id}` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mediaId).toBe(stored.id);
    expect(result.dataUrl.startsWith(`data:${stored.mime};base64,`)).toBe(true);
  });

  it("原链接已缓存 → 读本地副本（域名不可解析也不打网）", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const url = "https://pic.invalid/cached.png";
    const stored = await storeImageBytes(db, dir, await smallJpeg(), { originUrl: url });
    const result = await makeAgentTools(db, dir).fetchImage({ url });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mediaId).toBe(stored.id);
  });

  it("本地媒体已被清理 → ok:false（本地占位没有可回退的网络来源）", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const stored = await storeImageBytes(db, dir, await smallJpeg());
    repo.deleteMediaRow(db, stored.id);
    const result = await makeAgentTools(db, dir).fetchImage({ url: `/api/media/${stored.id}` });
    expect(result).toEqual({ ok: false, reason: "图片已过期或已被清理" });
  });

  it("下载成功 → 顺手持久化（originUrl 记原链接）", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const url = "https://pic.invalid/fresh.png";
    downloadStub.mockResolvedValueOnce({ bytes: await smallJpeg(), contentType: "image/jpeg" });
    const result = await makeAgentTools(db, dir).fetchImage({ url });
    if (!result.ok) throw new Error(`取图失败：${result.reason}`);
    expect(result.mediaId).not.toBeNull();
    expect(repo.getMediaByOriginUrl(db, url)?.id).toBe(result.mediaId);
  });

  it("持久化失败 → 图照样给模型看（mediaId=null，只留痕）", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    // 媒体目录换成普通文件：落盘必失败（与清理器用例同一手法）
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "not a directory");
    downloadStub.mockResolvedValueOnce({ bytes: await smallJpeg(), contentType: "image/jpeg" });
    const result = await makeAgentTools(db, dir).fetchImage({ url: "https://pic.invalid/x.png" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mediaId).toBeNull();
  });
});

describe("引用续命 + 每小时清理（009 刀 4）", () => {
  /** 造一条原文（引文必须逐字摘自原文）。 */
  function seedRaw(db: ReturnType<typeof makeDb>, content: string) {
    return repo.insertRawInput(db, {
      content,
      sourceType: "paste",
      sourceIdentity: { sourceLabel: "s" },
      receivedAt: "2026-10-20T10:00:00",
      eventTime: null,
    });
  }

  /** 用 create_item 引用某张图（围栏的两道硬要求：引文逐字 + 多模态标签）。 */
  function cite(db: ReturnType<typeof makeDb>, placeholder: string) {
    return executeChanges(
      db,
      seedRaw(db, `看 ${placeholder} 这张`),
      [
        {
          action: "create_item",
          elements: [{ label: "name", text: "看图", quotes: [placeholder] }],
          tags: ["多模态/图片"],
          doubtNote: null,
        },
      ],
      { actor: "agent0", model: "test" },
    );
  }

  it("引文含该图占位 → 抬到引用时刻 + 90 天（已过期也能救回）", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const stored = await storeImageBytes(db, dir, await smallJpeg());
    // 先模拟「早就过期」/「被缩到很短」
    db.$client
      .prepare("UPDATE media SET expires_at=? WHERE id=?")
      .run("2020-01-01T00:00:00", stored.id);
    const placeholder = `[图片](/api/media/${stored.id})`;

    const before = citedMediaExpiry(nowWallClock());
    const { citedMediaIds } = cite(db, placeholder);
    const after = citedMediaExpiry(nowWallClock());

    expect(citedMediaIds.has(stored.id)).toBe(true);
    const got = repo.getMedia(db, stored.id)?.expiresAt ?? "";
    expect(got >= before && got <= after).toBe(true);
  });

  it("到期时间已更晚 → 引用不回退（日期只增不减）", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const stored = await storeImageBytes(db, dir, await smallJpeg());
    db.$client
      .prepare("UPDATE media SET expires_at=? WHERE id=?")
      .run("2099-01-01T00:00:00", stored.id);

    cite(db, `[图片](/api/media/${stored.id})`);

    expect(repo.getMedia(db, stored.id)?.expiresAt).toBe("2099-01-01T00:00:00");
  });

  it("清理器：启动即清一次 + 定时回调也清；停掉后不再跑", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    /** 造一张已到期的图（内容各不相同——否则 sha256 去重会复用同一行）。 */
    const seedExpired = async (): Promise<string> => {
      const stored = await storeImageBytes(db, dir, await smallJpeg());
      db.$client
        .prepare("UPDATE media SET expires_at=? WHERE id=?")
        .run("2020-01-01T00:00:00", stored.id);
      return stored.id;
    };

    const first = await seedExpired();
    const spy = vi.spyOn(globalThis, "setInterval");
    const stop = startMediaSweeper(db, dir);
    expect(repo.getMedia(db, first)).toBeNull(); // 启动即清

    const tick = spy.mock.calls[0]?.[0];
    expect(typeof tick).toBe("function");
    const second = await seedExpired();
    tick?.();
    expect(repo.getMedia(db, second)).toBeNull(); // 定时那次也清

    stop();
    spy.mockRestore();
    const third = await seedExpired();
    await new Promise((r) => setTimeout(r, 10));
    expect(repo.getMedia(db, third)).not.toBeNull(); // 停掉后不再清
  });
});

describe("内容寻址去重与 originUrl（009 修复）", () => {
  it("先无链接上传、后带原链接进来 → 复用同一行并补上 originUrl", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const bytes = await smallJpeg();
    const uploaded = await storeImageBytes(db, dir, bytes); // 前台上传：无链接
    expect(repo.getMediaByOriginUrl(db, "https://qq.example/x.jpg")).toBeNull();

    const cached = await storeImageBytes(db, dir, bytes, { originUrl: "https://qq.example/x.jpg" });
    expect(cached.id).toBe(uploaded.id); // 内容寻址：同一份字节只有一行
    // 补上映射后，缓存去重与占位反查才是通的（否则每次进站都重下、详情永远查不到）
    expect(repo.getMediaByOriginUrl(db, "https://qq.example/x.jpg")?.id).toBe(uploaded.id);
  });
});

describe("进站图片缓存的上限与顺序（009 修复：未登录不该缓冲 body）", () => {
  it("未登录 + 21 MiB 请求体 → 401（鉴权在解析 body 之前，不把字节读进来）", async () => {
    const realm = await makeTestRealm();
    const res = await realm.app.inject({
      method: "POST",
      url: "/api/media",
      headers: { "content-type": "image/jpeg" },
      payload: Buffer.alloc(21 * 1024 * 1024, 1),
    });
    expect(res.statusCode).toBe(401);
  });

  it("已登录 + 超过 20 MiB → 413（自定义解析器自己卡字节，bodyLimit 对它不生效）", async () => {
    const t = await makeTestAccount();
    const res = await t.inject({
      method: "POST",
      url: "/api/media",
      headers: { "content-type": "image/jpeg" },
      payload: Buffer.alloc(21 * 1024 * 1024, 1),
    });
    expect(res.statusCode).toBe(413);
    expect(res.body).toContain("20 MiB");
  });
});

describe("重试与对话路径也缓存图片（009 修复：缓存挂在 kickDigest）", () => {
  it("重试一条失败批次 → 图片重新尝试缓存并落行", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const raw = repo.insertRawInput(db, {
      content: "看 [图片](https://pic.invalid/retry.png)",
      sourceType: "nc",
      sourceIdentity: { sourceLabel: "群" },
      receivedAt: "2026-10-21T10:00:00",
      eventTime: null,
    });
    repo.setDigestState(db, raw.id, "failed");
    downloadStub.mockResolvedValue({ bytes: await smallJpeg(), contentType: "image/jpeg" });

    const llm = new FakeLlm(); // 队列空 → 消化失败无妨，本用例只看缓存
    const result = retryRawInput(db, llm, makeAgentTools(db, dir), "test-model", raw.id, dir);
    expect(result.ok).toBe(true);
    await vi.waitFor(() =>
      expect(repo.getMediaByOriginUrl(db, "https://pic.invalid/retry.png")).not.toBeNull(),
    );
  });
});

describe("进站缓存的重试（009：只对瞬态错误重试一次）", () => {
  it("瞬态错误（连接中断）→ 重试后成功", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const raw = repo.insertRawInput(db, {
      content: "看 [图片](https://pic.invalid/retry-ok.png)",
      sourceType: "nc",
      sourceIdentity: { sourceLabel: "群" },
      receivedAt: "2026-10-21T10:00:00",
      eventTime: null,
    });
    const jpeg = await smallJpeg();
    downloadStub
      .mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce({ bytes: jpeg, contentType: "image/jpeg" });
    await cacheIngestImages(db, dir, raw.id);
    expect(downloadStub).toHaveBeenCalledTimes(2);
    expect(repo.getMediaByOriginUrl(db, "https://pic.invalid/retry-ok.png")).not.toBeNull();
    // 流水里能看到「开始缓存 / 完成」（用户可见的进站流程）
    const actions = repo.listPipelineEvents(db, raw.id).map((e) => e.action);
    expect(actions).toContain("media_cache");
    expect(actions).toContain("media_cache_done");
  });

  it("非瞬态错误（HTTP 404）→ 不重试，只试一次", async () => {
    const db = makeDb(":memory:");
    const dir = tmpDir();
    const raw = repo.insertRawInput(db, {
      content: "看 [图片](https://pic.invalid/gone.png)",
      sourceType: "nc",
      sourceIdentity: { sourceLabel: "群" },
      receivedAt: "2026-10-21T10:00:00",
      eventTime: null,
    });
    downloadStub.mockRejectedValueOnce(new Error("取图失败：HTTP 404"));
    await cacheIngestImages(db, dir, raw.id);
    expect(downloadStub).toHaveBeenCalledTimes(1);
    expect(repo.getMediaByOriginUrl(db, "https://pic.invalid/gone.png")).toBeNull();
    expect(repo.listPipelineEvents(db, raw.id).map((e) => e.action)).toContain(
      "media_cache_failed",
    );
  });
});
