import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { makeDb } from "../storage/db";
import { SCHEMA_VERSION, readSchemaVersion, restoreFromBackup } from "../storage/migrate";

// schema 迁移三件套（批次 2）：版本号门控 + 迁移前自动备份 + 保留 N 份 + 恢复。
// 用临时文件真库验证（":memory:" 无文件、不触发备份）。

const dirs: string[] = [];

/** 临时目录（afterEach 清理）。 */
function tmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "summarizing-mig-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe("schema 版本门控 + 迁移前备份", () => {
  it("新库：直接建表并写当前版本；不产生备份（库内版本 0 → 首次即 SCHEMA_VERSION）", () => {
    const file = path.join(tmpDir(), "new.db");
    const db = makeDb(file);
    expect(readSchemaVersion(db.$client)).toBe(SCHEMA_VERSION);
    db.$client.close();
    // 无 backup 目录（未迁移——新库首建不备份）
    expect(existsSync(path.join(path.dirname(file), "backup"))).toBe(false);
  });

  it("落后版本的老库：迁移前自动备份（文件名带旧版本）+ 迁移后写新版本", () => {
    const file = path.join(tmpDir(), "old.db");
    // 造一个「版本 0」的老库（无表——门控会补建）
    const raw = new Database(file);
    raw.pragma("journal_mode = WAL");
    raw.pragma("user_version = 0");
    raw.exec("CREATE TABLE legacy (id TEXT)"); // 留个痕迹
    raw.close();

    const db = makeDb(file); // 触发迁移：0 → SCHEMA_VERSION
    expect(readSchemaVersion(db.$client)).toBe(SCHEMA_VERSION);
    db.$client.close();

    const bdir = path.join(path.dirname(file), "backup");
    const backups = readdirSync(bdir).filter((f) => f.startsWith("old-v0-"));
    expect(backups).toHaveLength(1); // 迁移前备份（带旧版本 v0）
    // 备份内容是迁移前的库（含 legacy 表、无新表）
    const bak = new Database(path.join(bdir, backups[0] ?? ""));
    const hasLegacy = bak
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy'")
      .get();
    const hasNew = bak
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='item_versions'")
      .get();
    expect(hasLegacy).not.toBeUndefined(); // 备份是「迁移前」快照
    expect(hasNew).toBeUndefined(); // 新表还没建
    bak.close();
  });

  it("版本持平：不备份（正常启动零开销）——反复开库不堆积备份", () => {
    const file = path.join(tmpDir(), "steady.db");
    makeDb(file).$client.close(); // 首建 = 当前版本
    makeDb(file).$client.close(); // 再开 = 持平
    makeDb(file).$client.close();
    expect(existsSync(path.join(path.dirname(file), "backup"))).toBe(false);
  });

  it("保留最近 N 份：多次迁移只留最新 5 份", () => {
    const file = path.join(tmpDir(), "many.db");
    const raw = new Database(file);
    raw.pragma("user_version = 0");
    raw.exec("CREATE TABLE legacy (id TEXT)"); // 有表 = 老库（触发迁移备份）
    raw.close();
    // 造 6 个「老版本备份」占位（模拟多次迁移历史）
    const bdir = path.join(path.dirname(file), "backup");
    mkdirp(bdir);
    for (let i = 0; i < 6; i += 1) {
      const p = path.join(bdir, `many-v0-2026-01-0${i + 1}T00-00-00.db`);
      const d = new Database(p);
      d.close();
    }
    makeDb(file).$client.close(); // 触发一次迁移备份（总数变 7）→ 清到 5
    const left = readdirSync(bdir).filter((f) => f.startsWith("many-v0-"));
    expect(left.length).toBe(5);
  });

  it("restoreFromBackup：备份拷回目标并清 WAL 残留", () => {
    const dir = tmpDir();
    const file = path.join(dir, "live.db");
    const db = makeDb(file);
    db.$client.close();
    // 造一个备份（当前库即内容）
    const bak = path.join(dir, "backup-snapshot.db");
    copy(file, bak);
    // 破坏 live（删内容后恢复）
    rmSync(file, { force: true });
    expect(existsSync(file)).toBe(false);
    restoreFromBackup(bak, file);
    expect(existsSync(file)).toBe(true);
    // 恢复后是合法 SQLite
    const check = new Database(file, { readonly: true });
    expect(
      check
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='item_versions'")
        .get(),
    ).not.toBeUndefined();
    check.close();
  });
});

/** 递归建目录（测试小工具）。 */
function mkdirp(p: string): void {
  mkdirSync(p, { recursive: true });
}
/** 拷文件（测试小工具）。 */
function copy(from: string, to: string): void {
  copyFileSync(from, to);
}
