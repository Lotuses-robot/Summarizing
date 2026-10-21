import Database from "better-sqlite3";
import { z } from "zod";

// 公开状态面板的只读聚合（011）：**绝不走 openGatedDb**——它会建表/迁移。
// 这里以 readonly 打开账户库，读完即关；打不开/不是用户库 → 抛给上层记 failed；
// 单个指标缺表（旧 schema 尚未迁移，如停用账户）→ 该指标按 0（概念当时不存在），不判整库失败。
// 不 select 任何内容列——只碰计数、状态、时间、token 原始数（FR-009 的边界在 SQL 这一层就收住）。

/** 一次查询的 token 原始和（prompt 含缓存部分；cached 全 NULL 才是 null）。 */
export interface TokenSums {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
}

/** 单个账户库的聚合结果（字段全部来自计数/求和，不含任何内容）。 */
export interface UserDbStats {
  rawToday: number;
  /** 今日进站的批次里，**当前状态**已消化 / 未处理的数量（按 raw_inputs.digest_state 算）。 */
  digestedToday: number;
  failedToday: number;
  callsToday: number;
  pending: number;
  digesting: number;
  failedRaw: number;
  tasks: number;
  notices: number;
  trashed: number;
  /** 最后版本形状不合法的事项数（status/kind 不在枚举内或快照不是 JSON）——计入 degraded，不猜归类。 */
  malformedItems: number;
  mediaCount: number;
  mediaBytes: number;
  usageToday: TokenSums;
  usageTotal: TokenSums;
}

/** 空 token 和（表不存在 = 旧 schema 还没有这个概念）。 */
function emptyTokenSums(): TokenSums {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: null };
}

/** SQLite「表/列不存在」——旧 schema 的正常形态，按 0 处理；其它错误（损坏/锁死）照抛。 */
function isMissingSchemaError(err: unknown): boolean {
  return err instanceof Error && /no such (table|column):/i.test(err.message);
}

/** 跑一条聚合查询并解析；缺表/缺列 → 返回 fallback，其余错误照抛（上层记 failed）。 */
function queryOr<T>(
  db: Database.Database,
  parse: (rows: unknown[]) => T,
  fallback: T,
  sql: string,
  params: unknown[] = [],
): T {
  try {
    return parse(db.prepare(sql).all(...params));
  } catch (err) {
    if (isMissingSchemaError(err)) return fallback;
    throw err;
  }
}

/** 单值计数/求和查询（聚合 SQL 必有一行；SUM 为 NULL 时按 0）。 */
function scalarQuery(
  db: Database.Database,
  sql: string,
  params: unknown[] = [],
  fallback = 0,
): number {
  return queryOr(
    db,
    (rows) => {
      const row = z.object({ v: z.number().nullable() }).parse(rows[0]);
      return row.v ?? 0;
    },
    fallback,
    sql,
    params,
  );
}

/** 该库是否像一份用户库（v1 起就存在的核心表都在）。空文件/别的 SQLite 文件 → 不算用户库。 */
function isUserDb(db: Database.Database): boolean {
  const rows = z
    .object({ name: z.string() })
    .array()
    .parse(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('raw_inputs', 'item_versions')",
        )
        .all(),
    );
  return rows.length === 2;
}

/** 读一段 token 原始和（可选起点；表不存在按空）。 */
function readTokenSums(db: Database.Database, since: string | null): TokenSums {
  const where = since === null ? "" : "WHERE at >= ?";
  const params = since === null ? [] : [since];
  return queryOr(
    db,
    (rows) => {
      const row = z
        .object({
          prompt: z.number().nullable(),
          completion: z.number().nullable(),
          cached: z.number().nullable(),
        })
        .parse(rows[0]);
      return {
        promptTokens: row.prompt ?? 0,
        completionTokens: row.completion ?? 0,
        cachedTokens: row.cached,
      };
    },
    emptyTokenSums(),
    `SELECT
       coalesce(sum(prompt_tokens), 0) AS prompt,
       coalesce(sum(completion_tokens), 0) AS completion,
       sum(cached_tokens) AS cached
     FROM llm_usage ${where}`,
    params,
  );
}

/** 只读打开一个账户库并聚合（读完即关；打不开/非用户库直接抛）。 */
export function readUserDbStats(file: string, since: string): UserDbStats {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (!isUserDb(db)) throw new Error("不是有效的用户库（缺少核心表）");

    const queue = queryOr(
      db,
      (rows) =>
        z
          .object({ state: z.string(), n: z.number() })
          .array()
          .parse(rows)
          .reduce<Record<string, number>>((acc, r) => {
            acc[r.state] = r.n;
            return acc;
          }, {}),
      {},
      "SELECT digest_state AS state, count(*) AS n FROM raw_inputs GROUP BY digest_state",
    );

    const itemCounts = queryOr(
      db,
      (rows) =>
        z
          .object({
            tasks: z.number(),
            notices: z.number(),
            trashed: z.number(),
            malformed: z.number(),
          })
          .parse(rows[0]),
      { tasks: 0, notices: 0, trashed: 0, malformed: 0 },
      `SELECT
         coalesce(sum(CASE WHEN v.status IN ('todo', 'done') AND v.kind = 'task' THEN 1 ELSE 0 END), 0) AS tasks,
         coalesce(sum(CASE WHEN v.status IN ('todo', 'done') AND v.kind = 'notice' THEN 1 ELSE 0 END), 0) AS notices,
         coalesce(sum(CASE WHEN v.status = 'trashed' THEN 1 ELSE 0 END), 0) AS trashed,
         coalesce(sum(CASE WHEN v.status IS NULL OR v.status NOT IN ('todo', 'done', 'trashed')
                     OR v.kind NOT IN ('task', 'notice') THEN 1 ELSE 0 END), 0) AS malformed
       FROM (
         SELECT
           CASE WHEN json_valid(snapshot) THEN json_extract(snapshot, '$.status') END AS status,
           coalesce(CASE WHEN json_valid(snapshot) THEN json_extract(snapshot, '$.kind') END, 'task') AS kind
         FROM item_versions v0
         JOIN (SELECT item_id, max(rowid) AS r FROM item_versions GROUP BY item_id) last
           ON v0.item_id = last.item_id AND v0.rowid = last.r
       ) v`,
    );

    const media = queryOr(
      db,
      (rows) => z.object({ count: z.number(), bytes: z.number() }).parse(rows[0]),
      { count: 0, bytes: 0 },
      "SELECT count(*) AS count, coalesce(sum(size_bytes), 0) AS bytes FROM media",
    );

    return {
      rawToday: scalarQuery(db, "SELECT count(*) AS v FROM raw_inputs WHERE received_at >= ?", [
        since,
      ]),
      // 副标题描述的是「今天的进站」：按这些批次的**当前** digest_state 计。不用 pipeline_events
      // 的完成时刻——重试旧批次会产出「今日进站 0、已消化 5」这种自相矛盾的读数（2026-10-21 用户逮出）。
      digestedToday: scalarQuery(
        db,
        "SELECT count(*) AS v FROM raw_inputs WHERE received_at >= ? AND digest_state = 'digested'",
        [since],
      ),
      failedToday: scalarQuery(
        db,
        "SELECT count(*) AS v FROM raw_inputs WHERE received_at >= ? AND digest_state = 'failed'",
        [since],
      ),
      callsToday: scalarQuery(db, "SELECT count(*) AS v FROM llm_usage WHERE at >= ?", [since]),
      pending: queue["pending"] ?? 0,
      digesting: queue["digesting"] ?? 0,
      failedRaw: queue["failed"] ?? 0,
      tasks: itemCounts.tasks,
      notices: itemCounts.notices,
      trashed: itemCounts.trashed,
      malformedItems: itemCounts.malformed,
      mediaCount: media.count,
      mediaBytes: media.bytes,
      usageToday: readTokenSums(db, since),
      usageTotal: readTokenSums(db, null),
    };
  } finally {
    db.close();
  }
}

/** 跨账户合并 token 原始和：先加原始值、再算未命中（与 010 的 sumLlmUsage 同口径）；
 *  `cachedTokens` 只有所有账户的所有调用都没给时才为 null。 */
export function aggregateTokenTotals(list: TokenSums[]): {
  inputTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
} {
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens: number | null = null;
  for (const s of list) {
    promptTokens += s.promptTokens;
    completionTokens += s.completionTokens;
    if (s.cachedTokens !== null) cachedTokens = (cachedTokens ?? 0) + s.cachedTokens;
  }
  return {
    inputTokens: Math.max(0, promptTokens - (cachedTokens ?? 0)),
    completionTokens,
    cachedTokens,
  };
}

/** 一个账户累计流过的 token（未命中输入 + 输出 + 缓存命中）——排行榜口径。 */
export function tokenTotal(s: TokenSums): number {
  return (
    Math.max(0, s.promptTokens - (s.cachedTokens ?? 0)) + s.completionTokens + (s.cachedTokens ?? 0)
  );
}
