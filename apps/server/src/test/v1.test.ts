// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import sharp from "sharp";
import { BoardViewSchema, SearchRawsResultSchema } from "@summarizing/shared";
import { cleanupAllTestAccounts, makeTestAccount, makeTestRealm } from "./helpers/app";
import * as repo from "../storage/repo";
import { storeImageBytes } from "../application/media";
import { FakeLlm } from "./helpers/fakeLlm";
import { digestRawInput } from "../agent0/digest";
import { makeAgentTools } from "../agent0/tools";
import { handleChat } from "../application/chat";

/** 投喂回执形状（v1 契约；测试侧独立声明，断言的是「公开形状」而非内部类型）。 */
const IngestReceiptSchema = z.object({ id: z.string(), digestState: z.string() });

/** 流水台账响应形状。 */
const RunsResponseSchema = z.object({ runs: z.array(z.object({ id: z.string() })) });

// v1 对外接口（D-139）与对话上下文（D-139）的回归：
// ① 令牌鉴权是**独立作用域**——设置面/认证面绝不可达（这是本期最关键的安全断言）；
// ② 同一个令牌既能走 webhook 也能走 v1（用户定 A 方案）；
// ③ 上下文从服务端 chat_turns 取、只进简报不作引文依据。

afterEach(async () => {
  await cleanupAllTestAccounts();
});

/** 带 Bearer 的 inject。 */
function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe("v1 对外接口：令牌鉴权", () => {
  it("没有 Authorization 头 → 401", async () => {
    const acct = await makeTestAccount();
    const res = await acct.app.inject({ method: "GET", url: "/api/v1/board" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "接入令牌无效" });
  });

  it("错的令牌 → 401", async () => {
    const acct = await makeTestAccount();
    const res = await acct.app.inject({
      method: "GET",
      url: "/api/v1/board",
      headers: bearer("deadbeef"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("正确的令牌 → 200，且读到的是**本账户**的看板", async () => {
    const acct = await makeTestAccount();
    const res = await acct.app.inject({
      method: "GET",
      url: "/api/v1/board",
      headers: bearer(acct.sourceToken),
    });
    expect(res.statusCode).toBe(200);
    const body = BoardViewSchema.parse(res.json());
    expect(body).toHaveProperty("undated");
    expect(body).toHaveProperty("scheduled");
    expect(body).toHaveProperty("doneMeta");
  });

  it("同一个令牌也能走 webhook 网关（用户定：一把令牌两种用途）", async () => {
    // webhook 网关对未知路径回 404（而非 401）——说明令牌本身被判为有效、只是没这个处理器
    const acct = await makeTestAccount();
    const withToken = await acct.app.inject({
      method: "POST",
      url: acct.hookUrl("nosuch", "/event"),
      payload: {},
    });
    expect(withToken.statusCode).toBe(404);
    const withBadToken = await acct.app.inject({
      method: "POST",
      url: "/hook/badtoken/nosuch/event",
      payload: {},
    });
    expect(withBadToken.statusCode).toBe(401);
  });

  it("v1 上不存在任何设置/认证路由（安全边界）", async () => {
    const acct = await makeTestAccount();
    // 这些路径在 v1 命名空间下一律 404——不是「被拒」，而是「根本不存在」
    for (const [method, url] of [
      ["GET", "/api/v1/settings/ai"],
      ["PUT", "/api/v1/settings/ai"],
      ["POST", "/api/v1/auth/source-token/rotate"],
      ["PUT", "/api/v1/auth/password"],
      ["GET", "/api/v1/backup"],
      ["GET", "/api/v1/sources"],
      ["POST", "/api/v1/chat"],
    ] as const) {
      const res = await acct.app.inject({ method, url, headers: bearer(acct.sourceToken) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });
});

describe("v1 对外接口：读写面", () => {
  it("投喂 → 202 + 批次 id → 能在流水里查到", async () => {
    const acct = await makeTestAccount();
    const res = await acct.app.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: bearer(acct.sourceToken),
      payload: {
        content: "明天下午三点在明理楼开会",
        source: "agent",
        identity: { displayName: "我的 agent" },
      },
    });
    expect(res.statusCode).toBe(202);
    const { id, digestState } = IngestReceiptSchema.parse(res.json());
    expect(typeof id).toBe("string");
    expect(digestState).toBe("digesting");

    const raw = repo.getRawInput(acct.db, id);
    expect(raw?.content).toBe("明天下午三点在明理楼开会");
    expect(raw?.source).toBe("agent");

    const runs = await acct.app.inject({
      method: "GET",
      url: "/api/v1/pipeline/runs",
      headers: bearer(acct.sourceToken),
    });
    expect(runs.statusCode).toBe(200);
    expect(RunsResponseSchema.parse(runs.json()).runs.map((r) => r.id)).toContain(id);
  });

  it("投喂缺字段 → 400（不静默存半条）", async () => {
    const acct = await makeTestAccount();
    const res = await acct.app.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: bearer(acct.sourceToken),
      payload: { content: "只有内容没有信源" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("事项状态四连：complete → reopen → trash → restore", async () => {
    const acct = await makeTestAccount();
    const raw = repo.insertRawInput(acct.db, {
      content: "测试事项",
      source: "agent",
      identity: { displayName: "测试" },
      receivedAt: "2026-11-10T10:00:00",
      eventTime: null,
    });
    const itemId = "item-v1-test";
    repo.appendItemVersion(acct.db, {
      itemId,
      action: "create_item",
      detail: "新建",
      snapshot: {
        elements: [{ label: "name", text: "测试事项" }],
        tags: [],
        status: "todo",
        kind: "task",
        doubtNote: null,
      },
      by: { actor: "agent0", model: null },
    });
    void raw;

    /** 打一次状态动作端点，返回状态码与（可能为空的）响应体。 */
    const post = async (action: string): Promise<{ status: number; body: unknown }> => {
      const r = await acct.app.inject({
        method: "POST",
        url: `/api/v1/items/${itemId}/${action}`,
        headers: bearer(acct.sourceToken),
      });
      return { status: r.statusCode, body: r.json() };
    };

    expect((await post("complete")).status).toBe(200);
    expect(repo.deriveItem(acct.db, itemId)?.status).toBe("done");
    expect((await post("reopen")).status).toBe(200);
    expect(repo.deriveItem(acct.db, itemId)?.status).toBe("todo");
    expect((await post("trash")).status).toBe(200);
    expect(repo.deriveItem(acct.db, itemId)?.status).toBe("trashed");
    expect((await post("restore")).status).toBe(200);
    expect(repo.deriveItem(acct.db, itemId)?.status).toBe("todo");
  });

  it("状态动作幂等：重复 complete / trash / restore 不追加版本", async () => {
    const acct = await makeTestAccount();
    const itemId = "item-idempotent";
    repo.appendItemVersion(acct.db, {
      itemId,
      action: "create_item",
      detail: "新建",
      snapshot: {
        elements: [{ label: "name", text: "幂等测试" }],
        tags: [],
        status: "todo",
        kind: "task",
        doubtNote: null,
      },
      by: { actor: "agent0", model: null },
    });
    /** 当前事项的版本数（判「有没有多写一个版本」）。 */
    const count = (): number => repo.deriveHistory(acct.db, itemId).length;
    /** 打一次状态动作端点，只回状态码。 */
    const act = async (action: string): Promise<number> => {
      const r = await acct.app.inject({
        method: "POST",
        url: `/api/v1/items/${itemId}/${action}`,
        headers: bearer(acct.sourceToken),
      });
      return r.statusCode;
    };

    const base = count();
    // 连续 3 次 complete：只该产生 1 个新版本（重试是常规行为，不该堆重复历史）
    expect(await act("complete")).toBe(200);
    expect(await act("complete")).toBe(200);
    expect(await act("complete")).toBe(200);
    expect(count()).toBe(base + 1);

    // 连续 3 次 trash：同上
    expect(await act("trash")).toBe(200);
    expect(await act("trash")).toBe(200);
    expect(await act("trash")).toBe(200);
    expect(count()).toBe(base + 2);

    // 连续 3 次 restore：同上（回到 done，因为删前是 done）
    expect(await act("restore")).toBe(200);
    expect(await act("restore")).toBe(200);
    expect(await act("restore")).toBe(200);
    expect(count()).toBe(base + 3);
    expect(repo.deriveItem(acct.db, itemId)?.status).toBe("done");

    // reopen 连发：也只加一个版本
    expect(await act("reopen")).toBe(200);
    expect(await act("reopen")).toBe(200);
    expect(count()).toBe(base + 4);
    expect(repo.deriveItem(acct.db, itemId)?.status).toBe("todo");
  });

  it("图片可读：v1 能取回字节（证据链的一环），且不暴露上传口", async () => {
    const acct = await makeTestAccount();
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const stored = await storeImageBytes(acct.db, acct.space.mediaDir, png, {
      declaredMime: "image/png",
    });

    const res = await acct.app.inject({
      method: "GET",
      url: `/api/v1/media/${stored.id}`,
      headers: bearer(acct.sourceToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/");
    expect(res.rawPayload.byteLength).toBeGreaterThan(0);

    // 不存在的图 → 404（不泄露存在性）
    const missing = await acct.app.inject({
      method: "GET",
      url: "/api/v1/media/deadbeef",
      headers: bearer(acct.sourceToken),
    });
    expect(missing.statusCode).toBe(404);

    // 未认证 → 401
    const noAuth = await acct.app.inject({ method: "GET", url: `/api/v1/media/${stored.id}` });
    expect(noAuth.statusCode).toBe(401);

    // 上传口不对外：POST /api/v1/media 不存在
    const upload = await acct.app.inject({
      method: "POST",
      url: "/api/v1/media",
      headers: bearer(acct.sourceToken),
    });
    expect(upload.statusCode).toBe(404);
  });

  it("不存在的事项 → 404；回收站里的条目完成 → 409", async () => {
    const acct = await makeTestAccount();
    const notFound = await acct.app.inject({
      method: "POST",
      url: "/api/v1/items/nope/complete",
      headers: bearer(acct.sourceToken),
    });
    expect(notFound.statusCode).toBe(404);

    const itemId = "item-trashed";
    repo.appendItemVersion(acct.db, {
      itemId,
      action: "create_item",
      detail: "新建",
      snapshot: {
        elements: [{ label: "name", text: "已删" }],
        tags: [],
        status: "trashed",
        kind: "task",
        doubtNote: null,
      },
      by: { actor: "agent0", model: null },
    });
    const res = await acct.app.inject({
      method: "POST",
      url: `/api/v1/items/${itemId}/complete`,
      headers: bearer(acct.sourceToken),
    });
    expect(res.statusCode).toBe(409);
  });

  it("检索：空 query 忽略、有命中给 hit；越界 limit 直接 400", async () => {
    const acct = await makeTestAccount();
    repo.insertRawInput(acct.db, {
      content: "英语课群通知：周五交作文",
      source: "nc",
      identity: { displayName: "英语课群" },
      receivedAt: "2026-11-10T10:00:00",
      eventTime: null,
    });
    const hit = await acct.app.inject({
      method: "GET",
      url: "/api/v1/search?query=" + encodeURIComponent("作文"),
      headers: bearer(acct.sourceToken),
    });
    expect(hit.statusCode).toBe(200);
    expect(SearchRawsResultSchema.parse(hit.json()).hits.length).toBeGreaterThan(0);

    const bad = await acct.app.inject({
      method: "GET",
      url: "/api/v1/search?query=x&limit=999",
      headers: bearer(acct.sourceToken),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("账户隔离：A 的令牌查不到 B 的事项", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });
    const b = await realm.addAccount({ username: "bob" });
    const itemId = "b-only-item";
    repo.appendItemVersion(b.db, {
      itemId,
      action: "create_item",
      detail: "新建",
      snapshot: {
        elements: [{ label: "name", text: "bob 的事" }],
        tags: [],
        status: "todo",
        kind: "task",
        doubtNote: null,
      },
      by: { actor: "agent0", model: null },
    });
    const res = await a.app.inject({
      method: "GET",
      url: `/api/v1/items/${itemId}`,
      headers: bearer(a.sourceToken),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("对话上下文进 agent0（D-139）", () => {
  it("ingest 落档时带上最近 6 轮（= 12 条消息）+ 时刻，且不含本条自己", async () => {
    const acct = await makeTestAccount();
    // 播 8 轮历史（user + assistant 各一条 = 16 行）：只该取最近 6 **轮** = 12 条消息
    for (let i = 0; i < 8; i++) {
      repo.appendChatTurn(acct.db, "user", `第 ${i} 句`);
      repo.appendChatTurn(acct.db, "assistant", `第 ${i} 答`);
    }
    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [
        {
          id: "t1",
          name: "ingest",
          argsJson: JSON.stringify({ content: "就按它说的改成周三" }),
        },
      ],
    });
    llm.push({ content: '{"changes":[]}' });
    llm.push({ content: "好的" });
    const mentions = [{ id: "item-1", title: "交作文" }];

    await handleChat(acct.db, llm, llm.modelTag, "就按它说的改成周三", [], "", mentions);

    const raws = [
      ...repo.listRawInputsByState(acct.db, "digested"),
      ...repo.listRawInputsByState(acct.db, "digesting"),
      ...repo.listRawInputsByState(acct.db, "pending"),
      ...repo.listRawInputsByState(acct.db, "failed"),
    ].filter((r) => r.source === "chat");
    expect(raws).toHaveLength(1);
    const raw = raws[0];
    if (!raw) throw new Error("批次缺失");

    const ctx = repo.getRawContext(acct.db, raw.id);
    expect(ctx).not.toBeNull();
    // 6 **轮** = 12 条消息（user + assistant 各一行）——不是 6 条消息
    expect(ctx?.turns).toHaveLength(12);
    // 最近一轮在末尾（时间升序）；8 轮里最早的 2 轮被截掉
    expect(ctx?.turns.at(-1)?.content).toBe("第 7 答");
    expect(ctx?.turns.at(-2)?.content).toBe("第 7 句");
    expect(ctx?.turns.some((t) => t.content === "第 0 句")).toBe(false); // 最早的被截掉
    expect(ctx?.turns.every((t) => t.at !== "")).toBe(true); // 每轮都带时刻
    expect(ctx?.turns.some((t) => t.content === "就按它说的改成周三")).toBe(false); // 不含本条自己
    expect(ctx?.mentions).toEqual(mentions);
  });

  it("无历史、无提及 → 上下文为 null（不造空壳）", async () => {
    const acct = await makeTestAccount();
    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [{ id: "t1", name: "ingest", argsJson: JSON.stringify({ content: "记一下" }) }],
    });
    llm.push({ content: '{"changes":[]}' });
    llm.push({ content: "好的" });
    await handleChat(acct.db, llm, llm.modelTag, "记一下", [], "");

    const raw = [
      ...repo.listRawInputsByState(acct.db, "digested"),
      ...repo.listRawInputsByState(acct.db, "digesting"),
      ...repo.listRawInputsByState(acct.db, "pending"),
      ...repo.listRawInputsByState(acct.db, "failed"),
    ].find((r) => r.source === "chat");
    if (!raw) throw new Error("批次缺失");
    expect(repo.getRawContext(acct.db, raw.id)).toBeNull();
  });

  it("上下文进了 agent0 的简报，且明说不许当引文", async () => {
    const acct = await makeTestAccount();
    repo.appendChatTurn(acct.db, "user", "我说的那个作业");
    repo.appendChatTurn(acct.db, "assistant", "你是说「交作文」那条？");

    const raw = repo.insertRawInput(acct.db, {
      content: "改成周三交",
      source: "chat",
      identity: { displayName: "用户对话" },
      receivedAt: "2026-11-10T10:00:00",
      eventTime: null,
      context: {
        turns: repo.listRecentChatTurns(acct.db, 6).map((t) => ({
          role: t.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: t.content,
          at: t.at,
        })),
        mentions: [{ id: "item-1", title: "交作文" }],
      },
    });

    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    await digestRawInput(acct.db, llm, makeAgentTools(acct.db, ""), llm.modelTag, raw);

    const brief = llm.chats[0]?.messages[0]?.content ?? "";
    expect(brief).toContain("【对话上下文");
    expect(brief).toContain("我说的那个作业");
    expect(brief).toContain("交作文");
    expect(brief).toContain("不得当作引文"); // 硬性区分
    expect(brief).toContain("改成周三交"); // 正文仍在
  });

  it("非 chat 批次（无上下文）→ 简报里没有那一段", async () => {
    const acct = await makeTestAccount();
    const raw = repo.insertRawInput(acct.db, {
      content: "群里发的通知",
      source: "nc",
      identity: { displayName: "某群" },
      receivedAt: "2026-11-10T10:00:00",
      eventTime: null,
    });
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    await digestRawInput(acct.db, llm, makeAgentTools(acct.db, ""), llm.modelTag, raw);
    const brief = llm.chats[0]?.messages[0]?.content ?? "";
    expect(brief).not.toContain("【对话上下文");
  });
});
