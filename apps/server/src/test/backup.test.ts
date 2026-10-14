import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { makeDb } from "../storage/db";
import { makeRegistryDb, listAccounts, createAccount } from "../storage/registry";
import { backupAll, backupDatabase, restoreAll, restoreDatabase } from "../storage/backup";
import { SCHEMA_VERSION, readSchemaVersion } from "../storage/migrate";

// 备份/恢复（批次 2）：在线 .backup API 一致性 + 往返还原 + 版本升级迁移的端到端。
// 用临时文件真库（":memory:" 无文件、不能备份）。

const dirs: string[] = [];

/** 临时目录（afterEach 清理）。 */
function tmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "summarizing-bak-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

/** 在一个库里建一张表并塞 n 行（模拟真实数据）。 */
function seed(file: string, n: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS seed (id INTEGER PRIMARY KEY, v TEXT)");
  const ins = db.prepare("INSERT INTO seed (v) VALUES (?)");
  for (let i = 0; i < n; i += 1) ins.run(`row-${i}`);
  db.close();
}

/** 读某库 seed 表行数（不存在返回 -1）。 */
function seedCount(file: string): number {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare("SELECT count(*) n FROM seed").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("在线备份（.backup API）", () => {
  it("备份一个正在被连接持有的 WAL 库：快照完整、与原库数据一致", async () => {
    const file = path.join(tmpDir(), "live.db");
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE t (a INTEGER)");
    db.prepare("INSERT INTO t VALUES (1)").run();
    // 保持连接开着（WAL 里有已提交内容未 checkpoint）——在线备份应仍拿到一致快照
    const dest = path.join(tmpDir(), "snap.db");
    await backupDatabase(file, dest);
    db.close();

    expect(existsSync(dest)).toBe(true);
    const check = new Database(dest, { readonly: true });
    expect(check.prepare("SELECT count(*) n FROM t").get()).toEqual({ n: 1 });
    check.close();
  });

  it("backupAll 逐库备 system.db + users/*.db（保留相对结构）", async () => {
    const root = tmpDir();
    seed(path.join(root, "system.db"), 1);
    const users = path.join(root, "users");
    seed(path.join(users, "a.db"), 2);
    seed(path.join(users, "b.db"), 3);

    const out = path.join(tmpDir(), "out");
    const written = await backupAll({ dataRoot: root }, out);
    expect(written.sort()).toEqual(
      ["system.db", path.join("users", "a.db"), path.join("users", "b.db")].sort(),
    );
    expect(seedCount(path.join(out, "system.db"))).toBe(1);
    expect(seedCount(path.join(out, "users", "a.db"))).toBe(2);
    expect(seedCount(path.join(out, "users", "b.db"))).toBe(3);
  });
});

describe("恢复", () => {
  it("restoreDatabase：覆盖 + 清 WAL 残留（不把恢复点之后的数据带回来）", async () => {
    const dir = tmpDir();
    const live = path.join(dir, "live.db");
    seed(live, 5);
    const snap = path.join(dir, "snap.db");
    await backupDatabase(live, snap);

    // 破坏 live：删表并留个 WAL（模拟恢复点之后又被写过）
    const db = new Database(live);
    db.pragma("journal_mode = WAL");
    db.exec("DROP TABLE seed");
    db.close();
    writeFileSync(live + "-wal", Buffer.alloc(0)); // 残留 WAL 占位

    restoreDatabase(snap, live);
    expect(existsSync(live + "-wal")).toBe(false); // WAL 残留已清（读库前断言——开库会重建 WAL）
    expect(seedCount(live)).toBe(5); // 回到备份点
  });

  it("restoreAll：整树还原（system.db + users/*.db）", async () => {
    const root = tmpDir();
    seed(path.join(root, "system.db"), 1);
    seed(path.join(root, "users", "a.db"), 2);

    const out = path.join(tmpDir(), "out");
    await backupAll({ dataRoot: root }, out);

    // 破坏当前数据
    seed(path.join(root, "system.db"), 100);
    rmSync(path.join(root, "users", "a.db"));

    const replaced = restoreAll({ dataRoot: root }, out);
    expect(replaced.sort()).toEqual(["system.db", path.join("users", "a.db")].sort());
    expect(seedCount(path.join(root, "system.db"))).toBe(1);
    expect(seedCount(path.join(root, "users", "a.db"))).toBe(2);
  });
});

describe("端到端：备份 → 升级迁移 → 恢复", () => {
  it("旧版本库备份后，经版本迁移，可恢复到迁移前状态", async () => {
    const root = tmpDir();
    const users = path.join(root, "users");
    const uid = "7fa32be796c9eb0b";
    const userFile = path.join(users, `${uid}.db`);

    // 造一个「老库」：有用户表数据 + 版本 0（模拟升级前）
    mkdirSync(path.dirname(userFile), { recursive: true });
    const raw = new Database(userFile);
    raw.pragma("journal_mode = WAL");
    raw.pragma("user_version = 0");
    raw.exec("CREATE TABLE legacy (id TEXT)");
    raw.exec("INSERT INTO legacy VALUES ('x'), ('y')");
    raw.close();
    seed(path.join(root, "system.db"), 1);

    // 1) 升级前在线备份
    const out = path.join(tmpDir(), "pre-upgrade");
    await backupAll({ dataRoot: root }, out);
    // 备份里是「迁移前」的库：有 legacy 表、无新 schema 表
    const preBak = new Database(path.join(out, "users", `${uid}.db`), { readonly: true });
    expect(preBak.prepare("SELECT count(*) n FROM legacy").get()).toEqual({ n: 2 });
    expect(
      preBak
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='item_versions'")
        .get(),
    ).toBeUndefined(); // 新表还没建
    preBak.close();

    // 2) 触发升级迁移（makeDb 过版本门控：0 → SCHEMA_VERSION）
    const upgraded = makeDb(userFile);
    expect(readSchemaVersion(upgraded.$client)).toBe(SCHEMA_VERSION);
    upgraded.$client.close();

    // 3) 从备份恢复 → 回到迁移前（版本 0、只有 legacy 表）
    restoreAll({ dataRoot: root }, out);
    const restored = new Database(userFile, { readonly: true });
    expect(restored.pragma("user_version", { simple: true })).toBe(0);
    expect(restored.prepare("SELECT count(*) n FROM legacy").get()).toEqual({ n: 2 }); // 迁移前的数据还在
    restored.close();
  });
});

describe("运维命令层（backup/restore 走 registry 之外）", () => {
  it("backup 命令落默认 backups/<北京戳>/ 且不动 registry；restore 命令还原", async () => {
    const { runAdmin } = await import("../cli/admin");
    const root = tmpDir();
    // 真造一个 registry（含一个账户）+ 一个用户库
    const registry = makeRegistryDb(path.join(root, "system.db"));
    const account = createAccount(registry, {
      username: "alice",
      passwordHash: "x".repeat(64),
    });
    registry.$client.close();
    seed(path.join(root, "users", `${account.uid}.db`), 3);

    const logs: string[] = [];
    const io = {
      prompt: () => Promise.resolve(""),
      log: (l: string) => {
        logs.push(l);
      },
    };
    // backup 到显式目录（--out 照旧支持；restore 必须能按同一目录还原）
    const out = path.join(tmpDir(), "ops-backup");
    await runAdmin(["backup", "--out", out], { dataRoot: root, io });
    expect(existsSync(path.join(out, "system.db"))).toBe(true);
    expect(existsSync(path.join(out, "users", `${account.uid}.db`))).toBe(true);
    expect(logs.some((l) => l.includes("已备份"))).toBe(true);

    // 破坏账户名，再 restore 回来
    const reg2 = makeRegistryDb(path.join(root, "system.db"));
    reg2.$client.prepare("UPDATE accounts SET username='changed'").run();
    reg2.$client.close();

    await runAdmin(["restore", out], { dataRoot: root, io });
    const reg3 = makeRegistryDb(path.join(root, "system.db"));
    expect(listAccounts(reg3).map((a) => a.username)).toContain("alice");
    reg3.$client.close();
  });

  it("默认备份目录 = dataRoot/backups/<北京时间戳>（容器里才留得住——审查 2026-10-14）", async () => {
    const { runAdmin } = await import("../cli/admin");
    const root = tmpDir();
    const reg = makeRegistryDb(path.join(root, "system.db"));
    reg.$client.close();
    const io = { prompt: () => Promise.resolve(""), log: () => {} };
    await runAdmin(["backup"], { dataRoot: root, io });
    const stamps = readdirSync(path.join(root, "backups"));
    expect(stamps.some((s) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(s))).toBe(true);
    // 备份落在 dataRoot 内（容器里 dataRoot=/app/data 是挂载点——落在外面容器重建即丢）
    expect(existsSync(path.join(root, "backups", stamps[0] ?? "", "system.db"))).toBe(true);
  });
});
