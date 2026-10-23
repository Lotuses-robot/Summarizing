import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { z } from "zod";
import { normalizeIdentity } from "@summarizing/shared";
import { tokenizeContent, tokenizeIdentity } from "../search/tokenize";
import * as schema from "./schema";
import { openGatedDb } from "./migrate";

// 单文件库 = 拷贝即备份（01§8.4）。data/ 已 gitignore。
// 建表走幂等 DDL（IF NOT EXISTS），文件库与测试内存库同源初始化。
// 批次 2：开库先过 schema 版本门控（落后 → 迁移前自动备份 → 迁移 → 写版本；见 migrate.ts）。

/** 打开并幂等建表一个 SQLite 库：":memory:" 供测试，文件库开 WAL；文件库=拷贝即备份（01§8.4）。 */
export function makeDb(file: string) {
  return drizzle(
    openGatedDb(file, (sqlite) => ensureSchema(sqlite)),
    { schema },
  );
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
      source TEXT NOT NULL,
      identity_json TEXT NOT NULL,
      received_at TEXT NOT NULL,
      event_time TEXT,
      digest_state TEXT NOT NULL DEFAULT 'pending',
      raw TEXT
    );
    CREATE TABLE IF NOT EXISTS pipeline_events (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      payload TEXT,
      at TEXT NOT NULL,
      by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pipeline_entity_idx ON pipeline_events (entity_id);
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
      source TEXT NOT NULL,
      identity_json TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS llm_usage (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      cached_tokens INTEGER
    );
    CREATE INDEX IF NOT EXISTS llm_usage_at_idx ON llm_usage (at);
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      origin_url TEXT
    );
    CREATE INDEX IF NOT EXISTS media_expires_idx ON media (expires_at);
    CREATE INDEX IF NOT EXISTS media_origin_idx ON media (origin_url);
  `);

  // 索引列（D-127）：老库无这两列——幂等补列。NULL 存量行的索引由 backfillSearchIndex 补齐。
  // ⚠️ 顺序有硬约束：**列必须先加**，下面的索引重建（backfillSearchIndex）才有地方写切词结果。
  addColumnIfMissing(sqlite, "raw_inputs", "tokens");
  addColumnIfMissing(sqlite, "raw_inputs", "identity_tokens");

  // FTS5 全文索引（D-127）：内容切词 + 身份词袋两列。
  // **普通（非外部内容）虚表 + 显式写入**，不用触发器——理由：
  //   ① raw_inputs **永不删除**（D-106 ③：彻底删只碰 item_versions/evidence/item_views），
  //      所以不存在「删行要清索引」的场景，触发器解决的是不存在的问题。
  //   ② 外部内容表（content='raw_inputs'）的 delete 语义要求传入值与索引里一致；存量行 tokens 为
  //      NULL 时先 UPDATE identity_json 会触发一次对不存在的索引项做 delete——实测直接报
  //      「database disk image is malformed」。用普通表 + 显式写入，就没有这种隐式耦合。
  // raw_id 用 UNINDEXED（只存不切词），查询按它回连带出原文。
  dropLegacyFtsIfNeeded(sqlite);
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS raw_fts USING fts5(
      tokens, identity_tokens, raw_id UNINDEXED
    );
  `);

  // ── 信源阶段迁移（D-84）——幂等，跑在老库上无害 ──
  // ① raw_inputs 补 raw 归档列（老库无此列）
  addColumnIfMissing(sqlite, "raw_inputs", "raw");

  // ── 术语改名迁移（D-127）：source_type → source、source_identity → identity_json ──
  // 列改名幂等：只在该表确实还带着旧列名时改（先例 renamePluginColumnIfNeeded）。
  renameColumnIfNeeded(sqlite, "raw_inputs", "source_type", "source");
  renameColumnIfNeeded(sqlite, "raw_inputs", "source_identity", "identity_json");
  renameColumnIfNeeded(sqlite, "uncertain_inputs", "source_type", "source");
  renameColumnIfNeeded(sqlite, "uncertain_inputs", "source_identity", "identity_json");

  // ② 存量 identity（裸字符串）→ 弹性字典 { displayName: 原串 }（不重置库）
  //    json_type('"abc"') = 'text'（JSON 字符串字面量），只转非 object 的存量行。
  //    保留键 D-88 由 name 改名 sourceLabel，D-127 再由 sourceLabel 改名 displayName——这里直接写新键。
  for (const table of ["raw_inputs", "uncertain_inputs"]) {
    sqlite.exec(`
      UPDATE ${table}
      SET identity_json = json_object('displayName', identity_json)
      WHERE json_valid(identity_json) = 0 OR json_type(identity_json) <> 'object'
    `);
  }
  // ③ 已迁成 { name: … } 的存量对象（D-84 早期迁移产物）→ 键改名 name → displayName。
  //    幂等：只动「有 name 键」的行；新库/已改名的行无 name 键，不受影响。
  for (const table of ["raw_inputs", "uncertain_inputs"]) {
    sqlite.exec(`
      UPDATE ${table}
      SET identity_json = json_set(
        json_remove(identity_json, '$.name'),
        '$.displayName', json_extract(identity_json, '$.name')
      )
      WHERE json_valid(identity_json) AND json_type(identity_json) = 'object'
        AND json_extract(identity_json, '$.name') IS NOT NULL
    `);
  }
  // ④ D-127：保留键 sourceLabel → displayName（json_set + json_remove，幂等）。
  //    只动确为对象且确有 sourceLabel 键的行；键序由 json_set 决定，与存量顺序无关。
  for (const table of ["raw_inputs", "uncertain_inputs"]) {
    sqlite.exec(`
      UPDATE ${table}
      SET identity_json = json_set(
        json_remove(identity_json, '$.sourceLabel'),
        '$.displayName', json_extract(identity_json, '$.sourceLabel')
      )
      WHERE json_valid(identity_json) AND json_type(identity_json) = 'object'
        AND json_extract(identity_json, '$.sourceLabel') IS NOT NULL
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

  // ── 版本署名迁移（D-88）：item_versions.by / pipeline_events.by 裸串 → 结构化 JSON ──
  // 存量裸串（agent0:flash / 前台:flash / sweep:api / user:手动 / system / sweep(...):agent0:x）
  // 解析成 {actor, model}；已是对象（json_valid 且 json_type=object）的不动。幂等。
  migrateByToProvenance(sqlite, "item_versions");
  migrateByToProvenance(sqlite, "pipeline_events");

  // ── 取消归档（007 / FR-018）：存量 status=archived 快照并入完成态（archived → done）──
  // 读路径 ItemSchema.status 收窄为 todo/done 后对 archived 零容忍——不迁则存量归档事项令
  // deriveItem/deriveItemsWithVersion 的 ItemSchema.parse 抛错、全站读路径 500。只改 status 值，
  // 不删版本链、不动其它字段。幂等（第二次无 archived 行，0 更新）。随 SCHEMA_VERSION=2 走迁移前自动备份。
  sqlite.exec(`
    UPDATE item_versions
    SET snapshot = json_set(snapshot, '$.status', 'done')
    WHERE json_valid(snapshot) AND json_extract(snapshot, '$.status') = 'archived'
  `);

  // ── 检索索引列补齐（D-127 / v6）：存量批次的 tokens / identity_tokens 为空（建表时还没有这两列）
  //    → 用切词模块算出来回填，再让 FTS5 重建索引。幂等：只为 NULL 行计算，重跑无写入。
  //    原文逐字不动（只读 content 算索引，写回的是新列）。
  backfillSearchIndex(sqlite);
}

/** 删掉旧形态的 raw_fts（外部内容表 + 触发器）——D-127 试行期的中间形态，已弃用。
 *
 * 为什么要显式处理：`CREATE VIRTUAL TABLE IF NOT EXISTS` 遇到同名旧表是**静默跳过**，
 * 于是旧形态会活下来、而新代码按普通表读写 → 查询报 `SQLITE_CORRUPT_VTAB`（实测：拿真库副本
 * 一开就炸）。判据取 sqlite_master 里的建表语句——含 `content='raw_inputs'` 即是旧形态。
 * 删掉即可：索引是**派生数据**，下面 backfillSearchIndex 会按 raw_inputs 重建。幂等。 */
function dropLegacyFtsIfNeeded(sqlite: Database.Database): void {
  const row = z
    .object({ sql: z.string().nullable() })
    .nullish()
    .parse(sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'raw_fts'").get());
  const createSql = row?.sql ?? null;
  if (createSql === null || !createSql.includes("content='raw_inputs'")) return;
  for (const trigger of ["raw_fts_ai", "raw_fts_ad", "raw_fts_au"]) {
    sqlite.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  sqlite.exec("DROP TABLE raw_fts");
}

/** 索引口径版本（**改切词器/改被切字段就 +1**）。
 *
 *  为什么需要它：一致性别的问题只有「索引行数与表行数、id 集合」这类**结构性**毛病查得出来；
 *  「切词器变了、旧行的 tokens 已经过时」在结构上完全合法（id 集合不变），探针永远返回 0，
 *  于是老档案会静默地只用旧词典可命中的词条匹配——agent0 拿到 `total:0` 就以为没有历史。
 *  改口径时 +1：开库发现库里的口径号落后 → **重算全部行的 tokens 并重建索引**（一次，之后回到零开销）。
 *
 *  存在 `app_settings` 的 `search_index_version` 键（不占 user_version：那是 schema 版本，
 *  两者变更节奏不同——改切词器不该触发迁移前备份；也不往 raw_inputs 里塞假行：那会污染批次列表）。 */
const SEARCH_INDEX_VERSION = 1;
/** 口径号在 `app_settings` 里的键。 */
const SEARCH_INDEX_VERSION_KEY = "search_index_version";

/** 读库里的索引口径号（缺失/坏值 → 0，即「从未记录」）。 */
function readSearchIndexVersion(sqlite: Database.Database): number {
  const row = z
    .object({ value: z.string() })
    .nullish()
    .parse(
      sqlite.prepare("SELECT value FROM app_settings WHERE key = ?").get(SEARCH_INDEX_VERSION_KEY),
    );
  const n = Number(row?.value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** 写索引口径号。 */
function writeSearchIndexVersion(sqlite: Database.Database): void {
  sqlite
    .prepare(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(SEARCH_INDEX_VERSION_KEY, String(SEARCH_INDEX_VERSION));
}

/** 存量批次的切词索引补齐 + FTS5 重建（幂等、**只在真需要时动手**）。
 *
 * 动手的三种情形（其余情况零开销——makeDb 在测试里被调用上百次，全量重算会拖成分钟级）：
 *   ① 有 tokens / identity_tokens 为 NULL 的行（建索引前的存量）→ 只补这些行；
 *   ② **索引口径号落后**（切词器或被切字段改过）→ 全表重算；
 *   ③ 结构与真实不变式不符（id 在索引里不是恰好一次 / 有孤儿行）→ 只重建，不重算。
 *
 * ⚠️ 判据必须是 O(n)，不能是 O(n²)：早期版本用「对每个 raw_inputs 行相关子查询一次 FTS」
 * 数不一致数——5000 行实测 1.9 秒，而 raw_inputs 永不删除，半年后每次开库都要付这个代价。 */
function backfillSearchIndex(sqlite: Database.Database): void {
  /** 按 rowid 重算一行的两个索引列。 */
  const update = sqlite.prepare(
    "UPDATE raw_inputs SET tokens = ?, identity_tokens = ? WHERE rowid = ?",
  );
  const staleVersion = readSearchIndexVersion(sqlite) < SEARCH_INDEX_VERSION;

  // ① 空索引列（口径变化时**全表**算，否则只算 NULL 行）
  const where = staleVersion ? "1=1" : "tokens IS NULL OR identity_tokens IS NULL";
  const nullRows = z
    .object({ rid: z.number(), content: z.string(), identity_json: z.string() })
    .array()
    .parse(
      sqlite
        .prepare(`SELECT rowid AS rid, content, identity_json FROM raw_inputs WHERE ${where}`)
        .all(),
    );
  if (nullRows.length > 0) {
    const tx = sqlite.transaction(() => {
      for (const { rid, content, identity_json } of nullRows) {
        update.run(
          tokenizeContent(content),
          tokenizeIdentity(normalizeIdentity(parseJsonOrText(identity_json))),
          rid,
        );
      }
    });
    tx();
  }

  // ② 结构一致性：两条 **集合差** 判据（各一次全表扫，无相关子查询）。
  //    索引是派生数据，用「索引里有几行」「表里有几行」数不一致是 O(n) 的；
  //    真正要防的是「id 在索引里重复 / 索引里有表里没有的 id」，这两条也各是一次 GROUP BY。
  const duplicateIds = z
    .object({ n: z.number() })
    .parse(
      sqlite
        .prepare(
          "SELECT count(*) AS n FROM (SELECT raw_id FROM raw_fts GROUP BY raw_id HAVING count(*) > 1)",
        )
        .get(),
    ).n;
  const orphans = z.object({ n: z.number() }).parse(
    sqlite
      .prepare(
        `SELECT count(*) AS n FROM raw_fts f
           WHERE NOT EXISTS (SELECT 1 FROM raw_inputs r WHERE r.id = f.raw_id)`,
      )
      .get(),
  ).n;
  if (nullRows.length === 0 && duplicateIds === 0 && orphans === 0 && !staleVersion) return; // 已对齐

  sqlite.exec("DELETE FROM raw_fts");
  sqlite.exec(`
    INSERT INTO raw_fts(tokens, identity_tokens, raw_id)
    SELECT coalesce(tokens, ''), coalesce(identity_tokens, ''), id FROM raw_inputs
  `);
  writeSearchIndexVersion(sqlite);
}

/** JSON 串 → 值；不是合法 JSON 就原样返回（存量裸字符串身份走这条）。 */
function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 某表若缺某列 → 补一列 TEXT（幂等；判据取 PRAGMA，**不用 try/catch 吞 ALTER 的错误**——
 *  那会把「database is locked」「disk I/O error」这类真故障记成「列已存在，正常」，故障延后到
 *  别处才炸。同款判据见 renameColumnIfNeeded。 */
function addColumnIfMissing(sqlite: Database.Database, table: string, column: string): void {
  const cols = z
    .object({ name: z.string() })
    .array()
    .parse(sqlite.prepare(`PRAGMA table_info(${table})`).all());
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
}

/** 某表若还带着旧列名 oldName → 补跑列改名（幂等：只在该列确实存在时改）。
 *  改名中断的中间态自愈用——数据无损但列名错位，drizzle 查新列名会响亮报错。 */
function renameColumnIfNeeded(
  sqlite: Database.Database,
  table: string,
  oldName: string,
  newName: string,
): void {
  const cols = z
    .object({ name: z.string() })
    .array()
    .parse(sqlite.prepare(`PRAGMA table_info(${table})`).all());
  if (cols.some((c) => c.name === oldName)) {
    sqlite.exec(`ALTER TABLE ${table} RENAME COLUMN ${oldName} TO ${newName}`);
  }
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
