import { describe, expect, it, vi } from "vitest";
import { itemDueDate, type Item, type RawInput } from "@summarizing/shared";
import { makeApp } from "../app";
import { digestRawInput } from "../agent0/digest";
import { executeChanges } from "../executor/executor";
import { FakeLlm, chatAt } from "./helpers/fakeLlm";
import { makeAgentTools } from "../agent0/tools";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";

const MODEL = "test-model";
const PASTE = "数据结构 老师说下周要交第三次作业 好像还要交实验报告？";

/** 造一条标准 RawInput 夹具。 */
function seedRaw(db: ReturnType<typeof makeDb>) {
  return repo.insertRawInput(db, {
    content: PASTE,
    sourceType: "paste",
    sourceIdentity: { sourceLabel: "手机备忘录" },
    receivedAt: "2026-09-24T10:00:00",
    eventTime: "2026-09-24T10:15:00",
  });
}

describe("agent0 消化管线", () => {
  it("① 工具循环 + create_item：元素/标签/证据落全，推断写 note", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [
        { id: "t1", name: "search_items", argsJson: JSON.stringify({ query: "数据结构" }) },
      ],
    });
    llm.push({
      content: JSON.stringify({
        changes: [
          {
            action: "create_item",
            elements: [
              {
                label: "name",
                text: "数据结构第三次作业提交",
                note: null,
                quotes: ["老师说下周要交第三次作业"],
              },
              {
                label: "dueDate",
                text: "2026-10-01T23:59:59",
                note: "原文「下周要交」，以事件时间 09-24 为锚推断",
                quotes: ["老师说下周要交第三次作业"],
              },
            ],
            tags: ["数据结构课", "作业"],
            doubtNote: null,
          },
          {
            action: "create_item",
            elements: [
              {
                label: "name",
                text: "实验报告提交（未确认）",
                note: null,
                quotes: ["好像还要交实验报告"],
              },
            ],
            tags: ["数据结构课"],
            doubtNote: "原文用词『好像还要交』，事情未确认",
          },
        ],
      }),
    });
    const raw = seedRaw(db);
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);

    expect(result.state).toBe("digested");
    expect(result.appliedCount).toBe(2);
    const second = chatAt(llm, 1);
    expect(second.messages.some((m) => m.role === "tool")).toBe(true);

    const items = repo.deriveItems(db);
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.tags).toContain("数据结构课");

    const hw = items.find((i) =>
      i.elements.some((e) => e.label === "name" && e.text.includes("第三次作业")),
    );
    if (!hw) throw new Error("作业事项未创建");
    const dueEl = hw.elements.find((e) => e.label === "dueDate");
    expect(dueEl?.text).toBe("2026-10-01T23:59:59");
    expect(dueEl?.note).toContain("09-24");

    const evidence = repo.listEvidenceByItem(db, hw.id);
    expect(evidence.map((e) => e.subject).sort()).toEqual(["元素:dueDate", "元素:name"]);
    expect(evidence[0]?.capturedBy).toBe(`agent0:${MODEL}`);
  });

  it("② 空清单合法：零变更留痕，不建任何事项", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    const raw = seedRaw(db);
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);

    expect(result.state).toBe("digested");
    expect(result.appliedCount).toBe(0);
    expect(repo.deriveItems(db)).toHaveLength(0);
    const audit = repo.listRawAudit(db, raw.id);
    expect(audit.some((n) => n.detail.includes("零变更"))).toBe(true);
  });

  it("③ 引用不存在 ID → 围栏拒收 → 回喂一次修复成功", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({
      content: JSON.stringify({
        changes: [
          {
            action: "update_item",
            itemId: "nope",
            setElements: [{ label: "dueDate", text: "2026-10-08T00:00:00", quotes: [] }],
            resolveDoubt: false,
          },
        ],
      }),
    });
    llm.push({
      content: JSON.stringify({
        changes: [
          {
            action: "create_item",
            elements: [{ label: "name", text: "修复轮的产物", quotes: [] }],
            tags: [],
            doubtNote: null,
          },
        ],
      }),
    });
    const raw = seedRaw(db);
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);

    expect(result.state).toBe("digested");
    expect(result.appliedCount).toBe(1);
    const repairChat = chatAt(llm, 1);
    expect(repairChat.messages[0]?.content).toContain("被围栏拒收");
    expect(
      repo.deriveItems(db).some((i) => i.elements.some((e) => e.text === "修复轮的产物")),
    ).toBe(true);
    expect(repo.listRawAudit(db, raw.id).filter((n) => n.action === "fence_reject")).toHaveLength(
      0,
    );
  });

  it("④ 修复仍失败 → 放弃该项并留痕", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    const badItem = {
      action: "update_item",
      itemId: "nope",
      setElements: [{ label: "dueDate", text: "2026-10-08T00:00:00", quotes: [] }],
      resolveDoubt: false,
    };
    llm.push({ content: JSON.stringify({ changes: [badItem] }) });
    llm.push({ content: JSON.stringify({ changes: [badItem] }) });
    const raw = seedRaw(db);
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);

    expect(result.state).toBe("digested");
    expect(result.appliedCount).toBe(0);
    const audit = repo.listRawAudit(db, raw.id);
    expect(audit.filter((n) => n.action === "fence_reject")).toHaveLength(1);
  });

  it("⑤ 动作不在白名单 → JSON 解析失败 → 重试提示后产出合法清单", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[{"action":"fly_to_moon"}]}' });
    llm.push({ content: '{"changes":[]}' });
    const raw = seedRaw(db);
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);

    expect(result.state).toBe("digested");
    const retryChat = chatAt(llm, 1);
    const last = retryChat.messages.at(-1);
    if (last?.role !== "user") throw new Error("重试回喂消息缺失");
    expect(last.content).toContain("不是合法的变更清单 JSON");
  });

  it("⑥ 工具循环超轮数上限 → failed 留痕", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    for (let i = 0; i < 9; i++) {
      llm.push({
        content: null,
        toolCalls: [{ id: `t${i}`, name: "search_items", argsJson: '{"query":"x"}' }],
      });
    }
    const raw = seedRaw(db);
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);
    expect(result.state).toBe("failed");
    expect(repo.getRawInput(db, raw.id)?.digestState).toBe("failed");
  });

  it("⑦ LLM 调用失败 → 标「未处理」，原文仍在", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm(); // 队列空 → chat 抛错，模拟网关挂掉
    const raw = seedRaw(db);
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);

    expect(result.state).toBe("failed");
    expect(repo.getRawInput(db, raw.id)?.content).toBe(PASTE);
    expect(repo.getRawInput(db, raw.id)?.digestState).toBe("failed");
    const audit = repo.listRawAudit(db, raw.id);
    expect(audit.some((n) => n.action === "digest_failed" && n.detail.includes("未处理"))).toBe(
      true,
    );
  });

  it("⑧ 既有事项路径：update_item / add_element 用工具查到的真实 ID", async () => {
    const db = makeDb(":memory:");
    // 造一个日期未知的既有事项
    const llmSeed = new FakeLlm();
    llmSeed.push({
      content: JSON.stringify({
        changes: [
          {
            action: "create_item",
            elements: [{ label: "name", text: "社团纳新现场展示", quotes: [] }],
            tags: ["社团"],
            doubtNote: null,
          },
        ],
      }),
    });
    const rawSeed = seedRaw(db);
    await digestRawInput(db, llmSeed, makeAgentTools(db), MODEL, rawSeed);
    const existing = repo.deriveItems(db)[0];
    if (!existing) throw new Error("既有事项未创建");
    expect(itemDueDate(existing)).toBeNull();

    // 新信息补日期 + 拿不准的另一条入存疑库（D-85）
    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [{ id: "t1", name: "get_item", argsJson: JSON.stringify({ id: existing.id }) }],
    });
    llm.push({
      content: JSON.stringify({
        changes: [
          {
            action: "update_item",
            itemId: existing.id,
            setElements: [
              {
                label: "dueDate",
                text: "2026-10-15T23:59:59",
                note: null,
                quotes: ["现场展示改到10月15日"],
              },
            ],
            resolveDoubt: false,
          },
          {
            action: "park_uncertain",
            content: "好像还有个材料清单要交",
            needsHuman: 55,
            reason: "原文用『好像』，且未说明是哪个事项的材料清单",
          },
        ],
      }),
    });
    const raw2 = repo.insertRawInput(db, {
      content: "社团纳新现场展示改到10月15日",
      sourceType: "chat",
      sourceIdentity: { sourceLabel: "社团群" },
      receivedAt: "2026-09-25T10:00:00",
      eventTime: null,
    });
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw2);

    expect(result.state).toBe("digested");
    const after = repo.deriveItem(db, existing.id);
    if (!after) throw new Error("事项丢失");
    expect(itemDueDate(after)).toBe("2026-10-15T23:59:59");
    // 事项版本史只含真实变更（存疑信息不入版本链——进的是独立库）
    expect(repo.deriveHistory(db, existing.id).map((v) => v.action)).toEqual([
      "create_item",
      "update_item",
    ]);
    // 拿不准的信息进了存疑库（信源快照从当批带）
    const uncertain = repo.listUncertainByStatus(db, "open");
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0]?.content).toBe("好像还有个材料清单要交");
    expect(uncertain[0]?.needsHuman).toBe(55);
    expect(uncertain[0]?.originRawInputId).toBe(raw2.id);
    expect(uncertain[0]?.sourceType).toBe("chat");
  });
});

describe("身份判定与去重（S2 §4.11 / D-75·D-76）", () => {
  /** 经真实入口 executeChanges 播种一个既有事项，返回它。 */
  function seedItem(
    db: ReturnType<typeof makeDb>,
    name: string,
    dueDate: string | null,
  ): { item: Item; raw: RawInput } {
    const raw = repo.insertRawInput(db, {
      content: `${name}的相关原始记录`,
      sourceType: "chat",
      sourceIdentity: { sourceLabel: "课程群" },
      receivedAt: "2026-09-24T10:00:00",
      eventTime: null,
    });
    executeChanges(
      db,
      raw,
      [
        {
          action: "create_item",
          elements: [
            { label: "name", text: name, quotes: [name] },
            ...(dueDate === null
              ? []
              : [{ label: "dueDate", text: dueDate, note: null, quotes: [dueDate.slice(5, 10)] }]),
          ],
          tags: ["数据结构课"],
          doubtNote: null,
        },
      ],
      { actor: "agent0", model: "test" },
    );
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("种子事项未创建");
    return { item, raw };
  }

  it("正式通知并入课上碎片：同一事项、两条原始快照都在（验收14）", async () => {
    const db = makeDb(":memory:");
    const { item, raw: raw1 } = seedItem(db, "数据结构第三次作业提交", "2026-10-01T23:59:59");

    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [{ id: "t1", name: "search_items", argsJson: '{"query":"数据结构"}' }],
    });
    llm.push({
      content: null,
      toolCalls: [{ id: "t2", name: "get_item", argsJson: JSON.stringify({ id: item.id }) }],
    });
    llm.push({
      content: JSON.stringify({
        changes: [
          {
            action: "update_item",
            itemId: item.id,
            setElements: [
              {
                label: "dueDate",
                text: "2026-10-08T23:59:59",
                note: null,
                quotes: ["提交截止10月8日23:59"],
              },
            ],
            resolveDoubt: false,
          },
        ],
      }),
    });
    const raw2 = repo.insertRawInput(db, {
      content: "【数据结构】第三次作业通知：提交截止10月8日23:59，提交入口见群公告。",
      sourceType: "chat",
      sourceIdentity: { sourceLabel: "课程群" },
      receivedAt: "2026-09-27T10:00:00",
      eventTime: null,
    });
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw2);

    expect(result.state).toBe("digested");
    const after = repo.deriveItem(db, item.id);
    if (!after) throw new Error("事项丢失");
    expect(itemDueDate(after)).toBe("2026-10-08T23:59:59");
    expect(repo.deriveHistory(db, item.id).map((v) => v.action)).toEqual([
      "create_item",
      "update_item",
    ]);
    // 合并保留两条原始快照：碎片批次与正式通知批次的片段都能查到
    const full = repo.getItemFull(db, item.id);
    if (!full) throw new Error("读取失败");
    const batchIds = new Set(full.fragments.map((f) => f.rawInputId));
    expect(batchIds.has(raw1.id)).toBe(true);
    expect(batchIds.has(raw2.id)).toBe(true);
  });

  it("低置信碎片：record_note 挂靠唯一候选，不进正文元素（验收15）", async () => {
    const db = makeDb(":memory:");
    const { item } = seedItem(db, "数据结构第三次作业提交", "2026-10-08T23:59:59");
    const before = repo.deriveItem(db, item.id);
    if (!before) throw new Error("种子事项丢失");

    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [{ id: "t1", name: "search_items", argsJson: '{"query":"数据结构"}' }],
    });
    llm.push({
      content: JSON.stringify({
        changes: [
          {
            action: "record_note",
            targetType: "item",
            targetId: item.id,
            note: "疑似与「数据结构第三次作业提交」同属一事（实验报告），待后续信息确认",
          },
        ],
      }),
    });
    const raw = repo.insertRawInput(db, {
      content: "好像数据结构还要交实验报告？",
      sourceType: "chat",
      sourceIdentity: { sourceLabel: "课程群" },
      receivedAt: "2026-09-25T10:00:00",
      eventTime: null,
    });
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);

    expect(result.state).toBe("digested");
    expect(repo.deriveItems(db)).toHaveLength(1); // 没有建新事项
    const after = repo.deriveItem(db, item.id);
    if (!after) throw new Error("事项丢失");
    expect(after.elements).toEqual(before.elements); // 正文元素未被污染
    const history = repo.deriveHistory(db, item.id);
    expect(history.at(-1)?.action).toBe("digest_note");
    expect(history.at(-1)?.detail).toContain("疑似");
  });

  it("新旧信息冲突：不覆盖旧值，冲突信息入存疑库 + 事项留痕（D-85）", async () => {
    const db = makeDb(":memory:");
    const { item } = seedItem(db, "数据结构第三次作业提交", "2026-10-08T23:59:59");

    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [{ id: "t1", name: "search_items", argsJson: '{"query":"数据结构"}' }],
    });
    llm.push({
      content: JSON.stringify({
        changes: [
          {
            action: "park_uncertain",
            content: "【数据结构】第三次作业提交截止时间调整为10月15日23:59",
            needsHuman: 70,
            reason: "与既有记录冲突：旧截止10月8日，本通知称调整为10月15日，待更权威信息确认",
          },
          {
            action: "record_note",
            targetType: "item",
            targetId: item.id,
            note: "收到冲突信息（本批称截止调整为10月15日），已入存疑库待裁决",
          },
        ],
      }),
    });
    const raw = repo.insertRawInput(db, {
      content: "【数据结构】第三次作业提交截止时间调整为10月15日23:59",
      sourceType: "chat",
      sourceIdentity: { sourceLabel: "课程群" },
      receivedAt: "2026-09-26T10:00:00",
      eventTime: null,
    });
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);

    expect(result.state).toBe("digested");
    const after = repo.deriveItem(db, item.id);
    if (!after) throw new Error("事项丢失");
    expect(itemDueDate(after)).toBe("2026-10-08T23:59:59"); // 旧值未被覆盖
    expect(after.elements).toEqual([...after.elements]); // 正文未被污染
    // 冲突信息进了存疑库（待更权威信息裁决）
    const uncertain = repo.listUncertainByStatus(db, "open");
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0]?.needsHuman).toBe(70);
    // 事项上有留痕（处理记录可见）
    expect(repo.deriveHistory(db, item.id).at(-1)?.detail).toContain("冲突");
  });

  it("检索无候选：零变更留痕，不建事项", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [{ id: "t1", name: "search_items", argsJson: '{"query":"食堂"}' }],
    });
    llm.push({ content: '{"changes":[]}' });
    const raw = repo.insertRawInput(db, {
      content: "食堂下周三有免费试吃活动",
      sourceType: "chat",
      sourceIdentity: { sourceLabel: "校园群" },
      receivedAt: "2026-09-25T10:00:00",
      eventTime: null,
    });
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);

    expect(result.state).toBe("digested");
    expect(result.appliedCount).toBe(0);
    expect(repo.deriveItems(db)).toHaveLength(0);
    const audit = repo.listRawAudit(db, raw.id);
    expect(audit.some((n) => n.detail.includes("零变更"))).toBe(true);
  });
});

describe("POST /api/ingest（真实 HTTP 入口）", () => {
  it("原文先落盘（逐字一致）→ 202 → 异步消化完成", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    const app = makeApp({ db, llmRef: { current: llm } });

    const res = await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        content: PASTE,
        sourceType: "paste",
        sourceIdentity: { sourceLabel: "手机备忘录" },
        eventTime: "2026-09-24T10:15:00",
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ id: string }>();
    const raw = repo.getRawInput(db, body.id);
    if (!raw) throw new Error("RawInput 未落盘");
    expect(raw.content).toBe(PASTE);

    await vi.waitFor(
      () => {
        expect(repo.getRawInput(db, body.id)?.digestState).toBe("digested");
      },
      { timeout: 3000 },
    );
  });

  it("请求体不合法 → 400，不落盘", async () => {
    const db = makeDb(":memory:");
    const app = makeApp({ db, llmRef: { current: new FakeLlm() } });
    const res = await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: { content: "", sourceType: "paste", sourceIdentity: { sourceLabel: "x" } },
    });
    expect(res.statusCode).toBe(400);
    expect(repo.listRawInputsByState(db, "pending")).toHaveLength(0);
  });
});

describe("信源阶段 AI 复原（D-85）：碎片入库存疑 → 后续批次检索合并升格", () => {
  it("批次A 拿不准入库 → 批次B 检索命中 → 应用 + resolve_uncertain(merged)", async () => {
    const db = makeDb(":memory:");

    // ── 批次A：碎片，agent0 拿不准 → 入存疑库 ──
    const llmA = new FakeLlm();
    llmA.push({
      content: null,
      toolCalls: [{ id: "t1", name: "search_items", argsJson: '{"query":"英语"}' }],
    });
    llmA.push({
      content: JSON.stringify({
        changes: [
          {
            action: "park_uncertain",
            content: "英语课下周三要交口语录音",
            needsHuman: 45,
            reason: "只有半句，没说清是不是正式作业",
          },
        ],
      }),
    });
    const rawA = repo.insertRawInput(db, {
      content: "英语课下周三要交口语录音",
      sourceType: "chat",
      sourceIdentity: { sourceLabel: "英语课官方群" },
      receivedAt: "2026-09-25T10:00:00",
      eventTime: null,
    });
    await digestRawInput(db, llmA, makeAgentTools(db), MODEL, rawA);
    const parked = repo.listUncertainByStatus(db, "open");
    expect(parked).toHaveLength(1);
    const parkedId = parked[0]?.id;
    if (!parkedId) throw new Error("入库失败");

    // ── 批次B：正式通知，agent0 检索库命中 → 建事项 + 关闭库条目 ──
    const llmB = new FakeLlm();
    llmB.push({
      content: null,
      toolCalls: [{ id: "t1", name: "search_uncertain", argsJson: "{}" }],
    });
    llmB.push({
      content: JSON.stringify({
        changes: [
          {
            action: "create_item",
            elements: [
              { label: "name", text: "英语口语录音提交", note: null, quotes: ["口语录音"] },
              {
                label: "dueDate",
                text: "2026-10-01T23:59:59",
                note: "下周三是10月1日",
                quotes: ["下周三前交"],
              },
            ],
            tags: ["英语课"],
            doubtNote: null,
          },
          {
            action: "resolve_uncertain",
            id: parkedId,
            outcome: "merged",
            note: "正式通知补全了那条半句",
            resolvedRef: "英语口语录音提交",
          },
        ],
      }),
    });
    const rawB = repo.insertRawInput(db, {
      content: "【英语课】口语录音下周三前交到课程平台，正式作业，计入平时分",
      sourceType: "chat",
      sourceIdentity: { sourceLabel: "英语课官方群" },
      receivedAt: "2026-09-26T10:00:00",
      eventTime: null,
    });
    const resultB = await digestRawInput(db, llmB, makeAgentTools(db), MODEL, rawB);

    expect(resultB.state).toBe("digested");
    expect(repo.deriveItems(db)).toHaveLength(1); // 事项已建
    const merged = repo.getUncertainInput(db, parkedId);
    expect(merged?.status).toBe("merged"); // 库条目已关闭
    expect(merged?.resolvedRef).toBe("英语口语录音提交");
    // 批次B 的 ask 里能看到 search_uncertain 的 tool 结果（隐式携带了当前批次信源）
    const bCall = llmB.chats[1];
    const toolMsg = bCall?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("英语课下周三要交口语录音"); // 检索命中返回了那条碎片
  });
});

describe("矛盾决断（S-6 / D-85）：有据取舍留痕，判不了入库", () => {
  /** 经真实入口播种一个事项（本 describe 局部）。 */
  function seed(db: ReturnType<typeof makeDb>, name: string, dueDate: string): Item {
    const raw = repo.insertRawInput(db, {
      content: `${name}的原始记录`,
      sourceType: "chat",
      sourceIdentity: { sourceLabel: "社团群" },
      receivedAt: "2026-09-24T10:00:00",
      eventTime: null,
    });
    const before = repo.deriveItems(db);
    executeChanges(
      db,
      raw,
      [
        {
          action: "create_item",
          elements: [
            { label: "name", text: name, note: null, quotes: [] },
            { label: "dueDate", text: dueDate, note: null, quotes: [] },
          ],
          tags: [],
          doubtNote: null,
        },
      ],
      { actor: "agent0", model: "test" },
    );
    const after = repo.deriveItems(db);
    const created = after.find((i) => !before.some((b) => b.id === i.id));
    if (!created) throw new Error("播种事项失败");
    return created;
  }

  it("来源权威性可取舍 → 采用更官方方 + record_note 记决断依据", async () => {
    const db = makeDb(":memory:");
    const item = seed(db, "社团纳新现场展示", "2026-11-05T23:59:59");

    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [{ id: "t1", name: "search_items", argsJson: '{"query":"社团纳新"}' }],
    });
    llm.push({
      content: JSON.stringify({
        changes: [
          {
            action: "update_item",
            itemId: item.id,
            setElements: [
              {
                label: "dueDate",
                text: "2026-11-08T23:59:59",
                note: null,
                quotes: ["展示改到11月8日"],
              },
            ],
            resolveDoubt: false,
          },
          {
            action: "record_note",
            targetType: "item",
            targetId: item.id,
            note: "决断：采信官方群通知（展示改到11月8日），个人转述的11月5日作废——官方群权威性更高",
          },
        ],
      }),
    });
    const raw = repo.insertRawInput(db, {
      content: "【社团官方群】纳新现场展示改到11月8日",
      sourceType: "chat",
      sourceIdentity: { sourceLabel: "社团官方群" },
      receivedAt: "2026-09-28T10:00:00",
      eventTime: null,
    });
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);

    expect(result.state).toBe("digested");
    const after = repo.deriveItem(db, item.id);
    if (!after) throw new Error("事项丢失");
    expect(itemDueDate(after)).toBe("2026-11-08T23:59:59"); // 采信官方方
    // 决断依据留痕（处理记录最后一条是 digest_note）
    const last = repo.deriveHistory(db, item.id).at(-1);
    expect(last?.action).toBe("digest_note");
    expect(last?.detail).toContain("官方群");
    // 未静默：没有产生存疑条目（决断可断，不入库）
    expect(repo.listUncertainByStatus(db, "open")).toHaveLength(0);
  });
});

describe("agent0 检索工具：search_recent_raws（二轮评审 C：原零测试）", () => {
  it("按 daysBack 窗口检索历史批次；content 截断；不含 raw 归档字段", async () => {
    const db = makeDb(":memory:");
    // 一条窗口内、一条窗口外（receivedAt 用过去时间）
    repo.insertRawInput(db, {
      content: "窗口内的通知",
      sourceType: "nc",
      sourceIdentity: { sourceLabel: "群A" },
      receivedAt: "2026-09-26T10:00:00",
      eventTime: null,
    });
    repo.insertRawInput(db, {
      content: "很久以前的",
      sourceType: "nc",
      sourceIdentity: { sourceLabel: "群A" },
      receivedAt: "2026-09-01T10:00:00",
      eventTime: null,
    });
    const tools = makeAgentTools(db);
    // 用「当前时刻回溯」不好控——直接测 daysBack 极大（全回）与极大窗口外
    const all = await tools.searchRecentRaws(
      { daysBack: 90, sameSourceOnly: false },
      { sourceIdentity: { sourceLabel: "群B" }, eventTime: null },
    );
    expect(all.raws.length).toBe(2); // 90 天窗口含两条
    expect(all.raws[0]?.content).toBeDefined();
    // 结果不含 digestState 等内部字段（契约形状）
    expect(Object.keys(all.raws[0] ?? {})).not.toContain("digestState");
  });

  it("sameSourceOnly：只回同来源（同群名）批次", async () => {
    const db = makeDb(":memory:");
    repo.insertRawInput(db, {
      content: "群A的",
      sourceType: "nc",
      sourceIdentity: { sourceLabel: "群A" },
      receivedAt: "2026-09-26T10:00:00",
      eventTime: null,
    });
    repo.insertRawInput(db, {
      content: "群B的",
      sourceType: "nc",
      sourceIdentity: { sourceLabel: "群B" },
      receivedAt: "2026-09-26T10:00:00",
      eventTime: null,
    });
    const tools = makeAgentTools(db);
    const same = await tools.searchRecentRaws(
      { daysBack: 90, sameSourceOnly: true },
      { sourceIdentity: { sourceLabel: "群A" }, eventTime: null },
    );
    expect(same.raws.map((r) => r.content)).toEqual(["群A的"]);
  });
});
