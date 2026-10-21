import { afterEach, describe, expect, it, vi } from "vitest";
import { itemName, type RawInput } from "@summarizing/shared";
import { executeChanges } from "../executor/executor";
import { makeAgentTools } from "../agent0/tools";
import { buildBoard } from "../application/board";
import { deriveNotices } from "../application/notice";
import { deriveTrashed } from "../application/trash";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";
import { cleanupAllTestAccounts, makeTestAccount } from "./helpers/app";
import { FakeLlm } from "./helpers/fakeLlm";
import { parseWallClock } from "../shared/time";

// 006：HTTP 用例统一经 makeTestAccount 打真实入口（真账户 + 真会话 cookie，断言走真实认证链）。
// 时间播种一律走 parseWallClock（无时区串按 +08:00 解析）——new Date(裸串) 会按机器本地时区解释，
// 在非北京机器（如 CI 的 UTC）上 seeded「现在」整体偏 8h（2026-10-12 CI 实测）。

afterEach(cleanupAllTestAccounts);

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
  args: { name: string; dueDate?: string; tags?: string[]; kind?: "task" | "notice" },
) {
  executeChanges(
    db,
    raw,
    [
      {
        action: "create_item",
        ...(args.kind === undefined ? {} : { kind: args.kind }),
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

describe("buildBoard（状态制三段；D-80 五段 → 007 三段）", () => {
  it("三段互斥：日期未知、已排期按 ddl 升序（时间钉死防墙钟漂移）；doubtNote 不再影响分段（D-89）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(parseWallClock("2026-09-26T12:00:00"));
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

  it("已完成全量归 done 段（带日期也不回已排期、不再判过期）", () => {
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
    expect(board.undated).toHaveLength(0);
    expect(board.done[0]?.overdue).toBe(false);
  });

  it("已完成段按完成时刻倒序（最新在上，D-83 二轮）", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(parseWallClock("2026-09-27T08:00:00"));
      const db = makeDb(":memory:");
      const raw = seedRaw(db);
      createItem(db, raw, { name: "早完成" });
      createItem(db, raw, { name: "晚完成" });
      const items = repo.deriveItems(db);
      const early = items.find((i) => i.elements[0]?.text === "早完成");
      const late = items.find((i) => i.elements[0]?.text === "晚完成");
      if (!early || !late) throw new Error("播种失败");

      vi.setSystemTime(parseWallClock("2026-09-27T08:30:00"));
      repo.appendItemVersion(db, {
        itemId: early.id,
        action: "complete_item",
        detail: "标完成「早完成」",
        snapshot: { ...early, status: "done" },
        by: { actor: "用户", model: null },
      });
      vi.setSystemTime(parseWallClock("2026-09-27T20:00:00"));
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
    const t = await makeTestAccount({ llm: new FakeLlm("t") });
    const raw = seedRaw(t.db);
    createItem(t.db, raw, { name: "英语作文", dueDate: "2026-09-30T23:59:00" });
    const item = repo.deriveItems(t.db)[0];
    if (!item) throw new Error("事项未创建");

    const res = await t.inject({ method: "GET", url: `/api/items/${item.id}` });
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
    const frag = repo.getOrCreateFragment(t.db, "群里的原话全文", raw.id);
    repo.addEvidence(t.db, {
      itemId: item.id,
      subject: "元素:name",
      fragmentId: frag.id,
      by: "test",
    });
    const res2 = await t.inject({ method: "GET", url: `/api/items/${item.id}` });
    const body2 = res2.json<{ rawInputs: Record<string, { content: string }> }>();
    // 是批次原文（raw_inputs.content = "x"），不是片段内容——悬浮窗要的就是整条原话
    expect(body2.rawInputs[raw.id]?.content).toBe("x");
  });

  it("complete / confirm：写入生效且落 user 的版本节点", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm("t") });
    const raw = seedRaw(t.db);
    executeChanges(
      t.db,
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
    const item = repo.deriveItems(t.db)[0];
    if (!item) throw new Error("事项未创建");

    const confirmed = await t.inject({
      method: "POST",
      url: `/api/items/${item.id}/confirm`,
      payload: { note: "我了解清楚了" },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json<{ doubtNote: string | null }>().doubtNote).toBeNull();

    const done = await t.inject({
      method: "POST",
      url: `/api/items/${item.id}/complete`,
    });
    expect(done.json<{ status: string }>().status).toBe("done");

    const versions = repo.deriveHistory(t.db, item.id);
    // create（agent0）+ resolve_doubt + complete（user）＝ 3 个版本
    expect(versions.map((v) => v.by)).toEqual([
      { actor: "agent0", model: "test" },
      { actor: "用户", model: null },
      { actor: "用户", model: null },
    ]);
    expect(versions.slice(1).map((v) => v.action)).toEqual(["resolve_doubt", "complete_item"]);
  });

  it("reopen（D-82）：done → todo 往返、版本链留 user 节点；不存在 → 404", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm("t") });
    const raw = seedRaw(t.db);
    createItem(t.db, raw, { name: "可逆事项" });
    const item = repo.deriveItems(t.db)[0];
    if (!item) throw new Error("事项未创建");

    const done = await t.inject({ method: "POST", url: `/api/items/${item.id}/complete` });
    expect(done.json<{ status: string }>().status).toBe("done");

    const reopened = await t.inject({ method: "POST", url: `/api/items/${item.id}/reopen` });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json<{ status: string }>().status).toBe("todo");

    const versions = repo.deriveHistory(t.db, item.id);
    expect(versions.map((v) => v.action)).toEqual(["create_item", "complete_item", "reopen_item"]);
    expect(versions.slice(1).map((v) => v.by)).toEqual([
      { actor: "用户", model: null },
      { actor: "用户", model: null },
    ]);

    const missing = await t.inject({ method: "POST", url: "/api/items/nope/reopen" });
    expect(missing.statusCode).toBe(404);
  });

  it("标记已查看：viewed 路由 204 幂等，看板行 viewed 翻转（「新」数据源）", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm("t") });
    const raw = seedRaw(t.db);
    createItem(t.db, raw, { name: "未读行" });
    const item = repo.deriveItems(t.db)[0];
    if (!item) throw new Error("播种失败");

    expect(buildBoard(t.db).undated[0]?.viewed).toBe(false);
    const res = await t.inject({ method: "POST", url: `/api/items/${item.id}/viewed` });
    expect(res.statusCode).toBe(204);
    expect(buildBoard(t.db).undated[0]?.viewed).toBe(true);
    const again = await t.inject({ method: "POST", url: `/api/items/${item.id}/viewed` });
    expect(again.statusCode).toBe(204); // 幂等
    const miss = await t.inject({ method: "POST", url: "/api/items/nope/viewed" });
    expect(miss.statusCode).toBe(404);
  });

  it("reopen 把已完成事项恢复为待办（归档已随 007 取消，FR-018）", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(parseWallClock("2026-09-27T08:00:00"));
      const t = await makeTestAccount({ llm: new FakeLlm("t") });
      const raw = seedRaw(t.db);
      createItem(t.db, raw, { name: "先完成后恢复" });
      const item = repo.deriveItems(t.db)[0];
      if (!item) throw new Error("事项未创建");

      const completed = await t.inject({ method: "POST", url: `/api/items/${item.id}/complete` });
      expect(completed.statusCode).toBe(200);
      expect(repo.deriveItem(t.db, item.id)?.status).toBe("done");

      const reopened = await t.inject({ method: "POST", url: `/api/items/${item.id}/reopen` });
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json<{ status: string }>().status).toBe("todo");

      const versions = repo.deriveHistory(t.db, item.id);
      expect(versions.map((v) => v.action)).toEqual([
        "create_item",
        "complete_item",
        "reopen_item",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("连续 reopen 幂等只留痕：complete; reopen; reopen → 仍是 todo", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm("t") });
    const raw = seedRaw(t.db);
    createItem(t.db, raw, { name: "反复恢复" });
    const item = repo.deriveItems(t.db)[0];
    if (!item) throw new Error("播种失败");

    await t.inject({ method: "POST", url: `/api/items/${item.id}/complete` });
    await t.inject({ method: "POST", url: `/api/items/${item.id}/reopen` });
    const reopened = await t.inject({ method: "POST", url: `/api/items/${item.id}/reopen` });
    expect(reopened.json<{ status: string }>().status).toBe("todo");
  });

  it("不存在的事项 → 404", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm("t") });
    const res = await t.inject({ method: "GET", url: "/api/items/nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("失败批次重试（D-71）", () => {
  it("failed → 重试 → 消化管线重跑成功，状态 digested、变更落库", async () => {
    // 原内联假 client（modelTag "t"）→ 同语义脚本化 FakeLlm：一轮即返合法变更清单
    const fake = new FakeLlm("t");
    fake.push({
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
    });
    const t = await makeTestAccount({ llm: fake });
    const raw = seedRaw(t.db);
    repo.setDigestState(t.db, raw.id, "failed");

    const res = await t.inject({ method: "POST", url: `/api/raw/${raw.id}/retry` });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ digestState: string }>().digestState).toBe("digesting"); // 回执读库内现值（七轮评审）

    // 异步消化：FakeLlm 即返，等待状态稳定
    await vi.waitFor(
      () => {
        expect(repo.getRawInput(t.db, raw.id)?.digestState).toBe("digested");
      },
      { timeout: 3000 },
    );
    expect(repo.deriveItems(t.db).map((i) => i.elements[0]?.text)).toEqual(["重试后的事项"]);
  });

  it("重试再失败 → 状态回 failed（横幅复现，原文仍不丢）", async () => {
    // 原「chat 直接 reject」→ 空队列 FakeLlm：调用即抛（同一失败语义）
    const t = await makeTestAccount({ llm: new FakeLlm("t") });
    const raw = seedRaw(t.db);
    repo.setDigestState(t.db, raw.id, "failed");

    const res = await t.inject({ method: "POST", url: `/api/raw/${raw.id}/retry` });
    expect(res.statusCode).toBe(202);
    await vi.waitFor(
      () => {
        expect(repo.getRawInput(t.db, raw.id)?.digestState).toBe("failed");
      },
      { timeout: 3000 },
    );
  });

  it("已消化批次不可重试（409，防重复落库）", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm("t") });
    const raw = seedRaw(t.db);
    repo.setDigestState(t.db, raw.id, "digested");
    const res = await t.inject({ method: "POST", url: `/api/raw/${raw.id}/retry` });
    expect(res.statusCode).toBe(409);
  });

  it("不存在的批次 → 404", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm("t") });
    const res = await t.inject({ method: "POST", url: "/api/raw/nope/retry" });
    expect(res.statusCode).toBe(404);
  });
});

describe("通知不进看板（007 US1 / SC-002）", () => {
  it("kind=notice 的信息不进看板任一段，只在通知页出现", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    createItem(db, raw, { name: "真事项", dueDate: "2026-09-28T10:00:00" });
    // 通知：无 ddl、kind=notice——课改地点这类「不用做但要知道」
    executeChanges(
      db,
      raw,
      [
        {
          action: "create_item",
          kind: "notice",
          elements: [{ label: "name", text: "数据结构课改到明理楼3楼", quotes: [] }],
          tags: [],
          doubtNote: null,
        },
      ],
      { actor: "agent0", model: "test" },
    );

    const board = buildBoard(db);
    expect(board.undated).toHaveLength(0);
    expect(board.scheduled.map((r) => itemName(r.item.elements))).toEqual(["真事项"]);
    expect(board.done).toHaveLength(0);

    const notices = deriveNotices(db);
    expect(notices.notices.map((r) => itemName(r.item.elements))).toEqual([
      "数据结构课改到明理楼3楼",
    ]);
  });
});

describe("回收站（007 US3）", () => {
  it("删除追加 trashed 版本 → 从看板消失、进回收站；恢复 → 回删前的值", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    createItem(db, raw, { name: "要删的事项" });
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("播种失败");

    // 删除 = 追加版本，不是旁路删除（SC-003：无需新增表）
    repo.appendItemVersion(db, {
      itemId: item.id,
      action: "trash_item",
      detail: "删除「要删的事项」",
      snapshot: { ...item, status: "trashed" },
      by: { actor: "用户", model: null },
    });
    expect(buildBoard(db).undated).toHaveLength(0);
    expect(buildBoard(db).done).toHaveLength(0);

    const rows = deriveTrashed(db).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.item.id).toBe(item.id);
    // 版本链留痕：删除前是什么状态可查
    expect(rows[0]?.item.status).toBe("trashed");
    expect(rows[0]?.trashedAt).not.toBe("");
    const history = repo.deriveHistory(db, item.id);
    expect(history.map((v) => v.snapshot.status)).toEqual(["todo", "trashed"]);

    // 复活：status 回到删前的值（preTrashStatus 走版本链）
    const restoring = repo.preTrashStatus(db, item.id);
    expect(restoring).not.toBeNull(); // 这条链有 todo 版本，应可考
    repo.appendItemVersion(db, {
      itemId: item.id,
      action: "restore_item",
      detail: "从回收站恢复「要删的事项」",
      snapshot: { ...item, status: restoring ?? "todo" },
      by: { actor: "用户", model: null },
    });
    expect(deriveTrashed(db).rows).toHaveLength(0);
    expect(buildBoard(db).undated.map((r) => r.item.id)).toEqual([item.id]);
  });

  it("通知与事项共用回收站（同一 itemId 版本链）", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    createItem(db, raw, { name: "要删的通知", kind: "notice" });
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("播种失败");
    repo.appendItemVersion(db, {
      itemId: item.id,
      action: "trash_item",
      detail: "删除「要删的通知」",
      snapshot: { ...item, status: "trashed" },
      by: { actor: "用户", model: null },
    });

    const rows = deriveTrashed(db).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.item.kind).toBe("notice");
  });

  it("trashed 条目排除出 agent0 检索面（OQ-9）——走生产路径 makeAgentTools", async () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    const item = createItem(db, raw, { name: "删掉的事项" });
    repo.appendItemVersion(db, {
      itemId: item.id,
      action: "trash_item",
      detail: "删除「删掉的事项」",
      snapshot: { ...item, status: "trashed" },
      by: { actor: "用户", model: null },
    });
    // 通知也建一条：search_items 覆盖 notice（OQ-9 前半）
    const notice = createItem(db, raw, { name: "留存的通知", kind: "notice" });

    const tools = makeAgentTools(db, "");
    // 关键词同时命中两者（都含"的"）——生产实现必须只回通知
    const hits = await tools.searchItems({ query: "的" });
    expect(hits.items.map((i) => i.id)).toEqual([notice.id]);
    // get_item 对 trashed 一律拒绝（不把已删内容喂给模型）
    await expect(tools.getItem({ id: item.id })).rejects.toThrow(/回收站/);
    // 对照：未删的通知照常可读
    await expect(tools.getItem({ id: notice.id })).resolves.toBeTruthy();
  });
});

describe("通知与回收站接口（真实 HTTP 入口，007）", () => {
  it("GET /api/notices 只回通知（不混事项）", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm("t") });
    const raw = seedRaw(t.db);
    createItem(t.db, raw, { name: "事项A" });
    createItem(t.db, raw, { name: "通知B", kind: "notice" });

    const res = await t.inject({ method: "GET", url: "/api/notices" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ notices: { item: { elements: { text: string }[] } }[] }>();
    expect(body.notices.map((r) => r.item.elements[0]?.text)).toEqual(["通知B"]);
  });

  it("删除 → 回收站可见 → 恢复回删前状态；看板即时不留它", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm("t") });
    const raw = seedRaw(t.db);
    createItem(t.db, raw, { name: "要删的事项" });
    const item = repo.deriveItems(t.db)[0];
    if (!item) throw new Error("播种失败");

    const del = await t.inject({ method: "POST", url: `/api/items/${item.id}/trash` });
    expect(del.statusCode).toBe(200);
    expect(del.json<{ status: string }>().status).toBe("trashed");

    const trash = await t.inject({ method: "GET", url: "/api/trash" });
    const rows = trash.json<{ rows: { item: { id: string } }[] }>().rows;
    expect(rows.map((r) => r.item.id)).toEqual([item.id]);

    const restored = await t.inject({ method: "POST", url: `/api/items/${item.id}/restore` });
    expect(restored.json<{ status: string }>().status).toBe("todo"); // 删前是 todo
    const after = await t.inject({ method: "GET", url: "/api/trash" });
    expect(after.json<{ rows: unknown[] }>().rows).toHaveLength(0);
  });

  it("一键清理只物理删 >15d 的（≤15d 保留；原文档案不动）", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm("t") });

    // 「20 天前删掉的」：整条版本链在 20 天前的时刻落笔（fake timers 钉住——改写历史 at 会打乱
    // 版本链的 (at, rowid) 次序、令「末版 = 当前态」失真，所以旧条目必须一开始就落在旧时刻）
    const { raw, old } = (() => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(parseWallClock("2026-09-27T12:00:00"));
        const raw = seedRaw(t.db, "原始内容在这里");
        const old = createItem(t.db, raw, { name: "二十天前删的" });
        repo.appendItemVersion(t.db, {
          itemId: old.id,
          action: "trash_item",
          detail: "删除「二十天前删的」",
          snapshot: { ...old, status: "trashed" },
          by: { actor: "用户", model: null },
        });
        return { raw, old };
      } finally {
        vi.useRealTimers();
      }
    })();

    // 「今天删的」：现在落笔
    const raw2 = seedRaw(t.db, "另一批原文");
    const fresh = createItem(t.db, raw2, { name: "今天删的" });
    repo.appendItemVersion(t.db, {
      itemId: fresh.id,
      action: "trash_item",
      detail: "删除「今天删的」",
      snapshot: { ...fresh, status: "trashed" },
      by: { actor: "用户", model: null },
    });

    // 证据片段 + 存疑条目：FR-009 三项「MUST NOT 被物理删除」里除 raw_inputs 外的两项
    const frag = repo.getOrCreateFragment(t.db, "原始内容在这里", raw.id);
    repo.addEvidence(t.db, {
      itemId: old.id,
      subject: "元素:name",
      fragmentId: frag.id,
      by: "test",
    });
    repo.insertUncertainInput(t.db, {
      content: "与该条目相关的存疑原文",
      sourceType: "paste",
      sourceIdentity: { sourceLabel: "s" },
      eventTime: null,
      receivedAt: "2026-09-27T12:00:00",
      originRawInputId: raw.id,
      needsHuman: 50,
      reason: "测试",
      createdAt: "2026-09-27T12:00:00",
    });

    const purge = await t.inject({ method: "POST", url: "/api/trash/purge" });
    expect(purge.statusCode).toBe(200);
    expect(purge.json<{ purged: number }>().purged).toBe(1);

    const left = await t.inject({ method: "GET", url: "/api/trash" });
    const rows = left.json<{ rows: { item: { id: string } }[] }>().rows;
    expect(rows.map((r) => r.item.id)).toEqual([fresh.id]);
    // 原文档案不随信息删除（FR-009：证据终端不破）
    const rawStill = repo.getRawInput(t.db, raw.id);
    expect(rawStill?.content).toBe("原始内容在这里");
    // fragments / uncertain_inputs 同样 MUST NOT 被删（FR-009 三项全覆盖，防测试只证三分之一）
    expect(repo.getFragment(t.db, frag.id)).not.toBeNull();
    expect(repo.listUncertainByStatus(t.db, "open")).toHaveLength(1);
    expect(repo.deriveHistory(t.db, old.id)).toHaveLength(0); // 老条目的版本链已物理删
  });
});

describe("删除后从原视图消失（007：trashed 不进通知页/看板）", () => {
  it("删掉的通知：通知页没有它、回收站有它（两处不并存）", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    createItem(db, raw, { name: "临时的通知", kind: "notice" });
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("播种失败");
    expect(deriveNotices(db).notices).toHaveLength(1);

    repo.appendItemVersion(db, {
      itemId: item.id,
      action: "trash_item",
      detail: "删除「临时的通知」",
      snapshot: { ...item, status: "trashed" },
      by: { actor: "用户", model: null },
    });

    expect(deriveNotices(db).notices).toHaveLength(0); // 通知页不再有它
    expect(deriveTrashed(db).rows).toHaveLength(1); // 只在回收站可见
    expect(buildBoard(db).done).toHaveLength(0); // 看板更没有它
  });

  it("删掉的事项：看板三段都没有它（trashed 天然排除）", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    createItem(db, raw, { name: "临时的事项", dueDate: "2026-10-30T10:00:00" });
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("播种失败");
    repo.appendItemVersion(db, {
      itemId: item.id,
      action: "trash_item",
      detail: "删除「临时的事项」",
      snapshot: { ...item, status: "trashed" },
      by: { actor: "用户", model: null },
    });
    const board = buildBoard(db);
    expect(board.undated).toHaveLength(0);
    expect(board.scheduled).toHaveLength(0);
    expect(board.done).toHaveLength(0);
    expect(deriveTrashed(db).rows).toHaveLength(1);
  });
});

describe("流水摘要区分事项/通知（D-106 修订：通知不说「日期未知」）", () => {
  /** 经执行器落一笔 create_item，返回它给流水摘要用的那行文案。 */
  function createSummary(
    db: ReturnType<typeof makeDb>,
    kind: "task" | "notice" | undefined,
  ): string {
    const raw = seedRaw(db);
    const { details } = executeChanges(
      db,
      raw,
      [
        {
          action: "create_item",
          ...(kind === undefined ? {} : { kind }),
          elements: [{ label: "name", text: "课改到明理楼3楼", quotes: [] }],
          tags: [],
          doubtNote: null,
        },
      ],
      { actor: "agent0", model: "test" },
    );
    return details.join("；");
  }

  it("建事项 → 文案写「新建事项」+ 日期未知（事项无 ddl 时如实说明）", () => {
    const db = makeDb(":memory:");
    const detail = createSummary(db, undefined);
    expect(detail).toContain("新建事项「课改到明理楼3楼」");
    expect(detail).toContain("日期未知");
  });

  it("建通知 → 文案写「新建通知」，且**不出现 ddl / 日期未知**", () => {
    const db = makeDb(":memory:");
    const detail = createSummary(db, "notice");
    expect(detail).toContain("新建通知「课改到明理楼3楼」");
    expect(detail).not.toContain("日期未知");
    expect(detail).not.toContain("ddl");
  });
});

describe("状态不变量守卫（007：路由层与版本链唯一写路径）", () => {
  it("complete/reopen/confirm 都拒绝 trashed 条目（409，要改先恢复）", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm("t") });
    const raw = seedRaw(t.db);
    createItem(t.db, raw, { name: "已删事项" });
    const item = repo.deriveItems(t.db)[0];
    if (!item) throw new Error("播种失败");
    await t.inject({ method: "POST", url: `/api/items/${item.id}/trash` });

    for (const path of ["complete", "reopen", "confirm"]) {
      const res = await t.inject({ method: "POST", url: `/api/items/${item.id}/${path}` });
      expect(res.statusCode, path).toBe(409);
      expect(repo.deriveItem(t.db, item.id)?.status).toBe("trashed"); // 一条都没改活
    }
  });

  it("complete/reopen 拒绝通知（409：通知不参与完成演化）", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm("t") });
    const raw = seedRaw(t.db);
    createItem(t.db, raw, { name: "一条通知", kind: "notice" });
    const item = repo.deriveItems(t.db)[0];
    if (!item) throw new Error("播种失败");
    for (const path of ["complete", "reopen"]) {
      const res = await t.inject({ method: "POST", url: `/api/items/${item.id}/${path}` });
      expect(res.statusCode, path).toBe(409);
    }
    expect(repo.deriveItem(t.db, item.id)?.status).toBe("todo");
  });

  it("restore 对不在回收站的条目是 no-op（不追加无意义版本）", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm("t") });
    const raw = seedRaw(t.db);
    createItem(t.db, raw, { name: "正常事项" });
    const item = repo.deriveItems(t.db)[0];
    if (!item) throw new Error("播种失败");
    const before = repo.deriveHistory(t.db, item.id).length;
    const res = await t.inject({ method: "POST", url: `/api/items/${item.id}/restore` });
    expect(res.statusCode).toBe(200);
    expect(repo.deriveHistory(t.db, item.id)).toHaveLength(before);
  });

  it("通知收到新版本 → 已读标记被清掉（OQ-11：更新后重新标未读）", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    const notice = createItem(db, raw, { name: "会变的通知", kind: "notice" });
    repo.markItemViewed(db, notice.id);
    expect(repo.listViewedItemIds(db).has(notice.id)).toBe(true);
    // 模拟 agent0 更新它（任何新版本）
    repo.appendItemVersion(db, {
      itemId: notice.id,
      action: "update_item",
      detail: "更新通知",
      snapshot: { ...notice, tags: ["课程"] },
      by: { actor: "agent0", model: "test" },
    });
    expect(repo.listViewedItemIds(db).has(notice.id)).toBe(false);
  });

  it("已完成事项切成通知 → status 归一为 todo（通知恒 todo，不造 done 通知）", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    const task = createItem(db, raw, { name: "已完成的事" });
    // 先标完成（无 dueDate 元素 → 可切 notice）
    repo.appendItemVersion(db, {
      itemId: task.id,
      action: "complete_item",
      detail: "标完成",
      snapshot: { ...task, status: "done" },
      by: { actor: "用户", model: null },
    });
    // agent0 切成通知
    executeChanges(
      db,
      raw,
      [
        {
          action: "update_item",
          itemId: task.id,
          kind: "notice",
          elements: [],
          tags: {},
          resolveDoubt: false,
        },
      ],
      { actor: "agent0", model: "test" },
    );
    const after = repo.deriveItem(db, task.id);
    expect(after?.kind).toBe("notice");
    expect(after?.status).toBe("todo");
  });
});

describe("trashedAtOf 边界（评审：时间戳乱序）", () => {
  it("trash 版本排在链首（时间戳回拨/回填）→ 仍能取到 trashedAt，不静默丢出回收站", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    const item = createItem(db, raw, { name: "乱序条目" });
    // 先写 trash，再把它回填到很早的 at（模拟时钟回拨）
    repo.appendItemVersion(db, {
      itemId: item.id,
      action: "trash_item",
      detail: "删除",
      snapshot: { ...item, status: "trashed" },
      by: { actor: "用户", model: null },
    });
    // 直接改库把 trash 行挪到最早
    db.$client
      .prepare("UPDATE item_versions SET at = ? WHERE item_id = ? AND action = 'trash_item'")
      .run("2000-01-01T00:00:00", item.id);
    expect(repo.trashedAtOf(db, item.id)).toBe("2000-01-01T00:00:00");
  });
});

describe("写路径双保险（评审：修正轮窗口内被删的条目）", () => {
  it("resolve_doubt 打 trashed → 抛错（整批回滚，批次可见失败）", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    const item = createItem(db, raw, { name: "被删的存疑" });
    repo.appendItemVersion(db, {
      itemId: item.id,
      action: "trash_item",
      detail: "删除",
      snapshot: { ...item, status: "trashed" },
      by: { actor: "用户", model: null },
    });
    expect(() =>
      executeChanges(db, raw, [{ action: "resolve_doubt", itemId: item.id, note: "解除" }], {
        actor: "agent0",
        model: "test",
      }),
    ).toThrow(/回收站/);
    // 不得留下任何新版本（事务回滚）
    expect(repo.deriveItem(db, item.id)?.doubtNote).toBe(item.doubtNote);
  });

  it("record_note 打 trashed → 降级为批次留痕（不炸整批、不改 trashedAt）", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    const item = createItem(db, raw, { name: "被删的事项" });
    repo.appendItemVersion(db, {
      itemId: item.id,
      action: "trash_item",
      detail: "删除",
      snapshot: { ...item, status: "trashed" },
      by: { actor: "用户", model: null },
    });
    const before = repo.deriveHistory(db, item.id).length;
    const { details } = executeChanges(
      db,
      raw,
      [{ action: "record_note", targetType: "item", targetId: item.id, note: "备注" }],
      { actor: "agent0", model: "test" },
    );
    expect(details.join("")).toContain("回收站");
    expect(repo.deriveHistory(db, item.id).length).toBe(before); // 没写新版本（trashedAt 不被重置）
  });
});
