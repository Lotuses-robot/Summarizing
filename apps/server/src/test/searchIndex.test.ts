import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Identity } from "@summarizing/shared";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";
import { tokenizeContent } from "../search/tokenize";

// FTS5 索引（D-127）：写入即入索引、原文逐字不动、存量回填、脏形态不炸。

/** 造一条批次（索引由 insertRawInput 同一次写入）。 */
function seed(
  db: ReturnType<typeof makeDb>,
  content: string,
  identity: Identity,
  receivedAt = "2026-10-20T10:00:00",
): string {
  const raw = repo.insertRawInput(db, {
    content,
    source: "nc",
    identity,
    receivedAt,
    eventTime: null,
  });
  return raw.id;
}

/** 用 MATCH 直接查索引命中的批次 id（绕过工具层，专测索引本身）。 */
function matchIds(db: ReturnType<typeof makeDb>, expr: string): string[] {
  return db.$client
    .prepare("SELECT raw_id AS id FROM raw_fts WHERE raw_fts MATCH ?")
    .all(expr)
    .map((r) => (r as { id: string }).id)
    .sort();
}

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows WAL 句柄——临时目录自会回收
    }
  }
});

describe("FTS5 索引", () => {
  it("写入即入索引：切词后能 MATCH 命中", () => {
    const db = makeDb(":memory:");
    const id = seed(db, "图书馆闭馆通知", { displayName: "班级通知群" });
    expect(matchIds(db, '"闭馆"')).toEqual([id]);
  });

  it("原文逐字不动（索引只读原文，不回写 content）", () => {
    const db = makeDb(":memory:");
    const original = "！！图书馆闭馆通知【重要】  \n 第二行";
    const id = seed(db, original, { displayName: "群" });
    expect(repo.getRawInput(db, id)?.content).toBe(original);
  });

  it("部分关键词可搜（身份词袋切词后「课群」命中「英语课群」）", () => {
    const db = makeDb(":memory:");
    const id = seed(db, "无关正文", { displayName: "英语课群" });
    // 身份词袋里含「课群」二元组——未切词的 JSON 列搜不到这个内部子串（实测）
    expect(matchIds(db, '"课群"')).toEqual([id]);
  });

  it("身份键名也可搜（搜 groupId 能找到所有带群号的身份）", () => {
    const db = makeDb(":memory:");
    const a = seed(db, "第一条", { displayName: "群A", groupId: "10001" });
    const b = seed(db, "第二条", { displayName: "群B", groupId: "10002" });
    expect(matchIds(db, '"groupId"')).toEqual([a, b].sort());
  });

  it("图片占位的 URL 不进索引（搜 rkey 不命中）", () => {
    const db = makeDb(":memory:");
    seed(db, "[图片](https://multimedia.n.qq.com.cn/download?rkey=abc123)", { displayName: "群" });
    expect(matchIds(db, '"rkey"')).toEqual([]);
    expect(matchIds(db, '"图片"')).toHaveLength(1);
  });

  it("空正文/纯标点：写入不炸，索引行存在但不匹配任何词", () => {
    const db = makeDb(":memory:");
    const id = seed(db, "！！！", { displayName: "群" });
    expect(matchIds(db, '"通知"')).toEqual([]);
    // 行仍在（检索面靠 raw_inputs 而非索引，索引为空只是不命中）
    expect(repo.getRawInput(db, id)).not.toBeNull();
  });

  it("多条批次各有各的索引（互不串味）", () => {
    const db = makeDb(":memory:");
    const a = seed(db, "图书馆闭馆", { displayName: "群A" });
    const b = seed(db, "高数作业", { displayName: "群B" });
    expect(matchIds(db, '"闭馆"')).toEqual([a]);
    expect(matchIds(db, '"作业"')).toEqual([b]);
  });

  it("内容存在但索引列被清空（外部改库）→ 下次开库时按行数不一致重建", () => {
    const file = `:memory:`;
    const db = makeDb(file);
    const id = seed(db, "图书馆闭馆", { displayName: "群" });
    // 模拟历史遗漏：索引行没了
    db.$client.prepare("DELETE FROM raw_fts").run();
    expect(matchIds(db, '"闭馆"')).toEqual([]);
    // 同一进程内不会再跑 backfill（它只在开库时跑）——这里直接重建以验证 SQL 正确性
    db.$client.exec(`
      INSERT INTO raw_fts(tokens, identity_tokens, raw_id)
      SELECT coalesce(tokens, ''), coalesce(identity_tokens, ''), id FROM raw_inputs
    `);
    expect(matchIds(db, '"闭馆"')).toEqual([id]);
  });

  it("索引口径号落后 → 开库时全表重算（切词器改过的自愈路径）", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "summarizing-idx-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "u.db");

    // 第一次开库：写入一条，口径号随之落盘
    const db1 = makeDb(file);
    const id = seed(db1, "图书馆闭馆", { displayName: "群" });
    expect(matchIds(db1, '"闭馆"')).toEqual([id]);
    // 模拟「切词器改过」：把旧行的 tokens 改成过时的内容，并把口径号改回 0
    db1.$client.prepare("UPDATE raw_inputs SET tokens = '过期词' WHERE id = ?").run(id);
    db1.$client.exec("DELETE FROM raw_fts");
    db1.$client
      .prepare("INSERT INTO raw_fts(tokens, identity_tokens, raw_id) VALUES ('过期词', '', ?)")
      .run(id);
    db1.$client
      .prepare("UPDATE app_settings SET value = '0' WHERE key = 'search_index_version'")
      .run();
    db1.$client.close();

    // 再开库：口径号落后 → 全表重算 tokens 并重建索引
    const db2 = makeDb(file);
    expect(matchIds(db2, '"闭馆"')).toEqual([id]); // 新口径命中
    expect(matchIds(db2, '"过期词"')).toEqual([]); // 旧词条已清掉
    db2.$client.close();
  });

  it("口径号已是最新 → 开库不重算（避免每次开库全表切词）", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "summarizing-idx-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "u.db");

    const db1 = makeDb(file);
    const id = seed(db1, "图书馆闭馆", { displayName: "群" });
    // 手动改坏 tokens 但**不动口径号**：开库不该发现（结构一致、口径没变）
    db1.$client.prepare("UPDATE raw_inputs SET tokens = '人为改坏' WHERE id = ?").run(id);
    db1.$client.close();

    const db2 = makeDb(file);
    expect(matchIds(db2, '"图书馆"')).toEqual([id]); // 索引行还在（内容来自索引自身）
    const row = db2.$client.prepare("SELECT tokens FROM raw_inputs WHERE id = ?").get(id) as {
      tokens: string;
    };
    expect(row.tokens).toBe("人为改坏"); // 没被重算——证明开库没有跑全表切词
    db2.$client.close();
  });

  it("tokens 列内容与 tokenizeContent 一致（索引两处同源）", () => {
    const db = makeDb(":memory:");
    const content = "图书馆闭馆通知";
    const id = seed(db, content, { displayName: "群" });
    const row = db.$client.prepare("SELECT tokens FROM raw_inputs WHERE id = ?").get(id) as {
      tokens: string;
    };
    expect(row.tokens).toBe(tokenizeContent(content));
  });
});
