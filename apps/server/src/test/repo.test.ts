import { describe, expect, it, vi } from "vitest";
import { itemDueDate, type Item, type RawInput } from "@summarizing/shared";
import { executeChanges } from "../features/agent0/executor";
import { sweepOrphanPending } from "../features/agent0/digest";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";

/** 造一条标准 RawInput 夹具。 */
function seedRaw(db: ReturnType<typeof makeDb>): RawInput {
  return repo.insertRawInput(db, {
    content: "x",
    sourceType: "paste",
    sourceIdentity: { sourceLabel: "s" },
    receivedAt: "2026-09-24T10:00:00",
    eventTime: null,
  });
}

/** 造一个含 name/dueDate 元素的事项（经真实入口 executeChanges）。 */
function createHomeworkItem(
  db: ReturnType<typeof makeDb>,
  raw: RawInput,
  dueDate: string | null,
): Item {
  executeChanges(
    db,
    raw,
    [
      {
        action: "create_item",
        elements: [
          { label: "name", text: "英语作文", quotes: ["交英语作文"] },
          ...(dueDate === null
            ? []
            : [{ label: "dueDate", text: dueDate, note: "按事件时间推断", quotes: ["下周三"] }]),
        ],
        tags: ["英语课"],
        doubtNote: null,
      },
    ],
    { actor: "agent0", model: "test" },
  );
  const found = repo.deriveItems(db).find((i) => i.tags.includes("英语课"));
  if (!found) throw new Error("事项未创建");
  return found;
}

describe("事项版本链", () => {
  it("create → derive → 追加版本 → 派生取最新", () => {
    const db = makeDb(":memory:");
    const item = createHomeworkItem(db, seedRaw(db), "2026-09-30T23:59:59");
    expect(item.elements.find((e) => e.label === "name")?.text).toBe("英语作文");
    expect(itemDueDate(item)).toBe("2026-09-30T23:59:59");
    expect(item.elements.find((e) => e.label === "dueDate")?.note).toBe("按事件时间推断");

    // 追加一个版本（改存疑标记）
    repo.appendItemVersion(db, {
      itemId: item.id,
      action: "update_item",
      detail: "改存疑",
      snapshot: { ...item, doubtNote: "老师口头说的，未确认" },
      by: { actor: "user", model: "x" },
    });
    const after = repo.deriveItem(db, item.id);
    if (!after) throw new Error("更新后版本丢失");
    expect(after.doubtNote).toBe("老师口头说的，未确认");
    expect(repo.deriveHistory(db, item.id)).toHaveLength(2);
  });

  it("name 元素缺失 → 写入期拒收（投毒数据不落库，D-70 写路径校验）", () => {
    const db = makeDb(":memory:");
    expect(() =>
      repo.appendItemVersion(db, {
        itemId: "bad",
        action: "create_item",
        detail: "脏数据",
        snapshot: {
          elements: [{ label: "dueDate", text: "2026-10-01T00:00:00" }],
          tags: [],
          status: "todo",
          doubtNote: null,
        },
        by: { actor: "test", model: null },
      }),
    ).toThrow(/name/);
    // 拒收 = 不落库：派生时不存在半套状态
    expect(repo.deriveItems(db)).toHaveLength(0);
  });

  it("片段按内容哈希去重：同文只存一份", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    const f1 = repo.getOrCreateFragment(db, "老师说下周要交", raw.id);
    const f2 = repo.getOrCreateFragment(db, "老师说下周要交", raw.id);
    expect(f1.id).toBe(f2.id);
  });

  it("证据按支撑对象（元素:<label>）挂到事项", () => {
    const db = makeDb(":memory:");
    const item = createHomeworkItem(db, seedRaw(db), "2026-09-30T23:59:59");
    const evidence = repo.listEvidenceByItem(db, item.id);
    const subjects = evidence.map((e) => e.subject).sort();
    expect(subjects).toEqual(["元素:dueDate", "元素:name"]);
  });

  it("RawInput 状态流转：pending → digested / failed", () => {
    const db = makeDb(":memory:");
    const a = repo.insertRawInput(db, {
      content: "a",
      sourceType: "paste",
      sourceIdentity: { sourceLabel: "x" },
      receivedAt: "2026-09-24T10:00:00",
      eventTime: null,
    });
    repo.setDigestState(db, a.id, "failed");
    expect(repo.getRawInput(db, a.id)?.digestState).toBe("failed");
    expect(repo.listRawInputsByState(db, "failed")).toHaveLength(1);
  });

  it("批次审计：appendRawAudit / listRawAudit", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    repo.appendRawAudit(db, {
      rawInputId: raw.id,
      action: "digest_done",
      detail: "应用 1 项变更",
      by: { actor: "agent0", model: "test" },
    });
    const audit = repo.listRawAudit(db, raw.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe("digest_done");
  });
});

describe("孤儿清扫（L11）", () => {
  /** 造一条指定消化状态的批次。 */
  function seedWithState(db: ReturnType<typeof makeDb>, state: RawInput["digestState"]): RawInput {
    const raw = repo.insertRawInput(db, {
      content: "x",
      sourceType: "paste",
      sourceIdentity: { sourceLabel: "s" },
      receivedAt: "2026-09-24T10:00:00",
      eventTime: null,
    });
    if (state !== "pending") repo.setDigestState(db, raw.id, state);
    return raw;
  }

  it("启动时 pending 即孤儿：全部置「未处理」并逐批留痕", () => {
    const db = makeDb(":memory:");
    const a = seedWithState(db, "pending");
    const b = seedWithState(db, "pending");
    sweepOrphanPending(db);
    expect(repo.listRawInputsByState(db, "pending")).toHaveLength(0);
    expect(repo.listRawInputsByState(db, "failed")).toHaveLength(2);
    expect(repo.listRawAudit(db, a.id)[0]?.action).toBe("startup_sweep");
    expect(repo.listRawAudit(db, b.id)[0]?.action).toBe("startup_sweep");
  });

  it("digested / failed 不动", () => {
    const db = makeDb(":memory:");
    seedWithState(db, "digested");
    seedWithState(db, "failed");
    sweepOrphanPending(db);
    expect(repo.listRawInputsByState(db, "digested")).toHaveLength(1);
    expect(repo.listRawInputsByState(db, "failed")).toHaveLength(1);
  });

  it("被扫批次走 D-71 重试口：failed→pending 跃迁成立", () => {
    const db = makeDb(":memory:");
    const raw = seedWithState(db, "pending");
    sweepOrphanPending(db);
    expect(repo.setDigestStateIf(db, raw.id, "failed", "pending")).toBe(true);
  });
});

describe("executeChanges 事务原子性", () => {
  it("任一项抛错 → 整批回滚（前项不落库）", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    expect(() =>
      executeChanges(
        db,
        raw,
        [
          {
            action: "create_item",
            elements: [{ label: "name", text: "应被回滚", quotes: [] }],
            tags: [],
            doubtNote: null,
          },
          {
            action: "update_item",
            itemId: "missing-item",
            setElements: [{ label: "dueDate", text: "2026-10-01T00:00:00", quotes: [] }],
            resolveDoubt: false,
          },
        ],
        { actor: "agent0", model: "test" },
      ),
    ).toThrow();
    // 整批回滚：第 1 项不应存在
    expect(repo.deriveItems(db)).toHaveLength(0);
    expect(repo.listRawAudit(db, raw.id)).toHaveLength(0);
  });
});

describe("版本链边界（第 4 轮补测）", () => {
  it("update_item 的 setElements 为空 → 不产生版本（执行器跳过无变化更新）", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    createHomeworkItem(db, raw, "2026-09-30T23:59:59");
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("未创建");
    const before = repo.deriveHistory(db, item.id).length;

    executeChanges(
      db,
      raw,
      [{ action: "update_item", itemId: item.id, setElements: [], resolveDoubt: false }],
      { actor: "agent0", model: "test" },
    );
    expect(repo.deriveHistory(db, item.id).length).toBe(before);
  });

  it("元素 quotes 缺失（default []）→ 事项正常落库、零证据", () => {
    const db = makeDb(":memory:");
    const raw = seedRaw(db);
    executeChanges(
      db,
      raw,
      [
        {
          action: "create_item",
          elements: [{ label: "name", text: "无引文事项", quotes: [] }],
          tags: [],
          doubtNote: null,
        },
      ],
      { actor: "agent0", model: "test" },
    );
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("未创建");
    expect(repo.listEvidenceByItem(db, item.id)).toHaveLength(0);
  });
});

describe("版本史排序（同秒多版本）", () => {
  /** 播种一条三版本链：create(09-30) → update(10-08) → resolve_doubt。 */
  function seedThreeVersions(db: ReturnType<typeof makeDb>): string {
    const raw = seedRaw(db);
    createHomeworkItem(db, raw, "2026-09-30T23:59:59");
    const first = repo.deriveItems(db)[0];
    if (!first) throw new Error("未创建");
    repo.appendItemVersion(db, {
      itemId: first.id,
      action: "update_item",
      detail: "正式通知给出截止",
      snapshot: {
        elements: first.elements.map((e) =>
          e.label === "dueDate" ? { ...e, text: "2026-10-08T23:59:59", note: null } : e,
        ),
        tags: first.tags,
        status: first.status,
        doubtNote: null,
      },
      by: { actor: "agent0", model: "test" },
    });
    const current = repo.deriveItem(db, first.id);
    if (!current) throw new Error("更新后丢失");
    repo.appendItemVersion(db, {
      itemId: first.id,
      action: "resolve_doubt",
      detail: "解除存疑",
      snapshot: {
        elements: current.elements,
        tags: current.tags,
        status: current.status,
        doubtNote: null,
      },
      by: { actor: "agent0", model: "test" },
    });
    return first.id;
  }

  it("同一秒连写多条：deriveHistory 按 rowid 稳定排序（顺序 = 插入序）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T10:00:00"));
    try {
      const db = makeDb(":memory:");
      const itemId = seedThreeVersions(db);
      const history = repo.deriveHistory(db, itemId);
      // 墙钟是秒级精度：只按 at 排序则同秒顺序未定义，rowid 破平保证插入序
      expect(history.map((v) => v.action)).toEqual(["create_item", "update_item", "resolve_doubt"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
