import { wallClockSchema, type SearchRawsArgs } from "@summarizing/shared";
import { tokenizeContent } from "./tokenize";

// 查询构造器（D-127）：维度 → SQL 的**唯一出处**。
//
// 为什么模糊与精确走两套机制：
//   模糊（关键词）= FTS5 MATCH 词袋——能命中「部分关键词」（搜「课群」命中「英语课群」），
//     代价是可能误伤（搜「高数」也命中「高数补考」）。
//   精确（identity 键值）= json_extract 等值——不误伤，但要求键名精确。
//   两者在同一工具里**天生共存**，由调用方选（mode=all 时同时满足）。
//
// 为什么跨字段并集必须 UNION：单条 FTS5 MATCH 只能在同一列（或同表多列）内取 OR，
//   「内容含 X **或** 群号是 Y」跨了 MATCH 与 json_extract 两套机制——只能两条查询取并集。
//
// 为什么键名不拼 SQL：json_extract 的**路径参数**支持绑定（实测），所以键名走 `?` 传参，
//   不经字符串拼接——白名单仍是第二道闸（防「键名是任意表达式」的写法误用）。
//
// 为什么回连用 raw_id 而不是 rowid：raw_fts 是**独立**的 FTS5 表，它的 rowid 与 raw_inputs 的
//   rowid 是两套互不相干的序列（删过批次、或 build 时补过行，就错位了）。索引用 raw_id 存批次
//   id，查询必须按它回连——按 rowid 回连会在任何一次删除后静默返回错误的批次（实测踩过）。

/** 可用于精确查询的身份键白名单（防注入的第二道闸；第一道是绑定参数）。
 *
 * 为何是白名单而不是「任意键」：身份字典是弹性字典，键由适配器定义（未来可能有任意键）；
 * 但 agent0 给的键名要拼进 JSON 路径，放开就等于让它构造任意 JSON 路径表达式。
 * 新增信源要按新键查询时，在此登记（一处改，两处生效：校验 + 错误文案）。 */
export const IDENTITY_KEY_WHITELIST = [
  "displayName",
  "groupId",
  "peer",
  "sender",
  // 企业微信客服（D-128）：客服账号 + 外部联系人——这两个是它分流与精确定位的主键
  "openKfid",
  "externalUserId",
  // 微信消息（docs/14）：会话 id（群 `<数字>@chatroom` / 私聊对方 wxid）
  "conversationId",
] as const;

/** 单次检索的字面量上限（防止把整库拖进内存）。 */
const SQL_ROW_LIMIT = 500;

/** 校验失败的边界错误（文案即给 agent0 的正确用法）。 */
export class SearchRawsError extends Error {}

/** 关键词 → FTS5 MATCH 表达式（逐词加引号 + 前缀匹配）。
 *
 * 分组规则：**空格分隔的每个词是一组，组间 AND、组内 OR**。
 * - 组间 AND = 用户意图「这些词都要有」（搜「高数 作业」= 既要高数又要作业）。
 * - 组内 OR = 抵消 jieba 的多粒度切词——「高数作业」会切出 高数/数作/作业 等 token，
 *   要求全部命中就退化成短语精确匹配（「高数的作业」反而搜不到）；任一命中即可。
 *
 * 为什么加引号：`AND` / `OR` / `NOT` / `NEAR` 是 FTS5 语法词，AI 搜「OR 门」会语法错误。
 * 引号内的内容是**字面量**（实测 `"OR"` 不报错、只是搜不到）。
 *
 * 为什么后缀 `*`：jieba 会把「高数」这类词切碎，前缀匹配让「高」也能命中「高数」——
 * 这是 2 字词召回的最后一道保险。`*` 必须在引号**外**（实测 `"高*"` 是字面量、搜不到东西）。
 *
 * @param query 用户/模型给的关键词
 * @returns MATCH 表达式；切词后为空时返回 null（调用方按「无命中」处理，不报错）
 */
function toMatchExpr(query: string): string | null {
  const groups: string[] = [];
  for (const term of query.split(/\s+/).filter((t) => t !== "")) {
    const tokens = tokenizeContent(term)
      .split(" ")
      .filter((t) => t !== "");
    if (tokens.length === 0) continue;
    const quoted = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`);
    groups.push(quoted.length === 1 ? (quoted[0] ?? "") : `(${quoted.join(" OR ")})`);
  }
  return groups.length === 0 ? null : groups.join(" AND ");
}

/** 一个可执行的查询片段：SQL 文本 + 绑定参数。 */
export interface SqlFragment {
  sql: string;
  params: unknown[];
}

/** 时间边界的规范形（与库内 received_at 同形状，保证字典序 = 时间序）。
 *
 * 为什么要规范化：`received_at` 是 `YYYY-MM-DDTHH:mm:ss` 定宽串，比较走字符串序——
 * 直接拿调用方给的原文比较会有两个静默偏差：①只给日期 `"2026-10-21"` 时，`<= 2026-10-21`
 * 会排除那一天（字典序小于任何 `2026-10-21T…`）；②`:mm` 缺秒时上界少算 59 秒。
 * 这里统一成「该时刻在所表达的那一天里的真实边界」：只给日期 → after 取当日 00:00:00、
 * before 取当日 23:59:59；给了时刻则补足秒。
 * （格式本身由 wallClockSchema 在 validateSearchArgs 里把关——空格分隔、带 Z 等一律拒收，
 * 不在这里「纠正」：D-103，用户/模型该按约定填。） */
function normalizeWallClock(value: string, bound: "after" | "before"): string {
  const [d, t] = value.split("T");
  const date = d ?? value;
  if (t === undefined) return `${date}T${bound === "before" ? "23:59:59" : "00:00:00"}`;
  const parts = t.split(":");
  const hh = parts[0] ?? "00";
  const mm = parts[1] ?? "00";
  const ss = parts[2] ?? (bound === "before" ? "59" : "00");
  return `${date}T${hh}:${mm}:${ss}`;
}

/** 校验参数边界（D-103：不替用户改输入，越界就报错并说明正确用法）。
 *
 * @param args 工具入参
 * @throws SearchRawsError 任一约束不满足
 */
export function validateSearchArgs(args: SearchRawsArgs): void {
  const { query, before, after, limit, mode, identity } = args;
  if (query !== undefined && query.length > 200) {
    throw new SearchRawsError(
      "关键词太长（上限 200 字）——请给更具体的关键词，或改用 source / 时间缩小范围",
    );
  }
  for (const [name, v] of [
    ["before", before],
    ["after", after],
  ] as const) {
    if (v !== undefined && !wallClockSchema.safeParse(v).success) {
      throw new SearchRawsError(
        `时间格式不对（${name}）——用 +08:00 墙钟串，如 2026-10-21T23:59:59`,
      );
    }
  }
  if (before !== undefined && after !== undefined) {
    const b = Date.parse(`${normalizeWallClock(before, "before")}+08:00`);
    const a = Date.parse(`${normalizeWallClock(after, "after")}+08:00`);
    if (b < a) throw new SearchRawsError("时间区间反了——before 要晚于 after");
    if (b - a > 90 * 86_400_000) {
      throw new SearchRawsError("时间跨度超过 90 天——请分段查，或改用 source / 关键词收窄");
    }
  }
  if (limit !== undefined && (limit <= 0 || !Number.isInteger(limit) || limit > 50)) {
    throw new SearchRawsError("limit 必须在 1~50 之间");
  }
  if (mode !== undefined && mode !== "all" && mode !== "any") {
    throw new SearchRawsError("mode 只能是 all（交集）或 any（并集）");
  }
  for (const cond of identity ?? []) {
    if (!(IDENTITY_KEY_WHITELIST as readonly string[]).includes(cond.key)) {
      throw new SearchRawsError(`不支持按该键查——可查的键：${IDENTITY_KEY_WHITELIST.join(" / ")}`);
    }
  }
  const hasAny =
    (query !== undefined && query.trim() !== "") ||
    (args.source !== undefined && args.source.trim() !== "") ||
    (identity !== undefined && identity.length > 0) ||
    before !== undefined ||
    after !== undefined;
  if (!hasAny) {
    throw new SearchRawsError("至少给一个条件（关键词 / 信源 / 身份 / 时间）");
  }
}

/** 单个维度 → 一条 WHERE 片段；该维度没给值、或给了但切词后为空 → null。 */
function conditionFragment(
  kind: "query" | "source" | "identity",
  args: SearchRawsArgs,
): SqlFragment | null {
  if (kind === "query") {
    const q = args.query?.trim();
    if (q === undefined || q === "") return null;
    const expr = toMatchExpr(q);
    if (expr === null) return null;
    // 关键词同时搜内容与身份（AI 记不清「英语课群」是群名还是正文里的词——两处一起搜才自然）
    return {
      sql: "raw_inputs.id IN (SELECT raw_id FROM raw_fts WHERE raw_fts MATCH ?)",
      params: [`{tokens identity_tokens} : (${expr})`],
    };
  }
  if (kind === "source") {
    const src = args.source?.trim();
    if (src === undefined || src === "") return null;
    // source 维度两义：匹配信源种类（nc/chat/paste）**或**身份词袋里的值（群名等模糊）
    const expr = toMatchExpr(src);
    if (expr === null) return null;
    return {
      sql: "(raw_inputs.source = ? OR raw_inputs.id IN (SELECT raw_id FROM raw_fts WHERE raw_fts MATCH ?))",
      params: [src, `{identity_tokens} : (${expr})`],
    };
  }
  const conds = args.identity ?? [];
  if (conds.length === 0) return null;
  // 精确条件之间恒为 AND（同一个键给两次 = 两个约束；矛盾时自然 0 命中，不报错）
  const parts = conds.map(() => "json_extract(raw_inputs.identity_json, ?) = ?");
  const params: unknown[] = [];
  for (const c of conds) {
    params.push(`$."${c.key}"`, c.value);
  }
  return { sql: `(${parts.join(" AND ")})`, params };
}

/** 时间区间片段（received_at 普通列比较：+08:00 墙钟字典序 = 时间序）。 */
function timeFragment(args: SearchRawsArgs): SqlFragment | null {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (args.after !== undefined) {
    parts.push("raw_inputs.received_at >= ?");
    params.push(normalizeWallClock(args.after, "after"));
  }
  if (args.before !== undefined) {
    parts.push("raw_inputs.received_at <= ?");
    params.push(normalizeWallClock(args.before, "before"));
  }
  return parts.length === 0 ? null : { sql: `(${parts.join(" AND ")})`, params };
}

/** 该维度是否被显式给了值（区别于「编译不出 SQL」——两者对交/并语义影响不同）。 */
function isRequested(kind: "query" | "source" | "identity", args: SearchRawsArgs): boolean {
  if (kind === "query") return args.query !== undefined && args.query.trim() !== "";
  if (kind === "source") return args.source !== undefined && args.source.trim() !== "";
  return (args.identity ?? []).length > 0;
}

/** 编译结果：可执行的分支 + 是否必然空集 + 时间限定。 */
interface Compiled {
  /** 能变成 SQL 的条件分支（每条 = 一个 WHERE 片段） */
  branches: SqlFragment[];
  /** 交集模式下的 `true` = 某个给了值的条件**无法变成 SQL**（如关键词全是单字/标点，切词为空）。
   *  交集里出现不可满足的条件 → 结果必然为空。这种情况必须显式返回空集：早先的实现会拼出
   *  `WHERE  ORDER BY …`（语法错，SQL 报错直接喂给模型）或 `WHERE 1=1`（**把整库当命中返回**，
   *  静默的错答案）。 */
  empty: boolean;
  /** 时间条件是「所有分支的共同限定」，不参与并集（否则「任一条件满足」会把整个时间窗捞出来） */
  time: SqlFragment | null;
}

/** 汇总各维度，并按 mode 判断是否必然空集。
 *
 * 交/并的区别是实质的：**交集中一个不可满足的条件让整体为空**（A ∧ 无法表达 = 空），
 * 而**并集里它只是「没有贡献」**（A ∨ 无法表达 = A）——不能一律当成空集。
 */
function compile(args: SearchRawsArgs): Compiled {
  const time = timeFragment(args);
  const requested = (["query", "source", "identity"] as const).filter((k) => isRequested(k, args));
  const branches = requested
    .map((k) => conditionFragment(k, args))
    .filter((f): f is SqlFragment => f !== null);
  if ((args.mode ?? "all") === "all") {
    return { branches, empty: branches.length < requested.length, time };
  }
  // 并集：编译不出的维度只是没有贡献；全都没贡献、又没时间限定 → 无内容可查
  return { branches, empty: branches.length === 0 && time === null, time };
}

/** 把检索条件编译成 id 查询（按接收时间倒序，带上字面量上限）。
 *
 * @param args 工具入参（已过 validateSearchArgs）
 * @returns id 查询与绑定参数
 */
export function buildSearchSql(args: SearchRawsArgs): SqlFragment {
  return buildIdSql(args, true);
}

/** 统计命中总数——与 buildSearchSql **同一套条件**，但**不加 LIMIT**
 *  （否则 total 在 500 处饱和、more 系统性少报，模型会以为「就这么多」而停止收窄）。 */
export function buildCountSql(args: SearchRawsArgs): SqlFragment {
  const inner = buildIdSql(args, false);
  return { sql: `SELECT count(*) AS n FROM (${inner.sql})`, params: inner.params };
}

/** id 查询的唯一构造处（buildSearchSql / buildCountSql 共用，保证两者条件永不漂移）。
 * @param args 工具入参
 * @param withLimit 是否加字面量上限（count 不要）
 */
function buildIdSql(args: SearchRawsArgs, withLimit: boolean): SqlFragment {
  const { branches, empty, time } = compile(args);
  if (empty) {
    // 显式空集：条件给了但无从执行（切词后为空）——不能退化成「不限条件」
    return { sql: "SELECT raw_inputs.id AS id FROM raw_inputs WHERE 0", params: [] };
  }
  const limit = withLimit ? ` LIMIT ${SQL_ROW_LIMIT}` : "";
  const baseSelect =
    "SELECT raw_inputs.id AS id, raw_inputs.received_at AS received_at FROM raw_inputs";

  if ((args.mode ?? "all") === "all") {
    const where = [...branches.map((b) => b.sql), time?.sql].filter(
      (w): w is string => w !== undefined,
    );
    return {
      sql: `${baseSelect} WHERE ${where.join(" AND ")} ORDER BY raw_inputs.received_at DESC${limit}`,
      params: [...branches.flatMap((b) => b.params), ...(time?.params ?? [])],
    };
  }

  // mode=any：各分支并集；时间仍作共同限定。
  // 没有可执行分支时只剩时间这个共同限定（compile 已保证：无分支且无时间 → empty）
  if (branches.length === 0) {
    return {
      sql: `${baseSelect} WHERE ${time?.sql ?? "0"} ORDER BY raw_inputs.received_at DESC${limit}`,
      params: time?.params ?? [],
    };
  }
  const unified = branches
    .map((b) => {
      const where = [b.sql, time?.sql].filter((x): x is string => x !== undefined).join(" AND ");
      return `${baseSelect} WHERE ${where}`;
    })
    .join(" UNION ");
  return {
    // 排序用 received_at（不是 id——id 是随机 uuid，按它排等于随机取子集）
    sql: `SELECT id FROM (${unified}) ORDER BY received_at DESC${limit}`,
    params: branches.flatMap((b) => [...b.params, ...(time?.params ?? [])]),
  };
}
