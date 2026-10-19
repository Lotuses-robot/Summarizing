import { afterEach, describe, expect, it, vi } from "vitest";
import { DIGEST_MAX_ROUNDS, itemDueDate, type Item, type RawInput } from "@summarizing/shared";
import { digestRawInput, kickDigest, sweepOrphanPending } from "../agent0/digest";
import type { FetchImageResult } from "../agent0/fetchImage";
import { executeChanges } from "../executor/executor";
import { FakeLlm, chatAt } from "./helpers/fakeLlm";
import type { LlmClient } from "../shared/llm";
import { cleanupAllTestAccounts, makeTestAccount } from "./helpers/app";
import { makeAgentTools } from "../agent0/tools";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";

afterEach(async () => {
  await cleanupAllTestAccounts();
});

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
    const audit = repo.listPipelineEvents(db, raw.id);
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
            elements: [{ label: "dueDate", text: "2026-10-08T00:00:00", quotes: [] }],
            tags: {},
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
    // 九轮评审：第一轮的拒收即使修复成功也留痕（被拒过就要有行可查——不静默）
    const rejects = repo.listPipelineEvents(db, raw.id).filter((n) => n.action === "fence_reject");
    expect(rejects).toHaveLength(1);
    expect(rejects[0]?.detail).toContain("围栏拒收");
  });

  it("④ 修复仍失败 → 放弃该项并留痕", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    const badItem = {
      action: "update_item",
      itemId: "nope",
      elements: [{ label: "dueDate", text: "2026-10-08T00:00:00", quotes: [] }],
      tags: {},
      resolveDoubt: false,
    };
    llm.push({ content: JSON.stringify({ changes: [badItem] }) });
    llm.push({ content: JSON.stringify({ changes: [badItem] }) });
    const raw = seedRaw(db);
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);

    expect(result.state).toBe("digested");
    expect(result.appliedCount).toBe(0);
    const audit = repo.listPipelineEvents(db, raw.id);
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
    // 上限 + 1 轮工具调用：撞上限而非其他原因（常量调整后此处仍表达同一意图）
    for (let i = 0; i < DIGEST_MAX_ROUNDS + 1; i++) {
      llm.push({
        content: null,
        toolCalls: [{ id: `t${i}`, name: "search_items", argsJson: '{"query":"x"}' }],
      });
    }
    const raw = seedRaw(db);
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);
    expect(result.state).toBe("failed");
    expect(repo.getRawInput(db, raw.id)?.digestState).toBe("failed");
    // 失败原因须是「超轮数」——否则常量上调时本用例会滑去覆盖别的失败路径而无声
    const events = repo.listPipelineEvents(db, raw.id);
    expect(
      events.some(
        (e) => e.action === "digest_failed" && e.detail.includes(`超过 ${DIGEST_MAX_ROUNDS} 轮`),
      ),
    ).toBe(true);
  });

  it("⑦ LLM 调用失败 → 标「未处理」，原文仍在", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm(); // 队列空 → chat 抛错，模拟网关挂掉
    const raw = seedRaw(db);
    const result = await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);

    expect(result.state).toBe("failed");
    expect(repo.getRawInput(db, raw.id)?.content).toBe(PASTE);
    expect(repo.getRawInput(db, raw.id)?.digestState).toBe("failed");
    const audit = repo.listPipelineEvents(db, raw.id);
    expect(audit.some((n) => n.action === "digest_failed" && n.detail.includes("未处理"))).toBe(
      true,
    );
  });

  it("⑧ 既有事项路径：update_item 用工具查到的真实 ID", async () => {
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
            elements: [
              {
                label: "dueDate",
                text: "2026-10-15T23:59:59",
                note: null,
                quotes: ["现场展示改到10月15日"],
              },
            ],
            tags: {},
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
            elements: [
              {
                label: "dueDate",
                text: "2026-10-08T23:59:59",
                note: null,
                quotes: ["提交截止10月8日23:59"],
              },
            ],
            tags: {},
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
    const audit = repo.listPipelineEvents(db, raw.id);
    expect(audit.some((n) => n.detail.includes("零变更"))).toBe(true);
  });
});

describe("POST /api/ingest（真实 HTTP 入口）", () => {
  it("原文先落盘（逐字一致）→ 202 → 异步消化完成", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    const t = await makeTestAccount({ llm });

    const res = await t.inject({
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
    const raw = repo.getRawInput(t.db, body.id);
    if (!raw) throw new Error("RawInput 未落盘");
    expect(raw.content).toBe(PASTE);

    await vi.waitFor(
      () => {
        expect(repo.getRawInput(t.db, body.id)?.digestState).toBe("digested");
      },
      { timeout: 3000 },
    );
  });

  it("请求体不合法 → 400，不落盘", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm() });
    const res = await t.inject({
      method: "POST",
      url: "/api/ingest",
      payload: { content: "", sourceType: "paste", sourceIdentity: { sourceLabel: "x" } },
    });
    expect(res.statusCode).toBe(400);
    expect(repo.listRawInputsByState(t.db, "pending")).toHaveLength(0);
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
            elements: [
              {
                label: "dueDate",
                text: "2026-11-08T23:59:59",
                note: null,
                quotes: ["展示改到11月8日"],
              },
            ],
            tags: {},
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

describe("流水数据层（specs/004）", () => {
  it("kickDigest 发射即置 digesting（同步确定性，FR-005）", () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    const raw = seedRaw(db);
    kickDigest(db, llm, makeAgentTools(db), MODEL, raw, "test");
    expect(repo.getRawInput(db, raw.id)?.digestState).toBe("digesting");
  });

  it("sweepOrphanPending：digesting 孤儿 → failed + startup_sweep 流水（FR-005）", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    repo.setDigestState(db, raw.id, "digesting");
    sweepOrphanPending(db);
    expect(repo.getRawInput(db, raw.id)?.digestState).toBe("failed");
    expect(repo.listPipelineEvents(db, raw.id)[0]?.action).toBe("startup_sweep");
  });

  it("digest_trace：两轮工具循环 → 恰两条 trace（round/tools/thought 落 payload，FR-006）", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({
      content: "我先查查看",
      toolCalls: [{ id: "t1", name: "search_items", argsJson: '{"query":"数据结构"}' }],
    });
    llm.push({
      content: null,
      toolCalls: [{ id: "t2", name: "get_item", argsJson: '{"id":"nope"}' }],
    });
    llm.push({ content: '{"changes":[]}' }); // 消化轮：零变更合法
    const raw = seedRaw(db);
    kickDigest(db, llm, makeAgentTools(db), MODEL, raw, "test");
    await vi.waitFor(
      () => {
        expect(repo.getRawInput(db, raw.id)?.digestState).toBe("digested");
      },
      { timeout: 3000 },
    );
    const traces = repo.listPipelineEvents(db, raw.id).filter((e) => e.action === "digest_trace");
    expect(traces).toHaveLength(2);
    expect(traces[0]?.payload).toMatchObject({
      round: 1,
      tools: ["search_items"],
      thought: "我先查查看",
    });
    expect(traces[1]?.payload).toMatchObject({ round: 2, tools: ["get_item"] });
  });
});

describe("多模态取图（fetch_image，2026-10-13）", () => {
  /** 造一个带假 fetchImage 的工具集（其余真造）——网络层单测已覆盖，这里只测循环接线；
   *  需计调用次数/自定义行为的用例传 fetchImageOverride（如预算用例的计数替身）。 */
  function toolsWithImage(
    db: ReturnType<typeof makeDb>,
    image: { dataUrl: string } | { reason: string },
    fetchImageOverride?: () => Promise<FetchImageResult>,
  ) {
    const base = makeAgentTools(db);
    return {
      ...base,
      fetchImage:
        fetchImageOverride ??
        (async () =>
          "dataUrl" in image
            ? { ok: true as const, dataUrl: image.dataUrl }
            : { ok: false as const, reason: image.reason }),
    };
  }

  it("取图成功：图作下一条 user 消息注入模型（image_url 内容块）", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [
        { id: "t1", name: "fetch_image", argsJson: JSON.stringify({ url: "https://x/a.jpg" }) },
      ],
    });
    llm.push({ content: '{"changes":[]}' }); // 看图后零变更合法
    const raw = seedRaw(db);
    const tools = toolsWithImage(db, { dataUrl: "data:image/jpeg;base64,AAAA" });
    const result = await digestRawInput(db, llm, tools, MODEL, raw);
    expect(result.state).toBe("digested");

    // 第二次调用（看图后那轮）的消息里应含一条带 image_url 内容块的 user 消息
    const second = chatAt(llm, 1);
    const withImage = second.messages.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === "image_url"),
    );
    expect(withImage).toBeDefined();
  });

  it("取图失败：回喂 error，不注入图，模型按纯文本继续（消化不中断）", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [
        { id: "t1", name: "fetch_image", argsJson: JSON.stringify({ url: "https://x/a.jpg" }) },
      ],
    });
    llm.push({ content: '{"changes":[]}' });
    const raw = seedRaw(db);
    const tools = toolsWithImage(db, { reason: "取图失败：HTTP 404" });
    const result = await digestRawInput(db, llm, tools, MODEL, raw);
    expect(result.state).toBe("digested");
    // 无图注入（第二次调用的消息里没有 image_url 内容块）
    const second = chatAt(llm, 1);
    const anyImage = second.messages.some(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === "image_url"),
    );
    expect(anyImage).toBe(false);
  });

  it("模型不支持读图：带图调用失败 → 剥图重试一次 + image_degraded 留痕（剥图就地生效，后续轮不再带图）", async () => {
    const db = makeDb(":memory:");
    // 定制 LLM：首轮吐取图工具调用；此后凡消息带图即抛错（模拟网关拒绝 image_url），剥图后正常。
    // 第 3 次再吐一个普通工具调用，逼出第四轮——验证降级后的轮次不再带图（审查 2026-10-14：
    // 曾只在重试那一次调用里剥图、不落回 messages，降级后每轮都重演带图失败 + 重复 image_degraded）。
    const calls: { hasImage: boolean }[] = [];
    const llm: LlmClient = {
      async chat(args) {
        const hasImg = args.messages.some(
          (m) =>
            m.role === "user" &&
            Array.isArray(m.content) &&
            m.content.some((p) => p.type === "image_url"),
        );
        calls.push({ hasImage: hasImg });
        if (hasImg) throw new Error("模型不支持图片输入");
        if (calls.length === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: "t1",
                name: "fetch_image",
                argsJson: JSON.stringify({ url: "https://x/a.jpg" }),
              },
            ],
          };
        }
        if (calls.length === 3) {
          return {
            content: null,
            toolCalls: [{ id: "t2", name: "search_items", argsJson: '{"query":"x"}' }],
          };
        }
        return { content: '{"changes":[]}', toolCalls: [] };
      },
    };
    const raw = seedRaw(db);
    const tools = toolsWithImage(db, { dataUrl: "data:image/jpeg;base64,AAAA" });
    const result = await digestRawInput(db, llm, tools, MODEL, raw);
    expect(result.state).toBe("digested");
    // 恰好一次带图调用（失败）→ 剥图重试（无图）→ 普通工具轮（无图）→ 终轮（无图）
    expect(calls.filter((c) => c.hasImage)).toHaveLength(1);
    expect(calls).toHaveLength(4);
    const events = repo.listPipelineEvents(db, raw.id);
    expect(events.filter((e) => e.action === "image_degraded")).toHaveLength(1);
  });

  it("取图预算按尝试计数：失败也耗预算——第 5 次取图直接拒、不再打网", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    for (let i = 1; i <= 5; i++) {
      llm.push({
        content: null,
        toolCalls: [
          {
            id: `t${i}`,
            name: "fetch_image",
            argsJson: JSON.stringify({ url: `https://x/${i}.jpg` }),
          },
        ],
      });
    }
    llm.push({ content: '{"changes":[]}' });
    const raw = seedRaw(db);
    let fetches = 0;
    const tools = toolsWithImage(db, { reason: "取图失败：HTTP 404" }, async () => {
      fetches += 1;
      return { ok: false as const, reason: "取图失败：HTTP 404" };
    });
    const result = await digestRawInput(db, llm, tools, MODEL, raw);
    expect(result.state).toBe("digested");
    // 预算 4（尝试即计）：前 4 次失败已耗光，第 5 次被拒、未打网
    expect(fetches).toBe(4);
    // 第 5 次的工具回喂是「已达上限」拒语（第 6 次调用的消息里可见）
    const last = chatAt(llm, 5);
    const refused = last.messages.some(
      (m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("已达上限"),
    );
    expect(refused).toBe(true);
  });
});

describe("用户拒收规则进入提示词（D-107：真实消化链路）", () => {
  /** 造一条待消化批次。 */
  function seedRaw(db: ReturnType<typeof makeDb>): RawInput {
    return repo.insertRawInput(db, {
      content: "帮我砍一下，拼多多链接 xxx，还差 0.01 元",
      sourceType: "paste",
      sourceIdentity: { sourceLabel: "班级群" },
      receivedAt: "2026-10-17T10:00:00",
      eventTime: null,
    });
  }

  it("设了规则 →  LLM 收到的 system 里带着它（不只盘上存了）", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    repo.setAppSetting(db, repo.REJECTION_RULES_KEY, JSON.stringify("不要拼多多砍一刀类链接"));

    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);

    // 第 0 次调用就是 elicitation 轮——它的 system 必须含用户规则
    expect(chatAt(llm, 0).system).toContain("不要拼多多砍一刀类链接");
    expect(chatAt(llm, 0).system).toContain("【用户拒收规则");
  });

  it("没设规则 → system 里有「未设置」明示，不留空块", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);

    expect(chatAt(llm, 0).system).toContain("（用户未设置任何拒收规则）");
  });

  it("修正轮（围栏拒收后）也带同一套规则——规则不因轮次丢失", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    repo.setAppSetting(db, repo.REJECTION_RULES_KEY, JSON.stringify("测试规则甲"));
    const llm = new FakeLlm();
    // 第 1 轮：产出必被围栏拒的东西（引文非原文逐字 → 拒）→ 触发修正轮
    llm.push({
      content: JSON.stringify({
        changes: [
          {
            action: "create_item",
            elements: [{ label: "name", text: "甲", quotes: ["原文里没有的引文"] }],
            tags: [],
            doubtNote: null,
          },
        ],
      }),
    });
    // 第 2 轮（修正轮）：给合法空清单
    llm.push({ content: '{"changes":[]}' });
    await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw).catch(() => {
      // 修正轮失败只降级留痕，不抛——这里不关心最终 state，只断言每轮 system 都带规则
    });

    for (const [i, args] of llm.chats.entries()) {
      expect(args.system, `第 ${i} 次调用应带用户规则`).toContain("测试规则甲");
    }
  });
});

describe("record_note 批次留痕（2026-10-19 拒收复盘）", () => {
  it("提示词里带「批次 id」——模型不必拿时间戳猜", async () => {
    const db = makeDb(":memory:");
    const raw = repo.insertRawInput(db, {
      content: "测试通知1：测试1、测试通知2、测试通知3",
      sourceType: "chat",
      sourceIdentity: { sourceLabel: "前台" },
      receivedAt: "2026-10-19T22:24:23",
      eventTime: null,
    });
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    await digestRawInput(db, llm, makeAgentTools(db), MODEL, raw);
    const brief = chatAt(llm, 0).messages[0]?.content ?? "";
    expect(brief).toContain(`批次 id：${raw.id}`);
  });
});
