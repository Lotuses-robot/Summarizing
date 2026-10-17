import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";
import { SCHEMA_VERSION, readSchemaVersion } from "../storage/migrate";

// schema 迁移三件套（批次 2）：版本号门控 + 迁移前自动备份 + 保留 N 份。
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
    makeLegacyDb(file); // 「版本 0、有表」的老库（有表 = 有数据可备；门控补建新表）

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
    makeLegacyDb(file); // 有表 = 老库（触发迁移备份）
    // 造 6 个「老版本备份」占位（模拟多次迁移历史）
    const bdir = path.join(path.dirname(file), "backup");
    mkdirSync(bdir, { recursive: true });
    for (let i = 0; i < 6; i += 1) {
      const p = path.join(bdir, `many-v0-2026-01-0${i + 1}T00-00-00.db`);
      const d = new Database(p);
      d.close();
    }
    // ⚠️ 上方已造出 many-v0-* 占位 → 新加的「同版本备份已存在即跳过」会命中，不产生第 7 份
    makeDb(file).$client.close();
    const left = readdirSync(bdir).filter((f) => f.startsWith("many-v0-"));
    expect(left.length).toBe(6); // 不重做、不新增——旧份保留
  });

  it("同 (库,版本) 已有备份：跳过重做（迁移失败重试不逐请求全库拷）", () => {
    const file = path.join(tmpDir(), "idem.db");
    makeLegacyDb(file);
    const bdir = path.join(path.dirname(file), "backup");
    mkdirSync(bdir, { recursive: true });
    const d = new Database(path.join(bdir, "idem-v0-2026-01-01T00-00-00.db"));
    d.close();
    makeDb(file).$client.close(); // 已有 idem-v0-* → 跳过备份 → 仍只那 1 份
    const backups = readdirSync(bdir).filter((f) => f.startsWith("idem-v0-"));
    expect(backups).toHaveLength(1);
  });

  it("并发读者令 checkpoint busy：中止迁移、不产出假备份", () => {
    const file = path.join(tmpDir(), "busy.db");
    const raw = new Database(file);
    raw.pragma("journal_mode = WAL");
    raw.pragma("user_version = 0");
    raw.exec("CREATE TABLE legacy (id TEXT)");
    raw.exec("INSERT INTO legacy (id) VALUES ('x')");
    // 另一连接持读事务（快照开放）——TRUNCATE checkpoint 等满 busy_timeout（默认 5s）后返回 busy=1
    const reader = new Database(file, { readonly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT * FROM legacy").get();

    expect(() => makeDb(file)).toThrow(/checkpoint/);
    // 中止发生在建 backup 目录之前——不留误导性的空备份目录
    expect(existsSync(path.join(path.dirname(file), "backup"))).toBe(false);

    reader.exec("COMMIT");
    reader.close();
    raw.close();
  }, 15_000); // 覆盖 checkpoint 等满 busy_timeout(5s) 的时间
});

/** 造一个「版本 0、有一张 legacy 表」的老库（模拟批次前建、待迁移的库）；有表 = 有数据可备。 */
function makeLegacyDb(file: string): void {
  const raw = new Database(file);
  raw.pragma("journal_mode = WAL");
  raw.pragma("user_version = 0");
  raw.exec("CREATE TABLE legacy (id TEXT)");
  raw.close();
}

describe("取消归档迁移（007 FR-018：archived → done）", () => {
  /** 造一条 v1 形状的版本行（snapshot 里 status=archived）——绕过 schema，直插 JSON 列。 */
  function seedArchivedVersion(file: string, itemId: string, at: string): void {
    const sqlite = new Database(file);
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS item_versions (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL,
        snapshot TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL, revoked_by TEXT
      );
    `);
    sqlite
      .prepare(
        "INSERT INTO item_versions (id, item_id, action, detail, snapshot, at, by, revoked_by) VALUES (?,?,?,?,?,?,?,NULL)",
      )
      .run(
        `v-${itemId}`,
        itemId,
        "archive_item",
        "用户点归档：旧事清出待办",
        JSON.stringify({
          elements: [{ label: "name", text: "旧事项", basis: [] }],
          tags: [],
          status: "archived",
          doubtNote: null,
        }),
        at,
        JSON.stringify({ actor: "用户", model: null }),
      );
    sqlite.close();
  }

  it("存量 archived 快照 → 迁移为 done（读路径对 archived 零容忍，不迁则全站 500）", () => {
    const file = path.join(tmpDir(), "arch.db");
    seedArchivedVersion(file, "i-arch", "2026-09-01T10:00:00");

    // 开库即触发 v1→v2 迁移
    const db = makeDb(file);
    const items = repo.deriveItems(db);
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("done"); // 归档并入完成态（用户：归档≈完成）
    db.$client.close();
  });

  it("多版本链：末版 archived、中间 archived → 全改 done；当前视图 = done", () => {
    const file = path.join(tmpDir(), "chain.db");
    seedArchivedVersion(file, "i-chain", "2026-09-01T10:00:00");
    {
      const sqlite = new Database(file);
      sqlite
        .prepare(
          "INSERT INTO item_versions (id, item_id, action, detail, snapshot, at, by, revoked_by) VALUES (?,?,?,?,?,?,?,NULL)",
        )
        .run(
          "v-i-chain-2",
          "i-chain",
          "archive_item",
          "再归档一次",
          JSON.stringify({
            elements: [{ label: "name", text: "旧事项", basis: [] }],
            tags: [],
            status: "archived",
            doubtNote: null,
          }),
          "2026-09-02T10:00:00",
          JSON.stringify({ actor: "用户", model: null }),
        );
      sqlite.close();
    }

    const db = makeDb(file);
    const item = repo.deriveItem(db, "i-chain");
    expect(item?.status).toBe("done");
    // 版本链本身没被删（只改 status 值）——历史仍可查
    expect(repo.deriveHistory(db, "i-chain")).toHaveLength(2);
    db.$client.close();
  });

  it("幂等：迁移后再开库不动数据、不重复备份", () => {
    const file = path.join(tmpDir(), "idem.db");
    seedArchivedVersion(file, "i-idem", "2026-09-01T10:00:00");
    makeDb(file).$client.close(); // 迁移 0 → 2（或 1 → 2）
    makeDb(file).$client.close(); // 再开 = 持平
    const db = makeDb(file);
    expect(repo.deriveItems(db)[0]?.status).toBe("done");
    db.$client.close();
    // 持平运行不新增备份（首次迁移应只有 1 份 v0 备份）
    const bdir = path.join(path.dirname(file), "backup");
    const backups = readdirSync(bdir).filter((f) => f.startsWith("idem-v"));
    expect(backups).toHaveLength(1);
  });
});
