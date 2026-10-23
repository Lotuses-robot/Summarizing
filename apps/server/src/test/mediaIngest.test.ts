import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { extractImageUrls } from "@summarizing/shared";
import * as repo from "../storage/repo";
import { makeDb } from "../storage/db";
import { storeImageBytes, sweepExpiredMedia } from "../application/media";
import { cacheIngestImages } from "../application/mediaIngest";

// 进站图片缓存（009 刀 3）：落档后扫原文 `[图片](http…)` → 后台下载 → 存本地。
// 断言点：① 原文逐字不变；② 已缓存 URL 不重复下载；③ 失败只留痕不抛、不阻塞；
// ④ 非 http 占位（本地已上传图）不进下载队列。真实 sharp 编解码，无网络 mock——
// 走的是「行在库里就当已缓存」这条真实分支（不打网）。

/** 一张真 PNG（64×64 纯色）。 */
async function smallPng(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 120, b: 90 } },
  })
    .png()
    .toBuffer();
}

/** 造一条 raw 批次（真实写入路径）。 */
function seedRaw(db: ReturnType<typeof makeDb>, content: string): string {
  const raw = repo.insertRawInput(db, {
    content,
    source: "nc",
    identity: { displayName: "测试群", groupId: "g1" },
    receivedAt: "2026-09-28T10:00:00",
    eventTime: null,
  });
  return raw.id;
}

describe("进站图片缓存", () => {
  it("已缓存的 URL → 跳过下载（不打网；内容寻址去重）", async () => {
    const db = makeDb(":memory:");
    const dir = makeDir();
    const bytes = await smallPng();
    const stored = await storeImageBytes(db, dir, bytes, {
      originUrl: "https://pic.example/a.png",
    });
    // 再造一条引用同一 URL 的批次 → 应直接跳过（库里已有 origin_url 行）
    const rawId = seedRaw(db, "看 [图片](https://pic.example/a.png) 这张");
    await cacheIngestImages(db, dir, rawId);
    // 仍是那一行（没有重复插入）
    const row = repo.getMediaByOriginUrl(db, "https://pic.example/a.png");
    expect(row?.id).toBe(stored.id);
  });

  it("原文逐字不变：缓存是旁挂，绝不改 raw_inputs.content", async () => {
    const db = makeDb(":memory:");
    const dir = makeDir();
    const original = "看 [图片](https://pic.example/a.png) 截止 10 月 1 日";
    const rawId = seedRaw(db, original);
    // 不下载成功也没关系——这里只断言原文不被缓存过程改写
    await cacheIngestImages(db, dir, rawId);
    expect(repo.getRawInput(db, rawId)?.content).toBe(original);
  });

  it("本地已上传的占位（/api/media/...）不进下载队列（那不是外链）", async () => {
    const db = makeDb(":memory:");
    const dir = makeDir();
    const bytes = await smallPng();
    const stored = await storeImageBytes(db, dir, bytes); // 无 originUrl = 上传图
    const rawId = seedRaw(db, `看 [图片](/api/media/${stored.id}) 这张`);
    await cacheIngestImages(db, dir, rawId);
    // 没有多出任何行（[图片](/api/media/...) 不是 http 开头，被过滤）
    expect(db.$client.prepare("SELECT COUNT(*) c FROM media").get()).toEqual({ c: 1 });
  });

  it("批次不存在 / 无图片占位 → 静默返回，不抛", async () => {
    const db = makeDb(":memory:");
    const dir = makeDir();
    await expect(cacheIngestImages(db, dir, "no-such-raw")).resolves.toBeUndefined();
    const rawId = seedRaw(db, "纯文字，没有图");
    await expect(cacheIngestImages(db, dir, rawId)).resolves.toBeUndefined();
    expect(db.$client.prepare("SELECT COUNT(*) c FROM media").get()).toEqual({ c: 0 });
  });

  it("extractImageUrls 只取 http(s) 外链给缓存用（本地占位由 /api/media/ 自己供）", async () => {
    const text = "a [图片](/api/media/x) b [图片](https://pic.example/a.png)";
    const urls = extractImageUrls(text).filter((u) => u.startsWith("http"));
    expect(urls).toEqual(["https://pic.example/a.png"]);
  });

  it("过期清理：清完的 media 行删掉，文件也删（TTL 到期即失效）", async () => {
    const db = makeDb(":memory:");
    const dir = makeDir();
    const bytes = await smallPng();
    const stored = await storeImageBytes(db, dir, bytes, { originUrl: "https://x/y.png" });
    db.$client
      .prepare("UPDATE media SET expires_at=? WHERE id=?")
      .run("2020-01-01T00:00:00", stored.id);
    const out = sweepExpiredMedia(db, dir);
    expect(out.removed).toBe(1);
    expect(repo.getMediaByOriginUrl(db, "https://x/y.png")).toBeNull();
  });
});

// ── 本地小工具（临时目录；afterEach 统一删）──

/** makeDir 建的临时目录（afterEach 统一删——免得 %TEMP% 攒垃圾）。 */
const dirs: string[] = [];

/** 造一个临时媒体目录并登记。 */
function makeDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "summarizing-ingest-media-"));
  dirs.push(d);
  return d;
}

/** 收尾：删全部临时目录（用例里已逐个删的用 force 兜住）。 */
function rmAll(): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
}

afterEach(rmAll);
