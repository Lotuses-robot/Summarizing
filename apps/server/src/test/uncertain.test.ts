import { describe, expect, it } from "vitest";
import { ChangeListSchema, type Item, type RawInput } from "@summarizing/shared";
import { makeApp } from "../app";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";
import { digestRawInput } from "../agent0/digest";
import { executeChanges } from "../executor/executor";
import { sweepUncertainLibrary } from "../agent0/sweep";
import { makeAgentTools } from "../agent0/tools";
import { FakeLlm } from "./helpers/fakeLlm";

// 存疑信息库（D-85）：park_uncertain 入库 / resolve_uncertain 流转 / 查询端点排序 /
// 词表 -mark_doubt。库是信息层池子——不生成事项、不挂候选。

/** 经真实入口播种一条批次。 */
function seedRaw(db: ReturnType<typeof makeDb>, content = "原始通知"): RawInput {
  return repo.insertRawInput(db, {
    content,
    sourceType: "chat",
    sourceIdentity: { sourceLabel: "课程群" },
    receivedAt: "2026-09-28T10:00:00",
    eventTime: null,
  });
}

/** 经真实入口播种一个事项（供 resolve merged 去向引用）。 */
function seedItem(db: ReturnType<typeof makeDb>, raw: RawInput): Item {
  const before = repo.deriveItems(db);
  executeChanges(
    db,
    raw,
    [
      {
        action: "create_item",
        elements: [{ label: "name", text: "作业提交", note: null, quotes: [] }],
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

describe("存疑信息库（D-85）", () => {
  it("park_uncertain：入库（信源快照从当批带）+ 不生成事项、不入版本链", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db, "听说要加口语考试");
    const { details } = executeChanges(
      db,
      raw,
      [
        {
          action: "park_uncertain",
          content: "听说要加口语考试",
          needsHuman: 80,
          reason: "原文用『听说』，来源为口述",
        },
      ],
      { actor: "agent0", model: "test" },
    );
    expect(details).toHaveLength(1);
    expect(repo.deriveItems(db)).toHaveLength(0); // 不生成事项
    const open = repo.listUncertainByStatus(db, "open");
    expect(open).toHaveLength(1);
    const entry = open[0];
    expect(entry?.content).toBe("听说要加口语考试");
    expect(entry?.needsHuman).toBe(80);
    expect(entry?.sourceIdentity).toEqual({ sourceLabel: "课程群" }); // 信源快照从当批带
    expect(entry?.originRawInputId).toBe(raw.id);
    expect(entry?.status).toBe("open");
  });

  it("resolve_uncertain：merged 需给去向；discarded 记审计；条目状态流转", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    const item = seedItem(db, raw);

    executeChanges(
      db,
      raw,
      [
        { action: "park_uncertain", content: "碎片A", needsHuman: 40, reason: "缺日期" },
        { action: "park_uncertain", content: "碎片B", needsHuman: 40, reason: "缺日期" },
      ],
      { actor: "agent0", model: "test" },
    );
    const open = repo.listUncertainByStatus(db, "open");
    const a = open.find((u) => u.content === "碎片A");
    const b = open.find((u) => u.content === "碎片B");
    if (!a || !b) throw new Error("入库失败");

    executeChanges(
      db,
      raw,
      [
        {
          action: "resolve_uncertain",
          id: a.id,
          outcome: "merged",
          note: "并入作业事项",
          resolvedRef: item.id,
        },
        { action: "resolve_uncertain", id: b.id, outcome: "discarded", note: "后续确认是误传" },
      ],
      { actor: "agent0", model: "test" },
    );
    expect(repo.listUncertainByStatus(db, "open")).toHaveLength(0);
    const merged = repo.getUncertainInput(db, a.id);
    expect(merged?.status).toBe("merged");
    expect(merged?.resolvedRef).toBe(item.id);
    expect(merged?.resolvedAt).not.toBeNull();
    expect(repo.getUncertainInput(db, b.id)?.status).toBe("discarded");
    // 处置有审计留痕
    expect(repo.listPipelineEvents(db, raw.id).some((n) => n.action === "uncertain_resolved")).toBe(
      true,
    );
  });

  it("围栏：resolve_uncertain 目标不存在 → 拒收（走 digest 全链路）", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    const llm = new FakeLlm();
    // 第一轮：agent0 产出指向不存在条目的 resolve_uncertain
    llm.push({
      content: null,
      toolCalls: [{ id: "t1", name: "search_items", argsJson: '{"query":"x"}' }],
    });
    llm.push({
      content: JSON.stringify({
        changes: [{ action: "resolve_uncertain", id: "ghost", outcome: "discarded", note: "x" }],
      }),
    });
    // 修正轮仍提交同一个坏项（模拟模型改不对）→ 放弃并留痕
    llm.push({
      content: JSON.stringify({
        changes: [{ action: "resolve_uncertain", id: "ghost", outcome: "discarded", note: "x" }],
      }),
    });

    const result = await digestRawInput(db, llm, makeAgentTools(db), "test-model", raw);
    expect(result.state).toBe("digested"); // 拒收项被丢弃，批次仍消化
    expect(result.appliedCount).toBe(0); // 坏目标未落库
    // 消化留痕：围栏拒收（不静默）
    expect(repo.listPipelineEvents(db, raw.id).some((n) => n.detail.includes("拒收"))).toBe(true);
  });

  it("围栏：resolve_uncertain outcome=merged 缺去向 → 拒收", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    // 先真入一条
    executeChanges(
      db,
      raw,
      [{ action: "park_uncertain", content: "c", needsHuman: 10, reason: "r" }],
      { actor: "agent0", model: "test" },
    );
    const entry = repo.listUncertainByStatus(db, "open")[0];
    if (!entry) throw new Error("入库失败");

    const llm = new FakeLlm();
    llm.push({
      content: null,
      toolCalls: [{ id: "t1", name: "search_items", argsJson: '{"query":"x"}' }],
    });
    llm.push({
      content: JSON.stringify({
        changes: [{ action: "resolve_uncertain", id: entry.id, outcome: "merged", note: "x" }],
      }),
    });
    llm.push({ content: '{"changes":[]}' });

    const result = await digestRawInput(db, llm, makeAgentTools(db), "test-model", raw);
    expect(result.state).toBe("digested");
    // 条目仍在 open（缺去向的 merged 被围栏拒）
    expect(repo.getUncertainInput(db, entry.id)?.status).toBe("open");
  });

  it("词表：mark_doubt 已删（解析拒收），park_uncertain/resolve_uncertain 在册", () => {
    const markDoubt = ChangeListSchema.safeParse({
      changes: [{ action: "mark_doubt", itemId: "x", note: "n" }],
    });
    expect(markDoubt.success).toBe(false); // 旧动作已从词表移除
    const park = ChangeListSchema.safeParse({
      changes: [{ action: "park_uncertain", content: "c", needsHuman: 50, reason: "r" }],
    });
    expect(park.success).toBe(true);
    // needsHuman 越界拒收
    const bad = ChangeListSchema.safeParse({
      changes: [{ action: "park_uncertain", content: "c", needsHuman: 101, reason: "r" }],
    });
    expect(bad.success).toBe(false);
  });
});

describe("GET /api/uncertain（查询端点，人工通道排序）", () => {
  it("按状态筛 + needsHuman 倒序、破平新到旧", async () => {
    const db = makeDb(":memory:");
    const app = makeApp({ db, llmRef: { current: new FakeLlm() } });
    const raw = seedRaw(db);
    executeChanges(
      db,
      raw,
      [
        { action: "park_uncertain", content: "低", needsHuman: 10, reason: "r" },
        { action: "park_uncertain", content: "高", needsHuman: 90, reason: "r" },
        { action: "park_uncertain", content: "中", needsHuman: 50, reason: "r" },
      ],
      { actor: "agent0", model: "test" },
    );

    const res = await app.inject({ method: "GET", url: "/api/uncertain" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ content: string; needsHuman: number }[]>();
    expect(body.map((e) => e.content)).toEqual(["高", "中", "低"]); // 最需要人工处理的浮前
  });

  it("POST /api/uncertain/sweep：空库 → 200 且 evaluated 0（清扫循环已接线）", async () => {
    const db = makeDb(":memory:");
    const llm = new FakeLlm();
    const app = makeApp({ db, llmRef: { current: llm } });
    const res = await app.inject({ method: "POST", url: "/api/uncertain/sweep" });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ evaluated: number }>().evaluated).toBe(0);
  });
});

describe("清扫循环（D-85）：丢被取代的、留仍有效的", () => {
  it("agent0 判定某条已被取代 → 丢弃留痕；仍有效的条目保留不动", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db, "两条拿不准的");
    executeChanges(
      db,
      raw,
      [
        { action: "park_uncertain", content: "旧说法A", needsHuman: 30, reason: "缺日期" },
        { action: "park_uncertain", content: "仍然有效B", needsHuman: 70, reason: "冲突待裁决" },
      ],
      { actor: "agent0", model: "test" },
    );
    const open = repo.listUncertainByStatus(db, "open");
    const a = open.find((u) => u.content === "旧说法A");
    if (!a) throw new Error("入库失败");
    // 排序：needsHuman 倒序 → 先复核 B(70) 再复核 A(30)

    const llm = new FakeLlm();
    // 第一条（B，仍有效）→ 保留不动
    llm.push({ content: '{"changes":[]}' });
    // 第二条（A）→ 判丢弃
    llm.push({
      content: JSON.stringify({
        changes: [
          { action: "resolve_uncertain", id: a.id, outcome: "discarded", note: "已被后续通知取代" },
        ],
      }),
    });

    const result = await sweepUncertainLibrary(db, llm, "test-model", "test");
    expect(result.evaluated).toBe(2);
    expect(result.discarded).toBe(1);
    expect(repo.getUncertainInput(db, a.id)?.status).toBe("discarded");
    expect(repo.listUncertainByStatus(db, "open")).toHaveLength(1); // B 仍 open
    // 丢弃有审计留痕
    expect(repo.listPipelineEvents(db, raw.id).some((n) => n.action === "uncertain_resolved")).toBe(
      true,
    );
  });

  it("清扫围栏：模型试图改事项 → 被忽略（清扫只许动库）", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    const item = seedItem(db, raw);
    executeChanges(
      db,
      raw,
      [{ action: "park_uncertain", content: "x", needsHuman: 10, reason: "r" }],
      { actor: "agent0", model: "test" },
    );
    const before = repo.deriveItem(db, item.id);

    const llm = new FakeLlm();
    // 模型越界：想 complete_item（清扫不该碰事项）
    llm.push({
      content: JSON.stringify({ changes: [{ action: "complete_item", itemId: item.id }] }),
    });

    await sweepUncertainLibrary(db, llm, "test-model", "test");
    // 事项状态未变（越界动作被过滤掉）
    expect(repo.deriveItem(db, item.id)?.status).toBe(before?.status);
  });
});

describe("resolve 原子前置与清扫互斥（二轮评审 A2/A5）", () => {
  it("resolveUncertainInput 仅 open 可处置——已关闭条目不被复活/覆盖（A5）", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    executeChanges(
      db,
      raw,
      [{ action: "park_uncertain", content: "c", needsHuman: 10, reason: "r" }],
      { actor: "agent0", model: "test" },
    );
    const entry = repo.listUncertainByStatus(db, "open")[0];
    if (!entry) throw new Error("入库失败");

    // 第一次处置（discarded）成功
    expect(
      repo.resolveUncertainInput(db, {
        id: entry.id,
        status: "discarded",
        resolvedRef: null,
        resolvedAt: "2026-09-29T00:00:00",
      }),
    ).toBe(true);
    // 第二次处置（merged，试图改写）——被拒（非 open）
    expect(
      repo.resolveUncertainInput(db, {
        id: entry.id,
        status: "merged",
        resolvedRef: "somewhere",
        resolvedAt: "2026-09-29T00:01:00",
      }),
    ).toBe(false);
    expect(repo.getUncertainInput(db, entry.id)?.status).toBe("discarded"); // 未被覆盖
  });

  it("清扫互斥：并发第二轮被拒（busy）", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    executeChanges(
      db,
      raw,
      [{ action: "park_uncertain", content: "c", needsHuman: 10, reason: "r" }],
      { actor: "agent0", model: "test" },
    );
    const llm = new FakeLlm();
    // 第一轮要复核 1 条：让它的 LLM 调用「卡住」到第二轮发起之后才返回
    /** 闸门放行函数（由 gate Promise 捕获；先给空实现避免 TS 窄化为 null）。 */
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowLlm = {
      modelTag: "test-model",
      chat: async () => {
        await gate;
        return { content: '{"changes":[]}', toolCalls: [] };
      },
    };
    const p1 = sweepUncertainLibrary(db, slowLlm, "test-model", "test");
    // 第一轮在等 LLM——此时发起第二轮，应立刻拿到 busy
    const r2 = await sweepUncertainLibrary(db, llm, "test-model", "test");
    expect(r2.busy).toBe(true);
    expect(r2.evaluated).toBe(0);
    release();
    const r1 = await p1;
    expect(r1.busy).toBeUndefined();
    expect(r1.evaluated).toBe(1);
  });
});

describe("resolve 并发安全（终轮验证：已处置 ≠ 不存在）", () => {
  it("条目已由别处处置 → 跳过（不炸整批）；与同批其他变更共存", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db, "并发处置测试");
    executeChanges(
      db,
      raw,
      [{ action: "park_uncertain", content: "会被抢占的条目", needsHuman: 30, reason: "r" }],
      { actor: "agent0", model: "test" },
    );
    const entry = repo.listUncertainByStatus(db, "open")[0];
    if (!entry) throw new Error("入库失败");
    // 模拟「别处先处置了它」（如同步清扫）
    repo.resolveUncertainInput(db, {
      id: entry.id,
      status: "discarded",
      resolvedRef: null,
      resolvedAt: "2026-09-29T00:00:00",
    });

    // 现在消化批次同时含 create_item + resolve 同一条目——应：事项照建、条目跳过、不抛错
    const before = repo.deriveItems(db);
    expect(() =>
      executeChanges(
        db,
        raw,
        [
          {
            action: "create_item",
            elements: [{ label: "name", text: "并发下该建的事项", note: null, quotes: [] }],
            tags: [],
            doubtNote: null,
          },
          {
            action: "resolve_uncertain",
            id: entry.id,
            outcome: "merged",
            note: "我慢了一步",
            resolvedRef: "x",
          },
        ],
        { actor: "agent0", model: "test" },
      ),
    ).not.toThrow();
    expect(repo.deriveItems(db).length).toBe(before.length + 1); // 事项真的建了（没被回滚）
    expect(repo.getUncertainInput(db, entry.id)?.status).toBe("discarded"); // 原处置未被覆盖
  });
});

describe("存疑库人工移除端点（D-88 T4：PUT /api/uncertain/:id）", () => {
  /** 直接入库一条 open（绕过 agent0——本组测的是端点不是词表）。 */
  function seedOpen(db: ReturnType<typeof makeDb>): string {
    const raw = seedRaw(db);
    const entry = repo.insertUncertainInput(db, {
      content: "拿不准的消息",
      sourceType: raw.sourceType,
      sourceIdentity: raw.sourceIdentity,
      eventTime: null,
      receivedAt: "2026-09-28T10:00:00",
      originRawInputId: raw.id,
      needsHuman: 60,
      reason: "口述无佐证",
      createdAt: "2026-09-28T10:00:00",
    });
    return entry.id;
  }

  it("open 条目 → 204，状态置 discarded（resolvedRef=manual）", async () => {
    const db = makeDb(":memory:");
    const id = seedOpen(db);
    const app = makeApp({ db, llmRef: { current: new FakeLlm() } });
    const res = await app.inject({ method: "PUT", url: `/api/uncertain/${id}` });
    expect(res.statusCode).toBe(204);
    const entry = repo.getUncertainInput(db, id);
    expect(entry?.status).toBe("discarded");
    expect(entry?.resolvedRef).toBe("manual");
    expect(entry?.resolvedAt).not.toBeNull();
  });

  it("不存在的 id → 404；已处置的条目再移除 → 409（不复活不覆盖）", async () => {
    const db = makeDb(":memory:");
    const id = seedOpen(db);
    const app = makeApp({ db, llmRef: { current: new FakeLlm() } });
    const missing = await app.inject({ method: "PUT", url: "/api/uncertain/nope" });
    expect(missing.statusCode).toBe(404);

    await app.inject({ method: "PUT", url: `/api/uncertain/${id}` }); // 第一次处置
    const again = await app.inject({ method: "PUT", url: `/api/uncertain/${id}` });
    expect(again.statusCode).toBe(409);
  });
});
