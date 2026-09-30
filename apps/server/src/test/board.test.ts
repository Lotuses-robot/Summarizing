import { describe, expect, it, vi } from "vitest";
import { itemName, type RawInput } from "@summarizing/shared";
import { executeChanges } from "../features/agent0/executor";
import { makeApp } from "../app";
import { buildBoard } from "../features/board";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";

/** 造一条标准 RawInput 夹具。 */
function seedRaw(db: ReturnType<typeof makeDb>, content = "x"): RawInput {
  return repo.insertRawInput(db, {
    content,
    sourceType: "paste",
    sourceIdentity: { sourceLabel: "s" },
    receivedAt: "2026-09-24T10:00:00",
    eventTime: null,
  });
}

/** 经真实入口造事项。 */
function createItem(
  db: ReturnType<typeof makeDb>,
  raw: RawInput,
  args: { name: string; dueDate?: string; tags?: string[] },
) {
  executeChanges(
    db,
    raw,
    [
      {
        action: "create_item",
        elements: [
          { label: "name", text: args.name, quotes: [] },
          ...(args.dueDate === undefined
            ? []
            : [{ label: "dueDate", text: args.dueDate, note: null, quotes: [] }]),
        ],
        tags: args.tags ?? [],
        doubtNote: null,
      },
    ],
    { actor: "agent0", model: "test" },
  );
  const found = repo.deriveItems(db).find((i) => i.elements.some((e) => e.text === args.name));
  if (!found) throw new Error("事项未创建");
  return found;
}

describe("buildBoard（状态制五段，D-80）", () => {
  it("四段互斥：日期未知、已排期按 ddl 升序（时间钉死防墙钟漂移）；doubtNote 不再影响分段（D-89）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:00:00"));
    try {
      const db = makeDb(":memory:");
      const raw = seedRaw(db);
      createItem(db, raw, { name: "已过期作业", dueDate: "2026-09-01T23:59:00" });
      createItem(db, raw, { name: "未来作业", dueDate: "2027-01-01T23:59:00" });
      createItem(db, raw, { name: "日期未知事项" });
      // D-89：存疑段退场——带 doubtNote 的事项按日期正常归段（不再单独进「存疑段」）
      executeChanges(
        db,
        raw,
        [
          {
            action: "create_item",
            elements: [{ label: "name", text: "疑似口语考试", quotes: [] }],
            tags: [],
            doubtNote: "来源用词『听说』",
          },
        ],
        { actor: "agent0", model: "test" },
      );
      const board = buildBoard(db);

      expect(board.undated.map((i) => i.item.elements[0]?.text).sort()).toEqual([
        "日期未知事项",
        "疑似口语考试",
      ]);
      expect(board.scheduled.map((i) => i.item.elements[0]?.text)).toEqual([
        "已过期作业",
        "未来作业",
      ]);
      expect(board.scheduled[0]?.overdue).toBe(true);
      expect(board.scheduled[1]?.overdue).toBe(false);
      expect(board.failedRawInputs).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("标签在事项上（无面包屑/无任务容器，D-70）", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    executeChanges(
      db,
      raw,
      [
        {
          action: "create_item",
          elements: [
            { label: "name", text: "英语作文", quotes: [] },
            { label: "dueDate", text: "2026-09-30T23:59:00", quotes: [] },
          ],
          tags: ["英语课", "作业"],
          doubtNote: null,
        },
      ],
      { actor: "agent0", model: "test" },
    );
    const board = buildBoard(db);
    expect(board.scheduled[0]?.item.tags).toEqual(["英语课", "作业"]);
  });

  it("失败批次出现在 failedRawInputs（未处理可见）", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    repo.setDigestState(db, raw.id, "failed");
    const board = buildBoard(db);
    expect(board.failedRawInputs.map((r) => r.id)).toEqual([raw.id]);
  });

  it("已完成全量归 done 段（带日期也不回已排期、不再判过期；archived 恒空占位）", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    createItem(db, raw, { name: "交表", dueDate: "2026-09-30T23:59:00" });
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("事项未创建");
    repo.appendItemVersion(db, {
      itemId: item.id,
      action: "complete_item",
      detail: `标完成「${itemName(item.elements)}」`,
      snapshot: { ...item, status: "done" },
      by: { actor: "用户", model: null },
    });
    const board = buildBoard(db);
    expect(board.done.map((r) => r.item.elements[0]?.text)).toEqual(["交表"]);
    expect(board.scheduled).toHaveLength(0);
    expect(board.archived).toHaveLength(0);
    expect(board.done[0]?.overdue).toBe(false);
  });

  it("已完成段按完成时刻倒序（最新在上，D-83 二轮）", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-27T08:00:00"));
      const db = makeDb(":memory:");
      const raw = seedRaw(db);
      createItem(db, raw, { name: "早完成" });
      createItem(db, raw, { name: "晚完成" });
      const items = repo.deriveItems(db);
      const early = items.find((i) => i.elements[0]?.text === "早完成");
      const late = items.find((i) => i.elements[0]?.text === "晚完成");
      if (!early || !late) throw new Error("播种失败");

      vi.setSystemTime(new Date("2026-09-27T08:30:00"));
      repo.appendItemVersion(db, {
        itemId: early.id,
        action: "complete_item",
        detail: "标完成「早完成」",
        snapshot: { ...early, status: "done" },
        by: { actor: "用户", model: null },
      });
      vi.setSystemTime(new Date("2026-09-27T20:00:00"));
      repo.appendItemVersion(db, {
        itemId: late.id,
        action: "complete_item",
        detail: "标完成「晚完成」",
        snapshot: { ...late, status: "done" },
        by: { actor: "用户", model: null },
      });

      const board = buildBoard(db);
      expect(board.done.map((r) => r.item.elements[0]?.text)).toEqual(["晚完成", "早完成"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("updatedAt = 最新版本时间（「新」微标数据源）", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    createItem(db, raw, { name: "带时间的行" });
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("事项未创建");
    const last = repo.deriveHistory(db, item.id).at(-1);
    if (!last) throw new Error("应有版本");
    const row = buildBoard(db).undated.find((r) => r.item.id === item.id);
    expect(row?.updatedAt).toBe(last.at);
  });
});

describe("事项读写接口（真实 HTTP 入口）", () => {
  it("GET /api/items/:id 返回详情（元素+证据+版本史）", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    createItem(db, raw, { name: "英语作文", dueDate: "2026-09-30T23:59:00" });
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("事项未创建");
    const app = makeApp({
      db,
      llmRef: { current: { chat: async () => ({ content: null, toolCalls: [] }), modelTag: "t" } },
    });

    const res = await app.inject({ method: "GET", url: `/api/items/${item.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      item: { id: string };
      versions: unknown[];
      rawInputs: Record<string, { content: string }>;
    }>();
    expect(body.item.id).toBe(item.id);
    expect(body.versions).toHaveLength(1); // 版本链（处理记录数据源）
    expect(body.rawInputs).toEqual({}); // 无证据 → 批次原文空表

    // 引文悬浮窗数据链（05§三）：fragments 引用到的批次原文随详情返回
    const frag = repo.getOrCreateFragment(db, "群里的原话全文", raw.id);
    repo.addEvidence(db, {
      itemId: item.id,
      subject: "元素:name",
      fragmentId: frag.id,
      by: "test",
    });
    const res2 = await app.inject({ method: "GET", url: `/api/items/${item.id}` });
    const body2 = res2.json<{ rawInputs: Record<string, { content: string }> }>();
    // 是批次原文（raw_inputs.content = "x"），不是片段内容——悬浮窗要的就是整条原话
    expect(body2.rawInputs[raw.id]?.content).toBe("x");
  });

  it("complete / confirm：写入生效且落 user 的版本节点", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    executeChanges(
      db,
      raw,
      [
        {
          action: "create_item",
          elements: [{ label: "name", text: "疑似口语考试", quotes: [] }],
          tags: [],
          doubtNote: "来源用词『听说』",
        },
      ],
      { actor: "agent0", model: "test" },
    );
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("事项未创建");
    const app = makeApp({
      db,
      llmRef: { current: { chat: async () => ({ content: null, toolCalls: [] }), modelTag: "t" } },
    });

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/items/${item.id}/confirm`,
      payload: { note: "我了解清楚了" },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json<{ doubtNote: string | null }>().doubtNote).toBeNull();

    const done = await app.inject({
      method: "POST",
      url: `/api/items/${item.id}/complete`,
    });
    expect(done.json<{ status: string }>().status).toBe("done");

    const versions = repo.deriveHistory(db, item.id);
    // create（agent0）+ resolve_doubt + complete（user）＝ 3 个版本
    expect(versions.map((v) => v.by)).toEqual([
      { actor: "agent0", model: "test" },
      { actor: "用户", model: null },
      { actor: "用户", model: null },
    ]);
    expect(versions.slice(1).map((v) => v.action)).toEqual(["resolve_doubt", "complete_item"]);
  });

  it("reopen（D-82）：done → todo 往返、版本链留 user 节点；不存在 → 404", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    createItem(db, raw, { name: "可逆事项" });
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("事项未创建");
    const app = makeApp({
      db,
      llmRef: { current: { chat: async () => ({ content: null, toolCalls: [] }), modelTag: "t" } },
    });

    const done = await app.inject({ method: "POST", url: `/api/items/${item.id}/complete` });
    expect(done.json<{ status: string }>().status).toBe("done");

    const reopened = await app.inject({ method: "POST", url: `/api/items/${item.id}/reopen` });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json<{ status: string }>().status).toBe("todo");

    const versions = repo.deriveHistory(db, item.id);
    expect(versions.map((v) => v.action)).toEqual(["create_item", "complete_item", "reopen_item"]);
    expect(versions.slice(1).map((v) => v.by)).toEqual([
      { actor: "用户", model: null },
      { actor: "用户", model: null },
    ]);

    const missing = await app.inject({ method: "POST", url: "/api/items/nope/reopen" });
    expect(missing.statusCode).toBe(404);
  });

  it("标记已查看：viewed 路由 204 幂等，看板行 viewed 翻转（「新」数据源）", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    createItem(db, raw, { name: "未读行" });
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("播种失败");
    const app = makeApp({
      db,
      llmRef: { current: { chat: async () => ({ content: null, toolCalls: [] }), modelTag: "t" } },
    });

    expect(buildBoard(db).undated[0]?.viewed).toBe(false);
    const res = await app.inject({ method: "POST", url: `/api/items/${item.id}/viewed` });
    expect(res.statusCode).toBe(204);
    expect(buildBoard(db).undated[0]?.viewed).toBe(true);
    const again = await app.inject({ method: "POST", url: `/api/items/${item.id}/viewed` });
    expect(again.statusCode).toBe(204); // 幂等
    const miss = await app.inject({ method: "POST", url: "/api/items/nope/viewed" });
    expect(miss.statusCode).toBe(404);
  });

  it("双归档往返：连续 archive; archive; reopen → 回到 todo（preArchivedStatus 活锁回归，D-83 二轮）", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    createItem(db, raw, { name: "反复归档" });
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("播种失败");
    const app = makeApp({
      db,
      llmRef: { current: { chat: async () => ({ content: null, toolCalls: [] }), modelTag: "t" } },
    });

    await app.inject({ method: "POST", url: `/api/items/${item.id}/archive` });
    await app.inject({ method: "POST", url: `/api/items/${item.id}/archive` });
    const reopened = await app.inject({ method: "POST", url: `/api/items/${item.id}/reopen` });
    expect(reopened.json<{ status: string }>().status).toBe("todo");
  });

  it("撤回归档（D-83 二轮）：done 项归档后撤回归档 → 仍是 done（完成状态保留）", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-27T08:00:00"));
      const db = makeDb(":memory:");
      const raw = seedRaw(db);
      createItem(db, raw, { name: "先完成后归档" });
      const item = repo.deriveItems(db)[0];
      if (!item) throw new Error("事项未创建");
      const app = makeApp({
        db,
        llmRef: {
          current: { chat: async () => ({ content: null, toolCalls: [] }), modelTag: "t" },
        },
      });

      await app.inject({ method: "POST", url: `/api/items/${item.id}/complete` });
      await app.inject({ method: "POST", url: `/api/items/${item.id}/archive` });
      expect(repo.deriveItem(db, item.id)?.status).toBe("archived");

      const reopened = await app.inject({ method: "POST", url: `/api/items/${item.id}/reopen` });
      expect(reopened.statusCode).toBe(200);
      // 撤回归档只撤归档：回到完成状态，不强制回待办
      expect(reopened.json<{ status: string }>().status).toBe("done");

      const versions = repo.deriveHistory(db, item.id);
      expect(versions.map((v) => v.action)).toEqual([
        "create_item",
        "complete_item",
        "archive_item",
        "reopen_item",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("archive（D-83 最小归档）：todo → archived 落归档段；reopen 从归档恢复", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    createItem(db, raw, { name: "要归档的事项" });
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("事项未创建");
    const app = makeApp({
      db,
      llmRef: { current: { chat: async () => ({ content: null, toolCalls: [] }), modelTag: "t" } },
    });

    const archived = await app.inject({ method: "POST", url: `/api/items/${item.id}/archive` });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ status: string }>().status).toBe("archived");
    expect(archived.json<{ doubtNote: string | null }>().doubtNote).toBeNull();

    const board = buildBoard(db);
    expect(board.archived.map((r) => r.item.elements[0]?.text)).toEqual(["要归档的事项"]);
    expect(board.scheduled).toHaveLength(0);

    const reopened = await app.inject({ method: "POST", url: `/api/items/${item.id}/reopen` });
    expect(reopened.json<{ status: string }>().status).toBe("todo");

    const versions = repo.deriveHistory(db, item.id);
    expect(versions.map((v) => v.action)).toEqual(["create_item", "archive_item", "reopen_item"]);
  });

  it("不存在的事项 → 404", async () => {
    const db = makeDb(":memory:");
    const app = makeApp({
      db,
      llmRef: { current: { chat: async () => ({ content: null, toolCalls: [] }), modelTag: "t" } },
    });
    const res = await app.inject({ method: "GET", url: "/api/items/nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("失败批次重试（D-71）", () => {
  it("failed → 重试 → 消化管线重跑成功，状态 digested、变更落库", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    repo.setDigestState(db, raw.id, "failed");
    const app = makeApp({
      db,
      llmRef: {
        current: {
          chat: async () => ({
            content: JSON.stringify({
              changes: [
                {
                  action: "create_item",
                  elements: [{ label: "name", text: "重试后的事项", quotes: [] }],
                  tags: [],
                  doubtNote: null,
                },
              ],
            }),
            toolCalls: [],
          }),
          modelTag: "t",
        },
      },
    });

    const res = await app.inject({ method: "POST", url: `/api/raw/${raw.id}/retry` });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ digestState: string }>().digestState).toBe("pending");

    // 异步消化：FakeLlm 即返，等待状态稳定
    await vi.waitFor(
      () => {
        expect(repo.getRawInput(db, raw.id)?.digestState).toBe("digested");
      },
      { timeout: 3000 },
    );
    expect(repo.deriveItems(db).map((i) => i.elements[0]?.text)).toEqual(["重试后的事项"]);
  });

  it("重试再失败 → 状态回 failed（横幅复现，原文仍不丢）", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    repo.setDigestState(db, raw.id, "failed");
    const app = makeApp({
      db,
      llmRef: {
        current: { chat: async () => Promise.reject(new Error("网关还是挂的")), modelTag: "t" },
      },
    });

    const res = await app.inject({ method: "POST", url: `/api/raw/${raw.id}/retry` });
    expect(res.statusCode).toBe(202);
    await vi.waitFor(
      () => {
        expect(repo.getRawInput(db, raw.id)?.digestState).toBe("failed");
      },
      { timeout: 3000 },
    );
  });

  it("已消化批次不可重试（409，防重复落库）", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    repo.setDigestState(db, raw.id, "digested");
    const app = makeApp({
      db,
      llmRef: { current: { chat: async () => ({ content: null, toolCalls: [] }), modelTag: "t" } },
    });
    const res = await app.inject({ method: "POST", url: `/api/raw/${raw.id}/retry` });
    expect(res.statusCode).toBe(409);
  });

  it("不存在的批次 → 404", async () => {
    const db = makeDb(":memory:");
    const app = makeApp({
      db,
      llmRef: { current: { chat: async () => ({ content: null, toolCalls: [] }), modelTag: "t" } },
    });
    const res = await app.inject({ method: "POST", url: "/api/raw/nope/retry" });
    expect(res.statusCode).toBe(404);
  });
});
