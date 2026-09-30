import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { z } from "zod";
import * as schema from "./schema";

// 单文件库 = 拷贝即备份（01§8.4）。data/ 已 gitignore。
// 建表走幂等 DDL（IF NOT EXISTS），文件库与测试内存库同源初始化。

/** 打开并幂等建表一个 SQLite 库：":memory:" 供测试，文件库开 WAL；文件库=拷贝即备份（01§8.4）。 */
export function makeDb(file: string) {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const sqlite = new Database(file);
  if (file !== ":memory:") {
    sqlite.pragma("journal_mode = WAL");
  }
  ensureSchema(sqlite);
  return drizzle(sqlite, { schema });
}

/** 事务句柄：drizzle 事务回调给出，读/写方法齐全但无 $client。repo 函数接受 DbOrTx。 */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 读路径两者皆可；写路径建议 Tx（防事务内误传外层句柄——契约 §十点名的旧伤）。 */
export type DbOrTx = Db | Tx;

/** 把一批写操作包成一个原子事务：任一步抛错则整批回滚（drizzle 原生 transaction API）。 */
export function runInTransaction<T>(db: Db, fn: (tx: DbOrTx) => T): T {
  return db.transaction((tx) => fn(tx));
}

/** 幂等建表：schema.ts 是字段的唯一来源，这份 DDL 与其一字一句对应（改表先改 schema.ts）。 */
function ensureSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS item_versions (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      at TEXT NOT NULL,
      by TEXT NOT NULL,
      revoked_by TEXT
    );
    CREATE INDEX IF NOT EXISTS item_versions_item_idx ON item_versions (item_id, at);
    CREATE TABLE IF NOT EXISTS fragments (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      raw_input_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fragments_hash_idx ON fragments (content_hash);
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '元素:name',
      fragment_id TEXT NOT NULL,
      pointer TEXT,
      captured_at TEXT NOT NULL,
      captured_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS evidence_item_idx ON evidence (item_id);
    CREATE TABLE IF NOT EXISTS raw_inputs (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_identity TEXT NOT NULL,
      received_at TEXT NOT NULL,
      event_time TEXT,
      digest_state TEXT NOT NULL DEFAULT 'pending',
      raw TEXT
    );
    CREATE TABLE IF NOT EXISTS replay_nodes (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      payload TEXT,
      at TEXT NOT NULL,
      by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS replay_entity_idx ON replay_nodes (entity_type, entity_id);
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_settings (
      source TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (source, key)
    );
    CREATE TABLE IF NOT EXISTS uncertain_inputs (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_identity TEXT NOT NULL,
      event_time TEXT,
      received_at TEXT NOT NULL,
      origin_raw_input_id TEXT,
      needs_human TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolved_ref TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS uncertain_status_idx ON uncertain_inputs (status, needs_human);
    CREATE TABLE IF NOT EXISTS chat_turns (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_turns_at_idx ON chat_turns (at);
    CREATE TABLE IF NOT EXISTS item_views (
      item_id TEXT PRIMARY KEY,
      viewed_at TEXT NOT NULL
    );
  `);

  // ── 信源阶段迁移（D-84）——幂等，跑在老库上无害 ──
  // ① raw_inputs 补 raw 归档列（老库无此列；重复执行被 catch 吞掉）
  try {
    sqlite.exec("ALTER TABLE raw_inputs ADD COLUMN raw TEXT");
  } catch {
    // duplicate column name —— 列已存在，正常
  }
  // ② 存量 sourceIdentity（裸字符串）→ 弹性字典 { sourceLabel: 原串 }（不重置库）
  //    json_type('"abc"') = 'text'（JSON 字符串字面量），只转非 object 的存量行。
  //    保留键 D-88 由 name 改名 sourceLabel——这里直接写新键。
  sqlite.exec(`
    UPDATE raw_inputs
    SET source_identity = json_object('sourceLabel', source_identity)
    WHERE json_valid(source_identity) = 0 OR json_type(source_identity) <> 'object'
  `);
  // ③ 已迁成 { name: … } 的存量对象（D-84 早期迁移产物）→ 键改名 name → sourceLabel（D-88）。
  //    幂等：只动「有 name 键」的行；新库/已改名的行无 name 键，不受影响。
  for (const table of ["raw_inputs", "uncertain_inputs"]) {
    sqlite.exec(`
      UPDATE ${table}
      SET source_identity = json_set(
        json_remove(source_identity, '$.name'),
        '$.sourceLabel', json_extract(source_identity, '$.name')
      )
      WHERE json_valid(source_identity) AND json_type(source_identity) = 'object'
        AND json_extract(source_identity, '$.name') IS NOT NULL
    `);
  }

  // ── 术语改名迁移（D-88）：plugin_settings → source_settings（表名 + 列名 plugin → source）──
  // 仅当老表存在才动：老库 plugin_settings 有数据，且上面 DDL 已建了个同名空表 source_settings——
  // 先删空表再改名（保住数据）；新库无 plugin_settings，上面 DDL 建的 source_settings 原样用。
  // ⚠️ 降级旧版二进制再升回会丢新版期间的设置（DROP 重建）——单机单人接受此边缘，不为此做合并。
  const hasLegacy = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='plugin_settings'")
    .get();
  if (hasLegacy !== undefined) {
    sqlite.exec("DROP TABLE IF EXISTS source_settings");
    sqlite.exec("ALTER TABLE plugin_settings RENAME TO source_settings");
    renamePluginColumnIfNeeded(sqlite);
  } else {
    // 中间态自愈：表已改名但列名还停在 plugin（RENAME TO 与 RENAME COLUMN 之间崩溃过）——
    // 数据无损但列名错位，drizzle 查 source 会响亮报错；这里补跑改名让老库自愈。
    renamePluginColumnIfNeeded(sqlite);
  }

  // ── 版本署名迁移（D-88）：item_versions.by / replay_nodes.by 裸串 → 结构化 JSON ──
  // 存量裸串（agent0:flash / 前台:flash / sweep:api / user:手动 / system / sweep(...):agent0:x）
  // 解析成 {actor, model}；已是对象（json_valid 且 json_type=object）的不动。幂等。
  migrateByToProvenance(sqlite, "item_versions");
  migrateByToProvenance(sqlite, "replay_nodes");
}

/** source_settings 若还带着旧列名 plugin（改名中断的中间态）→ 补跑列改名（幂等）。 */
function renamePluginColumnIfNeeded(sqlite: Database.Database): void {
  const cols = z
    .object({ name: z.string() })
    .array()
    .parse(sqlite.prepare("PRAGMA table_info(source_settings)").all());
  if (cols.some((c) => c.name === "plugin")) {
    sqlite.exec("ALTER TABLE source_settings RENAME COLUMN plugin TO source");
  }
}

/** 存量 `by` 裸串 → 结构化 Provenance JSON（幂等：只动非 object 的行）。 */
function migrateByToProvenance(sqlite: Database.Database, table: string): void {
  // better-sqlite3 的 .all() 返回 unknown[]——行形状用 zod 运行时校验（不用 as 谎报，红线）
  const rows = z
    .object({ rid: z.number(), by: z.string() })
    .array()
    .parse(
      sqlite
        .prepare(
          `SELECT rowid AS rid, by FROM ${table} WHERE json_valid(by) = 0 OR json_type(by) <> 'object'`,
        )
        .all(),
    );
  const update = sqlite.prepare(`UPDATE ${table} SET by = ? WHERE rowid = ?`);
  for (const { rid, by } of rows) {
    update.run(JSON.stringify(parseLegacyBy(by)), rid);
  }
}

/** 把存量裸串署名解析成 `{actor, model}`——按已知旧取值显式映射（不靠通用拆分，防空壳）。
 *  旧值全集：`agent0:<model>` / `前台:<model>` / `sweep(<from>):agent0:<model>` / `sweep:<from>` /
 *  `user:手动` / `user:对话` / `system`。 */
function parseLegacyBy(raw: string): { actor: string; model: string | null } {
  // 空串/空白：无从解析，兜「未知」（ProvenanceSchema.actor 非空约束的对应物）
  if (raw.trim() === "") return { actor: "未知", model: null };
  // sweep(from):agent0:model —— 清扫的模型署名（旧格式带触发来源前缀）
  const sweep = /^sweep\(([^)]*)\):agent0:(.*)$/.exec(raw);
  if (sweep !== null) return { actor: `清扫(${sweep[1] ?? ""})`, model: sweep[2] || null };
  // sweep:from —— 清扫的汇总审计（无模型）
  const sweepAudit = /^sweep:(.*)$/.exec(raw);
  if (sweepAudit !== null) return { actor: `清扫(${sweepAudit[1] ?? ""})`, model: null };
  // user:* —— 用户经对话/手动触发的动作（旧串里冒号后是动作描述，不是模型）
  if (raw === "user:手动" || raw === "user:对话") return { actor: "用户", model: null };
  if (raw === "system") return { actor: "系统", model: null };
  // agent0:model / 前台:model —— 「actor:model」拆法；未知形状兜底为整串当 actor（不猜）
  const idx = raw.indexOf(":");
  const head = idx < 0 ? raw : raw.slice(0, idx);
  const tail = idx < 0 ? "" : raw.slice(idx + 1);
  if (head === "agent0" || head === "前台") return { actor: head, model: tail || null };
  return { actor: raw, model: null };
}

export type Db = ReturnType<typeof makeDb>;
