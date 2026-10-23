import { describe, expect, it } from "vitest";
import {
  buildCountSql,
  buildSearchSql,
  IDENTITY_KEY_WHITELIST,
  SearchRawsError,
  validateSearchArgs,
} from "../search/query";

// 查询构造器（D-127）：维度 → SQL 的唯一出处。
// 这里只测「构造出来的 SQL 语义正确」与「边界校验文案」——命中正确性由 digest.test 的
// search_raws 集成用例覆盖（真库、真索引）。

describe("参数校验（D-103：越界直接报错，不静默改写）", () => {
  it("query 超长 → 报错并给正确用法", () => {
    expect(() => validateSearchArgs({ query: "x".repeat(201) })).toThrow(SearchRawsError);
    expect(() => validateSearchArgs({ query: "x".repeat(201) })).toThrow(/上限 200/);
  });

  it("时间格式非法 → 报错（不猜）", () => {
    expect(() => validateSearchArgs({ before: "昨天" })).toThrow(/时间格式不对/);
    expect(() => validateSearchArgs({ after: "2026/10/21" })).toThrow(/时间格式不对/);
  });

  it("区间反了 → 报错", () => {
    expect(() =>
      validateSearchArgs({ before: "2026-10-20T00:00:00", after: "2026-10-22T00:00:00" }),
    ).toThrow(/区间反了/);
  });

  it("跨度超 90 天 → 报错（防全表扫）", () => {
    expect(() =>
      validateSearchArgs({ before: "2026-10-22T00:00:00", after: "2026-01-01T00:00:00" }),
    ).toThrow(/90 天/);
  });

  it("limit 越界/非整数 → 报错", () => {
    expect(() => validateSearchArgs({ query: "a", limit: 0 })).toThrow(/1~50/);
    expect(() => validateSearchArgs({ query: "a", limit: -1 })).toThrow(/1~50/);
    expect(() => validateSearchArgs({ query: "a", limit: 51 })).toThrow(/1~50/);
    expect(() => validateSearchArgs({ query: "a", limit: 1.5 })).toThrow(/1~50/);
  });

  it("mode 非法 → 报错", () => {
    // 类型层挡不住运行时的脏 JSON——这里直接构造一个非法值验证服务端兜底
    expect(() => validateSearchArgs({ query: "a", mode: "xor" as "all" })).toThrow(
      /all（交集）或 any（并集）/,
    );
  });

  it("身份键名不在白名单 → 报错并列出可查的键", () => {
    expect(() => validateSearchArgs({ identity: [{ key: "evil", value: "x" }] })).toThrow(
      /不支持按该键查/,
    );
    for (const key of IDENTITY_KEY_WHITELIST) {
      expect(() => validateSearchArgs({ identity: [{ key, value: "x" }] })).not.toThrow();
    }
  });

  it("无任何条件 → 报错（不限条件的全量检索不是本工具用法）", () => {
    expect(() => validateSearchArgs({})).toThrow(/至少给一个条件/);
    expect(() => validateSearchArgs({ query: "   " })).toThrow(/至少给一个条件/);
    expect(() => validateSearchArgs({ identity: [] })).toThrow(/至少给一个条件/);
  });

  it("合法参数不报错", () => {
    expect(() => validateSearchArgs({ query: "高数" })).not.toThrow();
    expect(() => validateSearchArgs({ after: "2026-10-01T00:00:00" })).not.toThrow();
    expect(() => validateSearchArgs({ source: "nc", limit: 50, mode: "any" })).not.toThrow();
  });
});

describe("SQL 构造", () => {
  it("mode=all：所有条件 AND，参数顺序与占位符对应", () => {
    const { sql, params } = buildSearchSql({
      query: "高数",
      identity: [{ key: "groupId", value: "10001" }],
      after: "2026-10-01T00:00:00",
      mode: "all",
    });
    expect(sql).toContain(" AND ");
    expect(sql).not.toContain("UNION");
    expect(sql).toContain("received_at >=");
    expect(sql).toContain("json_extract");
    // 占位符数 = 参数数
    expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
    // 身份键以 JSON 路径形式绑定（不拼进 SQL 文本）
    expect(params).toContain('$."groupId"');
    expect(sql).not.toContain("groupId");
  });

  it("mode=any：非时间条件各成一支 UNION，时间仍是共同限定", () => {
    const { sql, params } = buildSearchSql({
      query: "高数",
      identity: [{ key: "groupId", value: "10002" }],
      after: "2026-10-01T00:00:00",
      mode: "any",
    });
    expect(sql).toContain("UNION");
    // 时间条件在两支里都出现（共同限定），不是并集的一部分
    expect((sql.match(/received_at >=/g) ?? []).length).toBe(2);
    expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
  });

  it("mode=any 但只给了时间 → 不 UNION，按时间窗直查", () => {
    const { sql } = buildSearchSql({ after: "2026-10-01T00:00:00", mode: "any" });
    expect(sql).not.toContain("UNION");
    expect(sql).toContain("received_at >=");
  });

  it("关键词逐词加引号且后缀 *（保留字安全 + 前缀匹配）", () => {
    const { params } = buildSearchSql({ query: "OR 门" });
    const expr = String(params[0]);
    // 每个 token 都在引号里，* 在引号外（实测 "高*" 是字面量、搜不到）
    expect(expr).toMatch(/"[^"]+"\*/);
    expect(expr).not.toMatch(/"[^"]*\*"/);
  });

  it("关键词里的双引号被转义（不会破坏 MATCH 语法）", () => {
    const { params } = buildSearchSql({ query: 'a"b' });
    const expr = String(params[0]);
    // 引号成对（转义为 ""）——不出现落单引号
    expect((expr.match(/"/g) ?? []).length % 2).toBe(0);
  });

  it("多词之间 AND（都要有）", () => {
    const { params } = buildSearchSql({ query: "高数 作业" });
    expect(String(params[0])).toContain(" AND ");
  });

  it("count SQL 包住 id 查询（同一份条件，不会漂移）", () => {
    const args = { query: "高数", after: "2026-10-01T00:00:00", mode: "all" as const };
    const ids = buildSearchSql(args);
    const count = buildCountSql(args);
    expect(count.sql).toContain("count(*)");
    expect(count.params).toEqual(ids.params);
  });

  it("精确条件之间恒为 AND（同键两个值 = 两个约束）", () => {
    const { sql } = buildSearchSql({
      identity: [
        { key: "groupId", value: "1" },
        { key: "sender", value: "2" },
      ],
    });
    expect(sql).toContain(" AND ");
  });
});

describe("边界修复（review 2026-10-23）", () => {
  it("关键词切词后为空（单字/纯标点）：交集返回**显式空集**，不拼出残缺 SQL", () => {
    // 「图」「课」这类单字 jieba 切不动、二元组也取不到 → 空
    for (const q of ["图", "课", "！！！", "。"]) {
      const { sql } = buildSearchSql({ query: q });
      expect(sql).toContain("WHERE 0"); // 必然 0 命中，且不是 `WHERE  ORDER BY`（语法错）
      expect(sql).not.toMatch(/WHERE\s+ORDER/);
    }
  });

  it("并集里切词为空的维度只是「没有贡献」，不会把整库当命中返回", () => {
    const empty = buildSearchSql({ query: "图", mode: "any" });
    expect(empty.sql).toContain("WHERE 0");
    expect(empty.sql).not.toContain("1=1");
    // 有一个可用维度时，并集照常（空维度被跳过，不影响另一个）
    const partial = buildSearchSql({
      query: "图",
      identity: [{ key: "groupId", value: "1" }],
      mode: "any",
    });
    expect(partial.sql).toContain("json_extract");
    expect(partial.sql).not.toContain("1=1");
  });

  it("时间边界规范化：只给日期时补成整日（不静默漏掉那一天）", () => {
    const onlyDate = buildSearchSql({ after: "2026-10-21" });
    expect(onlyDate.params).toContain("2026-10-21T00:00:00");
    const dateUpper = buildSearchSql({ before: "2026-10-21" });
    expect(dateUpper.params).toContain("2026-10-21T23:59:59");
    // 给到分钟：上界补 :59（否则少算 59 秒）
    const minute = buildSearchSql({ before: "2026-10-21T23:59" });
    expect(minute.params).toContain("2026-10-21T23:59:59");
    // 完整时刻原样
    const full = buildSearchSql({ before: "2026-10-21T12:34:56" });
    expect(full.params).toContain("2026-10-21T12:34:56");
  });

  it("非约定格式直接报错（不静默纠正——D-103）", () => {
    // 空格分隔、带 Z 都不是约定格式：拒收，让调用方按约定填
    expect(() => validateSearchArgs({ before: "2026-10-21 23:59:59" })).toThrow(/时间格式不对/);
    expect(() => validateSearchArgs({ before: "2026-10-21T23:59:59Z" })).toThrow(/时间格式不对/);
  });

  it("并集分支按接收时间倒序（不是按随机 uuid）", () => {
    const { sql } = buildSearchSql({ query: "a", source: "nc", mode: "any" });
    expect(sql).toContain("received_at DESC");
    expect(sql).not.toMatch(/ORDER BY id\b/);
  });

  it("count 查询不带 LIMIT（total 不在 500 处饱和）", () => {
    const ids = buildSearchSql({ query: "a" });
    const count = buildCountSql({ query: "a" });
    expect(ids.sql).toContain("LIMIT");
    expect(count.sql).not.toContain("LIMIT");
    expect(count.params).toEqual(ids.params);
  });

  it("回连用 raw_id，不用 rowid（两套 rowid 序列互不相干）", () => {
    const { sql } = buildSearchSql({ query: "a" });
    expect(sql).toContain("raw_id");
    expect(sql).not.toMatch(/SELECT rowid FROM raw_fts/);
  });
});
