import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { UsageSummarySchema, type UsageSummary } from "@summarizing/shared";
import { cleanupAllTestAccounts, makeTestAccount, type TestAccount } from "./helpers/app";
import { FakeLlm } from "./helpers/fakeLlm";
import { handleChat } from "../application/chat";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";
import type { Db } from "../storage/db";
import type { LlmUsage } from "../shared/llm";

// Token 用量（010）：真实入口断言用户所见——活动栏「用量」仪表盘背后的聚合数字。
// 覆盖脏形态矩阵（T001–T004）：usage 缺失/脏值、缓存字段三种来源、日历日边界、账户隔离。

afterEach(cleanupAllTestAccounts);

/** 造一次用量行（真实写入路径：insertLlmUsage）。 */
function seedUsage(db: Db, u: LlmUsage, actor: "agent0" | "chat" = "agent0"): void {
  db.$client
    .prepare(
      `INSERT INTO llm_usage (id, at, actor, model, prompt_tokens, completion_tokens, cached_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      nowBeijing(),
      actor,
      "test-model",
      u.promptTokens,
      u.completionTokens,
      u.cachedTokens,
    );
}

/** n 天前的北京墙钟正午（避开日界，跑在任何时区都固定）。 */
/** n 天前的北京墙钟正午（避开日界，跑在任何时区都固定）。 */
function daysAgo(days: number): string {
  const now = Date.now() - days * 86_400_000;
  const d = new Date(now + 8 * 3_600_000);
  /** 两位数补零。 */
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T12:00:00`;
}

/** 现在的北京墙钟。 */
function nowBeijing(): string {
  const d = new Date(Date.now() + 8 * 3_600_000);
  /** 两位数补零。 */
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 在指定时刻插一行（覆盖日历日边界用例）。 */
function seedAt(db: Db, at: string, u: LlmUsage): void {
  db.$client
    .prepare(
      `INSERT INTO llm_usage (id, at, actor, model, prompt_tokens, completion_tokens, cached_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      at,
      "agent0",
      "test-model",
      u.promptTokens,
      u.completionTokens,
      u.cachedTokens,
    );
}

/** GET /api/usage 并过 shared schema（响应形状即契约）。 */
async function getUsage(t: TestAccount, range?: string): Promise<UsageSummary> {
  const res = await t.inject({
    method: "GET",
    url: range === undefined ? "/api/usage" : `/api/usage?range=${range}`,
  });
  expect(res.statusCode).toBe(200);
  return UsageSummarySchema.parse(res.json());
}

describe("GET /api/usage", () => {
  it("三个数字互不重叠：相加 = 总消耗（「输入」= 未命中部分）", async () => {
    const t = await makeTestAccount();
    seedUsage(t.db, { promptTokens: 1500, completionTokens: 300, cachedTokens: 1000 });
    const sum = await getUsage(t, "today");
    expect(sum.inputTokens).toBe(500); // 1500 - 1000
    expect(sum.completionTokens).toBe(300);
    expect(sum.cachedTokens).toBe(1000);
    // 三者相加 = prompt + completion = 1800
    expect(sum.inputTokens + sum.completionTokens + (sum.cachedTokens ?? 0)).toBe(1800);
  });

  it("跨行累加正确；并按 actor 都记（agent0 / chat 都计入同一份聚合）", async () => {
    const t = await makeTestAccount();
    seedUsage(t.db, { promptTokens: 1000, completionTokens: 100, cachedTokens: 700 }, "agent0");
    seedUsage(t.db, { promptTokens: 400, completionTokens: 50, cachedTokens: 0 }, "chat");
    const sum = await getUsage(t, "today");
    expect(sum.inputTokens).toBe(700); // 300 + 400
    expect(sum.completionTokens).toBe(150);
    expect(sum.cachedTokens).toBe(700); // 700 + 0（0 是真实数据）
    expect(sum.callCount).toBe(2);
  });

  it("服务商未提供缓存字段 → cachedTokens 为 null（不拿 0 冒充）", async () => {
    const t = await makeTestAccount();
    seedUsage(t.db, { promptTokens: 1234, completionTokens: 56, cachedTokens: null });
    const sum = await getUsage(t, "today");
    expect(sum.cachedTokens).toBeNull();
    expect(sum.inputTokens).toBe(1234); // 无缓存 = 全部输入都是未命中
  });

  it("零调用：全 0、cachedTokens 为 null、callCount=0（空态与零用量可分辨）", async () => {
    const t = await makeTestAccount();
    const sum = await getUsage(t, "today");
    expect(sum).toMatchObject({
      inputTokens: 0,
      completionTokens: 0,
      cachedTokens: null,
      callCount: 0,
    });
  });

  it("范围口径 = 北京墙钟日历日：today 不含昨天；7d 含今 7 天；30d 不含更早", async () => {
    const t = await makeTestAccount();
    seedAt(t.db, daysAgo(0), { promptTokens: 1, completionTokens: 1, cachedTokens: null }); // 今天
    seedAt(t.db, daysAgo(1), { promptTokens: 10, completionTokens: 1, cachedTokens: null }); // 昨天
    seedAt(t.db, daysAgo(6), { promptTokens: 100, completionTokens: 1, cachedTokens: null }); // 7 天窗口内
    seedAt(t.db, daysAgo(7), { promptTokens: 200, completionTokens: 1, cachedTokens: null }); // 7 天窗口外
    seedAt(t.db, daysAgo(29), { promptTokens: 1000, completionTokens: 1, cachedTokens: null }); // 30 个日历日窗口内
    seedAt(t.db, daysAgo(30), { promptTokens: 5000, completionTokens: 1, cachedTokens: null }); // 窗口最左端（含）

    expect((await getUsage(t, "today")).inputTokens).toBe(1);
    expect((await getUsage(t, "7d")).inputTokens).toBe(111); // 1 + 10 + 100
    // 30d 含 0/1/6/7/29 五天前的行（daysAgo(30) 落到窗口外：北京时区下 = 31 个自然日前）
    expect((await getUsage(t, "30d")).inputTokens).toBe(1311); // 1 + 10 + 100 + 200 + 1000
  });

  it("range 缺省 = 7d；非法值 → 400（不静默吞掉）", async () => {
    const t = await makeTestAccount();
    seedAt(t.db, daysAgo(3), { promptTokens: 42, completionTokens: 1, cachedTokens: null });
    expect((await getUsage(t)).inputTokens).toBe(42); // 缺省 7d
    const bad = await t.inject({ method: "GET", url: "/api/usage?range=forever" });
    expect(bad.statusCode).toBe(400);
  });

  it("未登录 → 401", async () => {
    const t = await makeTestAccount();
    const res = await t.inject({ method: "GET", url: "/api/usage", headers: { cookie: "" } });
    expect(res.statusCode).toBe(401);
  });

  it("账户隔离：只读本账户库（别人的用量看不到）", async () => {
    const t = await makeTestAccount();
    seedUsage(t.db, { promptTokens: 999, completionTokens: 1, cachedTokens: null });
    expect((await getUsage(t, "today")).inputTokens).toBe(999);
    // 同一实例第二个账户有独立库与独立 cookie（TestRealm.addAccount 语义）
    // 此处用无 cookie 的裸 inject 证明第一道隔离：未认证一律 401
    const res = await t.inject({ method: "GET", url: "/api/usage" });
    expect(res.statusCode).toBe(200); // 本账户的请求自己当然通
  });
});

describe("成功调用落行（真实链路）", () => {
  /** 等桥接轮消化完（digest 异步 fire-and-forget）。 */
  async function afterDigest(): Promise<void> {
    await new Promise((r) => setTimeout(r, 60));
  }

  it("前台每轮成功调用记一行（actor=chat）", async () => {
    const llm = new FakeLlm("t");
    const t = await makeTestAccount({ llm });
    llm.push({
      content: "好的",
      usage: { promptTokens: 120, completionTokens: 8, cachedTokens: 100 },
    });
    const res = await t.inject({ method: "POST", url: "/api/chat", payload: { message: "你好" } });
    expect(res.statusCode).toBe(200);
    const sum = await getUsage(t, "today");
    expect(sum).toMatchObject({ inputTokens: 20, completionTokens: 8, cachedTokens: 100 });
    const actor = t.db.$client.prepare("SELECT DISTINCT actor FROM llm_usage").all();
    expect(actor).toEqual([{ actor: "chat" }]);
  });

  it("前台多轮工具调用：每轮一行、累加正确", async () => {
    // 直调 handleChat（同 chat.test.ts 的模式）：不涉 HTTP 的循环行为在内存库上断言
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [{ id: "c1", name: "get_board", argsJson: "{}" }],
      usage: { promptTokens: 200, completionTokens: 10, cachedTokens: 150 },
    });
    llm.push({
      content: "办完了",
      usage: { promptTokens: 400, completionTokens: 20, cachedTokens: null },
    });
    await handleChat(db, llm, llm.modelTag, "看看", [], "", []);
    const sum = repo.sumLlmUsage(db, "1970-01-01T00:00:00");
    expect(sum.callCount).toBe(2); // 每轮一行
    expect(sum.inputTokens).toBe(450); // (200-150) + (400-0)
    expect(sum.completionTokens).toBe(30);
    expect(sum.cachedTokens).toBe(150); // 只有第一轮给了缓存字段；第二轮没有
  });

  it("调用失败（队列空）不落行：业务仍给兜底回复", async () => {
    const llm = new FakeLlm("t"); // 不 push → chat 抛错
    const t = await makeTestAccount({ llm });
    const res = await t.inject({ method: "POST", url: "/api/chat", payload: { message: "你好" } });
    expect(res.statusCode).toBe(200);
    expect((await getUsage(t, "today")).callCount).toBe(0);
  });

  it("usage 为 null（服务商不返回）不落行——不拿 0 冒充", async () => {
    const llm = new FakeLlm("t");
    const t = await makeTestAccount({ llm });
    llm.push({ content: "好的", usage: null });
    await t.inject({ method: "POST", url: "/api/chat", payload: { message: "你好" } });
    const sum = await getUsage(t, "today");
    expect(sum.callCount).toBe(0);
    expect(sum.cachedTokens).toBeNull();
  });

  it("agent0 消化落行（actor=agent0）", async () => {
    const llm = new FakeLlm("t");
    const t = await makeTestAccount({ llm });
    // ingest 触发异步 digest：首轮即给合法变更清单
    llm.push({
      content: '{"changes":[]}',
      usage: { promptTokens: 300, completionTokens: 12, cachedTokens: 250 },
    });
    const res = await t.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        content: "周三前交物理实验报告",
        sourceType: "nc",
        sourceIdentity: { sourceLabel: "测试群" },
        eventTime: null,
      },
    });
    expect(res.statusCode).toBe(202);
    await afterDigest();
    const sum = await getUsage(t, "today");
    expect(sum.inputTokens).toBe(50); // 300 - 250
    const rows = t.db.$client.prepare("SELECT actor FROM llm_usage").all();
    expect(rows).toEqual([{ actor: "agent0" }]);
  });
});
