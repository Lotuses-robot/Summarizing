import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeSourceIdentity } from "@summarizing/shared";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";

// 信源阶段存量迁移（D-84）：老库的裸字符串 sourceIdentity → 弹性字典 { sourceLabel: 原串 }；
// raw_inputs 补 raw 列。用临时文件造「老库」，再走 makeDb 的 ensureSchema 自愈路径
// （与生产启动一字不差的同一条路径——不重复实现 DDL）。

/** 造一个「老版」库文件：raw_inputs 无 raw 列、source_identity 是裸字符串。返回文件路径。 */
function writeLegacyDbFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "summarizing-mig-"));
  const file = path.join(dir, "legacy.db");
  const sqlite = new Database(file);
  sqlite.exec(`
    CREATE TABLE raw_inputs (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_identity TEXT NOT NULL,
      received_at TEXT NOT NULL,
      event_time TEXT,
      digest_state TEXT NOT NULL DEFAULT 'pending'
    );
  `);
  sqlite
    .prepare(
      "INSERT INTO raw_inputs (id, content, source_type, source_identity, received_at, event_time, digest_state) VALUES (?,?,?,?,?,?,?)",
    )
    .run("r1", "老批次原文", "paste", "手机备忘录", "2026-09-20T10:00:00", null, "digested");
  sqlite.close();
  return file;
}

/** 清理临时目录；Windows 上 WAL 句柄可能仍占用，失败忽略（系统临时目录自会回收）。 */
function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // EPERM：sqlite WAL 文件仍被句柄占用——测试结束进程退出即释放，不入断言
  }
}

describe("存量迁移（D-84）：字符串身份 → 弹性字典", () => {
  it("老库裸字符串身份 → 迁移后读为 { sourceLabel: 原串 }（不重置库、原文未动）", () => {
    const file = writeLegacyDbFile();
    try {
      const db = makeDb(file); // ensureSchema 自愈：补 raw 列 + 迁移身份
      const raw = repo.getRawInput(db, "r1");
      if (!raw) throw new Error("存量批次丢失");
      expect(raw.sourceIdentity).toEqual({ sourceLabel: "手机备忘录" });
      expect(raw.content).toBe("老批次原文");
    } finally {
      cleanup(path.dirname(file));
    }
  });

  it("迁移幂等：对已迁移的库再开一次，不把 { sourceLabel } 再包一层", () => {
    const file = writeLegacyDbFile();
    try {
      makeDb(file); // 第一次迁移
      const db2 = makeDb(file); // 模拟重启，再跑一遍 ensureSchema
      expect(repo.getRawInput(db2, "r1")?.sourceIdentity).toEqual({ sourceLabel: "手机备忘录" });
    } finally {
      cleanup(path.dirname(file));
    }
  });

  it("normalizeSourceIdentity：坏形状兜底、对象原样", () => {
    expect(normalizeSourceIdentity({ sourceLabel: "群", groupId: "1" })).toEqual({
      sourceLabel: "群",
      groupId: "1",
    });
    expect(normalizeSourceIdentity("裸串")).toEqual({ sourceLabel: "裸串" });
    expect(normalizeSourceIdentity(42)).toEqual({ sourceLabel: "未知来源" });
    expect(normalizeSourceIdentity({ notName: 1 })).toEqual({ sourceLabel: "未知来源" });
    expect(normalizeSourceIdentity({ name: "旧群", groupId: "9" })).toEqual({
      sourceLabel: "旧群", // 旧保留键 name 漏网 → 升为 sourceLabel，其余键保留
      groupId: "9",
    });
  });
});

/** 造一个带旧表名 plugin_settings 的库文件（术语改名迁移的老库形态）。 */
function writeLegacyPluginSettingsDbFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "summarizing-mig-ps-"));
  const file = path.join(dir, "legacy.db");
  const sqlite = new Database(file);
  sqlite.exec(`
    CREATE TABLE plugin_settings (
      plugin TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (plugin, key)
    );
  `);
  sqlite
    .prepare("INSERT INTO plugin_settings (plugin, key, value) VALUES (?,?,?)")
    .run("nc", "windowMinutes", "5");
  sqlite.close();
  return file;
}

describe("术语改名迁移（D-88）：plugin_settings → source_settings", () => {
  it("老库的 plugin_settings 数据 → 改名后经 source_settings 读得到（不丢）", () => {
    const file = writeLegacyPluginSettingsDbFile();
    try {
      const db = makeDb(file); // ensureSchema 自愈：改写表名
      expect(repo.getSourceSetting(db, "nc", "windowMinutes")).toBe("5");
    } finally {
      cleanup(path.dirname(file));
    }
  });

  it("迁移幂等：对已改名的库再开一次，数据仍在（不会因二次 DROP 丢表）", () => {
    const file = writeLegacyPluginSettingsDbFile();
    try {
      makeDb(file); // 第一次迁移
      const db2 = makeDb(file); // 模拟重启，再跑一遍 ensureSchema
      expect(repo.getSourceSetting(db2, "nc", "windowMinutes")).toBe("5");
    } finally {
      cleanup(path.dirname(file));
    }
  });
});

/** 造一个 item_versions.by 是裸串的库文件（版本署名迁移的老库形态）。 */
function writeLegacyByDbFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "summarizing-mig-by-"));
  const file = path.join(dir, "legacy.db");
  const sqlite = new Database(file);
  sqlite.exec(`
    CREATE TABLE item_versions (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL,
      snapshot TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL, revoked_by TEXT
    );
  `);
  const snap = JSON.stringify({ elements: [], tags: [], status: "todo", doubtNote: null });
  const ins = sqlite.prepare(
    "INSERT INTO item_versions (id,item_id,action,detail,snapshot,at,by) VALUES (?,?,?,?,?,?,?)",
  );
  const raws = [
    ["v1", "agent0:deepseek-flash"],
    ["v2", "前台:deepseek-flash"],
    ["v3", "sweep:api"],
    ["v4", "user:手动"],
    ["v5", "system"],
    ["v6", "user:对话"],
    ["v7", "sweep(chat):agent0:deepseek-flash"],
  ] as const;
  for (const [id, by] of raws) {
    ins.run(id, "it1", "create_item", "d", snap, "2026-09-20T10:00:00", by);
  }
  sqlite.close();
  return file;
}

describe("版本署名迁移（D-88）：by 裸串 → { actor, model }", () => {
  it("5 种存量取值全解析成结构化（幂等）", () => {
    const file = writeLegacyByDbFile();
    try {
      const db = makeDb(file); // ensureSchema 自愈：迁移 by
      const history = repo.deriveHistory(db, "it1");
      const byId = new Map(history.map((v) => [v.id, v.by]));
      expect(byId.get("v1")).toEqual({ actor: "agent0", model: "deepseek-flash" });
      expect(byId.get("v2")).toEqual({ actor: "前台", model: "deepseek-flash" });
      expect(byId.get("v3")).toEqual({ actor: "清扫(api)", model: null });
      expect(byId.get("v4")).toEqual({ actor: "用户", model: null });
      expect(byId.get("v5")).toEqual({ actor: "系统", model: null });
      expect(byId.get("v6")).toEqual({ actor: "用户", model: null });
      expect(byId.get("v7")).toEqual({ actor: "清扫(chat)", model: "deepseek-flash" });

      // 幂等：再开一次不重复解析（已是 object 的行不动）
      const db2 = makeDb(file);
      expect(repo.deriveHistory(db2, "it1").find((v) => v.id === "v1")?.by).toEqual({
        actor: "agent0",
        model: "deepseek-flash",
      });
    } finally {
      cleanup(path.dirname(file));
    }
  });
});

/** 造一个 source_identity 已是 { name: … } 对象的库文件（D-84 早期迁移产物）。 */
function writeLegacyNameKeyDbFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "summarizing-mig-sl-"));
  const file = path.join(dir, "legacy.db");
  const sqlite = new Database(file);
  sqlite.exec(`
    CREATE TABLE raw_inputs (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, source_type TEXT NOT NULL,
      source_identity TEXT NOT NULL, received_at TEXT NOT NULL, event_time TEXT,
      digest_state TEXT NOT NULL DEFAULT 'pending', raw TEXT
    );
  `);
  sqlite
    .prepare(
      "INSERT INTO raw_inputs (id,content,source_type,source_identity,received_at,event_time,digest_state) VALUES (?,?,?,?,?,?,?)",
    )
    .run(
      "r1",
      "老批次",
      "nc",
      JSON.stringify({ name: "英语课官方群", groupId: "123", sender: "课代表" }),
      "2026-09-20T10:00:00",
      null,
      "digested",
    );
  sqlite.close();
  return file;
}

describe("保留键改名迁移（D-88）：name → sourceLabel", () => {
  it("存量 { name: … } 对象 → 键改名 sourceLabel（其余键保留，幂等）", () => {
    const file = writeLegacyNameKeyDbFile();
    try {
      const db = makeDb(file); // ensureSchema 自愈：键改名
      const raw = repo.getRawInput(db, "r1");
      if (!raw) throw new Error("存量批次丢失");
      expect(raw.sourceIdentity).toEqual({
        sourceLabel: "英语课官方群",
        groupId: "123",
        sender: "课代表",
      });

      // 幂等：再开一次不重复（已无 name 键）
      const db2 = makeDb(file);
      expect(repo.getRawInput(db2, "r1")?.sourceIdentity).toEqual({
        sourceLabel: "英语课官方群",
        groupId: "123",
        sender: "课代表",
      });
    } finally {
      cleanup(path.dirname(file));
    }
  });
});
