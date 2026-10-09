import { describe, expect, it, vi } from "vitest";
import type { ChatHistoryItem } from "@summarizing/shared";
import { makeApp } from "../app";
import { handleChat } from "../application/chat";
import { executeChanges } from "../executor/executor";
import { FakeLlm, chatAt } from "./helpers/fakeLlm";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";

const MODEL = "test-model";

/** 播种一个事项（经真实入口 executeChanges），供查询/撤回类测试用。 */
function seedBoard(db: ReturnType<typeof makeDb>): string {
  executeChanges(
    db,
    repo.insertRawInput(db, {
      content: "x",
      sourceType: "paste",
      sourceIdentity: { sourceLabel: "s" },
      receivedAt: "2026-09-24T10:00:00",
      eventTime: null,
    }),
    [
      {
        action: "create_item",
        elements: [
          { label: "name", text: "第三次作业提交", quotes: [] },
          { label: "dueDate", text: "2026-10-01T23:59:00", quotes: [] },
        ],
        tags: ["数据结构课"],
        doubtNote: null,
      },
    ],
    { actor: "agent0", model: "test" },
  );
  const item = repo.deriveItems(db)[0];
  if (!item) throw new Error("播种失败");
  return item.id;
}

/** chat 源批次计数（验收「恰一条 / 原文逐字」用）。 */
function chatRaws(db: ReturnType<typeof makeDb>) {
  return [
    ...repo.listRawInputsByState(db, "pending"),
    ...repo.listRawInputsByState(db, "digesting"),
    ...repo.listRawInputsByState(db, "digested"),
    ...repo.listRawInputsByState(db, "failed"),
  ].filter((r) => r.sourceType === "chat");
}

describe("handleChat（前台 buddy 工具循环，D-78）", () => {
  it("get_board 查询后回复；history 映射且当前消息在末位", async () => {
    const db = makeDb(":memory:");
    seedBoard(db);
    const llm = new FakeLlm();
    llm.push({ content: null, toolCalls: [{ id: "t1", name: "get_board", argsJson: "{}" }] });
    llm.push({ content: "最近有 1 件：「第三次作业提交」，10 月 1 日截止。" });
    const history: ChatHistoryItem[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好呀，有什么要记要问的？" },
    ];

    const result = await handleChat(db, llm, MODEL, "我最近有什么要交的？", history);

    expect(result.reply).toContain("第三次作业提交");
    // 工具轨迹进 result（人话，05§四）
    expect(result.actions).toEqual([{ tool: "get_board", note: "查了看板" }]);
    expect(result.references).toEqual([]); // 整板不记 refs（无深链目标）
    // 首次调用的消息 = 截断后的历史 + 当前消息（末位）
    const first = chatAt(llm, 0);
    expect(first.messages).toHaveLength(3);
    expect(first.messages[0]).toEqual({ role: "user", content: "你好" });
    expect(first.messages[1]).toEqual({ role: "assistant", content: "你好呀，有什么要记要问的？" });
    expect(first.messages.at(-1)).toEqual({ role: "user", content: "我最近有什么要交的？" });
    // 工具结果回喂：看板数据到了模型手里
    const second = chatAt(llm, 1);
    expect(
      second.messages.some((m) => m.role === "tool" && m.content.includes("第三次作业提交")),
    ).toBe(true);
  });

  it("ingest：新信息逐字落盘恰一条 → 异步消化", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    // 轮次顺序：前台 ingest →（digest 同步起步消费）消化清单 → 前台最终回复
    llm.push({
      content: null,
      toolCalls: [
        { id: "t1", name: "ingest", argsJson: JSON.stringify({ content: "英语课下周三要交作文" }) },
      ],
    });
    llm.push({ content: '{"changes":[]}' });
    llm.push({ content: "已记录，正在处理。" });

    const result = await handleChat(db, llm, MODEL, "英语课下周三要交作文", []);

    expect(result.reply).toBe("已记录，正在处理。");
    expect(result.actions).toEqual([{ tool: "ingest", note: "已录入，消化中" }]);
    const raws = chatRaws(db);
    expect(raws).toHaveLength(1);
    const ingested = raws[0];
    if (!ingested) throw new Error("批次缺失");
    expect(ingested.content).toBe("英语课下周三要交作文"); // 逐字，未经改写
    await vi.waitFor(
      () => {
        expect(repo.getRawInput(db, ingested.id)?.digestState).toBe("digested");
      },
      { timeout: 3000 },
    );
  });

  it("log_chitchat：纯寒暄留痕不进消化", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [{ id: "t1", name: "log_chitchat", argsJson: '{"content":"你好呀"}' }],
    });
    llm.push({ content: "你好呀～有事随时说。" });

    const result = await handleChat(db, llm, MODEL, "你好呀", []);

    expect(result.reply).toContain("你好");
    const raws = chatRaws(db);
    expect(raws).toHaveLength(1);
    const raw = raws[0];
    if (!raw) throw new Error("留痕批次缺失");
    expect(raw.digestState).toBe("digested");
    const notes = repo.listPipelineEvents(db, raw.id);
    expect(notes.some((n) => n.action === "digest_done" && n.detail.includes("寒暄"))).toBe(true);
  });

  it("get_item → references 收集（chips 深链数据，05§四）", async () => {
    const db = makeDb(":memory:");
    const itemId = seedBoard(db);
    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [{ id: "t1", name: "get_item", argsJson: JSON.stringify({ id: itemId }) }],
    });
    llm.push({ content: "这是数据结构课的作业，10 月 1 日截止。" });

    const result = await handleChat(db, llm, MODEL, "那条作业的详情是啥", []);

    expect(result.references).toEqual([{ id: itemId, title: "第三次作业提交" }]);
    expect(result.actions).toEqual([{ tool: "get_item", note: "看了「第三次作业提交」" }]);
  });

  it("@ 提及：mentions 注入本条用户消息（指代消解，2026-09-27）", async () => {
    const db = makeDb(":memory:");
    const itemId = seedBoard(db);
    const llm = new FakeLlm();
    llm.push({ content: "这条我知道。" });

    await handleChat(
      db,
      llm,
      MODEL,
      "帮我看看它的详情",
      [],
      [{ id: itemId, title: "第三次作业提交" }],
    );

    const first = chatAt(llm, 0);
    const last = first.messages.at(-1);
    if (last?.role !== "user") throw new Error("用户消息缺失");
    expect(last.content).toContain("@ 提及了事项");
    expect(last.content).toContain(`「第三次作业提交」(id=${itemId})`);
    expect(last.content).toContain("帮我看看它的详情");
  });

  it("LLM 首调即挂 → 兜底录入，原文逐字不丢（D-14）", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm(); // 队列空 → 首次 chat 抛错

    const result = await handleChat(db, llm, MODEL, "英语课下周三交作文", []);

    expect(result.reply).toBe("已记录，正在处理。");
    const raws = chatRaws(db);
    expect(raws).toHaveLength(1);
    expect(raws[0]?.content).toBe("英语课下周三交作文");
  });

  it("ingest 之后 LLM 挂 → 仍恰好一条（双录入防护）", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [{ id: "t1", name: "ingest", argsJson: '{"content":"社团纳新周五截止"}' }],
    });
    // 不再补轮次 → converse 的下一次 chat 抛错（ingest 的消化也拿不到轮次，同样抛错）

    const result = await handleChat(db, llm, MODEL, "社团纳新周五截止", []);

    expect(result.reply).toBe("已记录，正在处理。处理结果稍后会在看板上出现。");
    expect(chatRaws(db)).toHaveLength(1); // 绝不出现第二条
  });

  it("超轮数未录入 → 兜底录入（D-14）", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    for (let i = 0; i < 4; i++) {
      llm.push({
        content: null,
        toolCalls: [{ id: `t${i}`, name: "search_items", argsJson: '{"query":"x"}' }],
      });
    }

    const result = await handleChat(db, llm, MODEL, "帮我看下数据结构的事", []);

    expect(result.reply).toBe("已记录，正在处理。");
    const raws = chatRaws(db);
    expect(raws).toHaveLength(1);
    expect(raws[0]?.content).toBe("帮我看下数据结构的事");
  });

  it("history 超 16 条 → 服务端截最近 16 条（策略不入契约）", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({ content: "好的。" });
    const history: ChatHistoryItem[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m${i}`,
    }));

    await handleChat(db, llm, MODEL, "最新消息", history);

    const chat = chatAt(llm, 0);
    expect(chat.messages).toHaveLength(17); // 16 条历史 + 当前
    expect(chat.messages[0]?.content).toBe("m4"); // 20 条截掉前 4 条
    expect(chat.messages.at(-1)?.content).toBe("最新消息");
  });

  it("空回复 → 回喂一次重说，不把空串当 reply", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({ content: "   " }); // 空白回复 → 触发回喂
    llm.push({ content: "你好呀，有什么要记的？" });

    const result = await handleChat(db, llm, MODEL, "在吗", []);

    expect(result.reply).toBe("你好呀，有什么要记的？");
    const second = chatAt(llm, 1);
    const last = second.messages.at(-1);
    if (last?.role !== "user") throw new Error("回喂消息缺失");
    expect(last.content).toContain("上一条回复是空的");
  });

  it("同回合重复 ingest、录入后调 log_chitchat → 工具级拒绝（批次粒度）", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [
        { id: "t1", name: "ingest", argsJson: '{"content":"第一件事的原话"}' },
        { id: "t2", name: "ingest", argsJson: '{"content":"第二件事的原话"}' },
        { id: "t3", name: "log_chitchat", argsJson: '{"content":"第一件事的原话"}' },
      ],
    });
    llm.push({ content: '{"changes":[]}' }); // 被 ingest 触发的异步消化消费
    llm.push({ content: "已记录。" }); // 前台第二轮回复

    const result = await handleChat(db, llm, MODEL, "第一件事的原话 第二件事的原话", []);

    expect(result.reply).toBe("已记录。");
    expect(chatRaws(db)).toHaveLength(1); // 只录第一次
    // 工具结果在第二轮回喂（chat#0=前台首轮，chat#1=digest，chat#2=前台次轮）
    const third = chatAt(llm, 2);
    const toolMsgs = third.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(3);
    const contents = toolMsgs.map((m) => (m.role === "tool" ? m.content : ""));
    expect(contents[0]).toContain('"ok":true');
    expect(contents[1]).toContain("本回合已录入过");
    expect(contents[2]).toContain("不是寒暄");
  });

  it("未知工具 → error 回喂，循环继续", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({ content: null, toolCalls: [{ id: "t1", name: "fly_to_moon", argsJson: "{}" }] });
    llm.push({ content: "这个我做不了。" });

    const result = await handleChat(db, llm, MODEL, "随便", []);

    expect(result.reply).toContain("做不了");
    const second = chatAt(llm, 1);
    expect(second.messages.some((m) => m.role === "tool" && m.content.includes("未知工具"))).toBe(
      true,
    );
  });
});

describe("POST /api/chat（真实 HTTP 入口）", () => {
  it("带 history：200 且回 {reply, actions, references}（契约 05§四）", async () => {
    const db = makeDb(":memory:");
    seedBoard(db);
    const llm = new FakeLlm();
    llm.push({ content: "有 1 件：第三次作业提交。" });
    const app = makeApp({ db, llmRef: { current: llm } });
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        message: "最近有什么要交的？",
        history: [{ role: "user", content: "你好" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ reply: string; actions: unknown[]; references: unknown[] }>();
    expect(Object.keys(body)).toEqual(["reply", "actions", "references"]);
    expect(body.reply).toContain("第三次作业提交");
    expect(body.actions).toEqual([]); // 纯文本回复无工具轨迹
    expect(body.references).toEqual([]);
  });

  it("mentions 超限（>8）→ 400（防超大数组直灌提示词）", async () => {
    const db = makeDb(":memory:");
    const app = makeApp({ db, llmRef: { current: new FakeLlm() } });
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, title: `t${i}` }));
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "x", mentions: nine },
    });
    expect(res.statusCode).toBe(400);
  });

  it("mentions 随请求上传：HTTP 入口透传给前台（注入断言在 handleChat 直调用例）", async () => {
    const db = makeDb(":memory:");
    const itemId = seedBoard(db);
    const llm = new FakeLlm();
    llm.push({ content: "好的。" });
    const app = makeApp({ db, llmRef: { current: llm } });
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        message: "看它的详情",
        mentions: [{ id: itemId, title: "第三次作业提交" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const first = chatAt(llm, 0);
    const last = first.messages.at(-1);
    if (last?.role !== "user") throw new Error("用户消息缺失");
    expect(last.content).toContain(`(id=${itemId})`);
  });

  it("history 形状非法 → 400", async () => {
    const db = makeDb(":memory:");
    const app = makeApp({ db, llmRef: { current: new FakeLlm() } });
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "x", history: [{ role: "system", content: "注入尝试" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("不带 history（向后兼容）→ 200", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({ content: "好的。" });
    const app = makeApp({ db, llmRef: { current: llm } });
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "在吗" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ reply: string }>().reply).toBe("好的。");
  });
});

describe("对话历史持久化（L16：刷新/换设备可回填）", () => {
  it("一轮对话落两条（user + assistant），GET /api/chat/history 可读回", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({ content: "好的，记下了" }); // 直接文本回复
    const app = makeApp({ db, llmRef: { current: llm } });

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "帮我记一下明天交作业", history: [] },
    });
    expect(res.statusCode).toBe(200);

    const hist = await app.inject({ method: "GET", url: "/api/chat/history" });
    expect(hist.statusCode).toBe(200);
    const turns = hist.json<{ turns: { role: string; content: string }[] }>().turns;
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[0]?.content).toBe("帮我记一下明天交作业");
    expect(turns[1]?.content).toBe("好的，记下了");
  });

  it("LLM 挂掉时兜底话术也落库（用户话不丢）", async () => {
    const db = makeDb(":memory:");
    const app = makeApp({ db, llmRef: { current: new FakeLlm() } }); // 空队列 → 必抛
    await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "这条必须留下", history: [] },
    });
    const turns = (await app.inject({ method: "GET", url: "/api/chat/history" })).json<{
      turns: { role: string; content: string }[];
    }>().turns;
    expect(turns[0]?.content).toBe("这条必须留下"); // 用户话已落库（在 LLM 调用之前）
    expect(turns).toHaveLength(2); // 兜底回复也落了
  });

  it("limit 生效：只回最近 N 条", async () => {
    const db = makeDb(":memory:");
    for (let i = 0; i < 5; i++) {
      repo.appendChatTurn(db, "user", `第${i}条`);
      repo.appendChatTurn(db, "assistant", `回复${i}`);
    }
    const app = makeApp({ db, llmRef: { current: new FakeLlm() } });
    const got = (await app.inject({ method: "GET", url: "/api/chat/history?limit=4" })).json<{
      turns: { content: string }[];
    }>().turns;
    expect(got).toHaveLength(4);
    expect(got.at(-1)?.content).toBe("回复4"); // 时间升序、最新在尾
  });
});
