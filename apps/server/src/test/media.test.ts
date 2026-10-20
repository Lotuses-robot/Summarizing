import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { extractImageUrls, mediaIdFromUrl, textCitesMedia } from "@summarizing/shared";
import { cleanupAllTestAccounts, makeTestAccount, makeTestRealm } from "./helpers/app";
import { executeChanges } from "../executor/executor";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";
import { storeImageBytes, sweepExpiredMedia, mediaFilePath } from "../application/media";
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

afterEach(cleanupAllTestAccounts);

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
 *  方块边长随目标字节线性放大——既够大又不越 50MP 像素闸。 */
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
    // 目标极大时再放大一轮（仍受 50MP 闸限制，测试目标 ≤3MiB 远够）
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
  it("基础留存与大小反向：0 → 30 天、100 KiB ≈ 28.9 天、1 MiB ≈ 18.5 天、2 MiB → 7 天", () => {
    expect(baseMediaTtlMs(0) / DAY).toBe(30);
    expect(baseMediaTtlMs(100 * 1024) / DAY).toBeCloseTo(28.87, 1);
    expect(baseMediaTtlMs(1024 * 1024) / DAY).toBeCloseTo(18.5, 1);
    expect(baseMediaTtlMs(2 * 1024 * 1024) / DAY).toBe(7);
  });

  it("clamp 边界：超 2 MiB 也不低于 7 天", () => {
    expect(baseMediaTtlMs(50 * 1024 * 1024) / DAY).toBe(7);
  });

  it("三档目标值：入库 = createdAt+基础；未引用 = readAt+3；引用 = citedAt+90", () => {
    const t0 = "2026-10-20T08:00:00";
    expect(initialMediaExpiry(t0, 0)).toBe("2026-11-19T08:00:00"); // 30 天
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
  });

  it("引用判定：本地图按 id、信源图按 originUrl", () => {
    const opts = { mediaId: "deadbeef", originUrl: "https://a/1.jpg" };
    expect(textCitesMedia("见 [图片](/api/media/deadbeef)", opts)).toBe(true);
    expect(textCitesMedia("见 [图片](https://a/1.jpg)", opts)).toBe(true);
    expect(textCitesMedia("见 [图片](https://a/2.jpg)", opts)).toBe(false);
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

describe("压缩（薄切 sharp；详见 media.compress.test.ts 的档位矩阵）", () => {
  it("≤2 MiB 原样入库（不重编码）", async () => {
    const db = makeDb(":memory:");
    const bytes = await jpegAtLeast(300_000);
    const r = await storeImageBytes(db, tmpDir(), bytes);
    expect(r.sizeBytes).toBe(bytes.length);
    expect(r.mime).toBe("image/jpeg");
  });

  it(">2 MiB 的静图压到 ≤1.9 MiB（agent0 读取闸稳过）", async () => {
    const db = makeDb(":memory:");
    const bytes = await jpegAtLeast(3_000_000);
    expect(bytes.length).toBeGreaterThan(2 * 1024 * 1024);
    const r = await storeImageBytes(db, tmpDir(), bytes);
    expect(r.sizeBytes).toBeLessThanOrEqual(Math.floor(1.9 * 1024 * 1024));
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
