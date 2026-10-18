import { describe, expect, it } from "vitest";
import type { ChangeList } from "@summarizing/shared";
import { itemDueDate } from "@summarizing/shared";
import { executeChanges } from "../executor/executor";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";
import { runFence } from "../executor/fence";

/** 围栏夹具的原文（引文逐字校验的比对基准）。 */
const RAW_TEXT = "数据结构 老师说下周要交第三次作业 好像还要交实验报告？";

/** 造一条围栏用的 RawInput（引文校验要对着原文比对）。 */
/** 造一条待校验的原始批次（默认用 RAW_TEXT；可传自定义 content——多模态用例要含图片占位）。 */
function seedFenceRaw(db: ReturnType<typeof makeDb>, content: string = RAW_TEXT) {
  return repo.insertRawInput(db, {
    content,
    sourceType: "paste",
    sourceIdentity: { sourceLabel: "s" },
    receivedAt: "2026-09-24T10:00:00",
    eventTime: null,
  });
}

/** 造一个 create_item 变更（dueDate 元素可选）。 */
function createItemChange(dueDate?: string): ChangeList {
  return {
    changes: [
      {
        action: "create_item",
        elements: [
          { label: "name", text: "测试事项", quotes: [] },
          ...(dueDate === undefined
            ? []
            : [{ label: "dueDate", text: dueDate, note: null, quotes: [] }]),
        ],
        tags: [],
        doubtNote: null,
      },
    ],
  };
}

describe("围栏 D-64：时间格式白名单", () => {
  const cases: [string | undefined, boolean][] = [
    ["2026-09-24T22:00:00", true],
    ["2026-09-24T22:00", true],
    ["2026-09-24T22:00:00.000", true],
    ["2026-09-24", true],
    ["2026-09-24T22:00:00Z", false],
    ["2026-09-24T22:00:00+08:00", false],
    ["2026-09-24T22:00:00+0800", false],
    ["2026-9-4T22:00", false],
    ["2026-02-30T00:00:00", false],
    ["2026-04-31T00:00:00", false],
    ["2025-02-29T00:00:00", false],
    ["2024-02-29T00:00:00", true],
    ["2026-09-24T24:00:00", false],
    [undefined, true],
  ];
  for (const [input, accepted] of cases) {
    it(`${input ?? "（无 dueDate）"} → ${accepted ? "接受" : "拒收"}`, () => {
      const db = makeDb(":memory:");
      const result = runFence(db, seedFenceRaw(db), createItemChange(input));
      expect(result.accepted).toHaveLength(accepted ? 1 : 0);
      expect(result.rejected).toHaveLength(accepted ? 0 : 1);
    });
  }
});

describe("围栏行为校验", () => {
  it("update_item 引用不存在的 itemId → 拒收", () => {
    const db = makeDb(":memory:");
    const result = runFence(db, seedFenceRaw(db), {
      changes: [
        {
          action: "update_item",
          itemId: "nope",
          elements: [{ label: "dueDate", text: "2026-10-01T00:00:00", quotes: [] }],
          tags: {},
          resolveDoubt: false,
        },
      ],
    });
    expect(result.rejected[0]?.reason).toContain("itemId 不存在");
  });

  it("create_item 缺 name 元素 → 拒收（禁裸日期的结构保证）", () => {
    const db = makeDb(":memory:");
    const result = runFence(db, seedFenceRaw(db), {
      changes: [
        {
          action: "create_item",
          elements: [{ label: "dueDate", text: "2026-10-01T00:00:00", quotes: [] }],
          tags: [],
          doubtNote: null,
        },
      ],
    });
    expect(result.rejected[0]?.reason).toContain("name");
  });

  it("record_note 指向不存在的 raw_input → 拒收", () => {
    const db = makeDb(":memory:");
    const result = runFence(db, seedFenceRaw(db), {
      changes: [{ action: "record_note", targetType: "raw_input", targetId: "nope", note: "x" }],
    });
    expect(result.rejected[0]?.reason).toContain("targetId 不存在");
  });
});

describe("围栏：固定元素防误用（第 2 轮审查）", () => {
  it("update_item 的 elements 含 name → 拒收（防双 name）", () => {
    const db = makeDb(":memory:");
    // 直接塞版本（模拟已存在）
    repo.appendItemVersion(db, {
      itemId: "i1",
      action: "create_item",
      detail: "seed",
      snapshot: {
        elements: [{ label: "name", text: "A" }],
        tags: [],
        status: "todo",
        kind: "task",
        doubtNote: null,
      },
      by: { actor: "t", model: null },
    });
    const r = runFence(db, seedFenceRaw(db), {
      changes: [
        {
          action: "update_item",
          itemId: "i1",
          elements: [{ label: "name", text: "B", quotes: [] }],
          tags: {},
          resolveDoubt: false,
        },
      ],
    });
    expect(r.rejected[0]?.reason).toContain("name");
  });
});

describe("围栏：多模态标签强制（D-104）", () => {
  it("更新事项引用了 [图片](url) 占位但没带「多模态/图片」标签 → 拒收", () => {
    const db = makeDb(":memory:");
    repo.appendItemVersion(db, {
      itemId: "i1",
      action: "create_item",
      detail: "seed",
      snapshot: {
        elements: [{ label: "name", text: "A" }],
        tags: [],
        status: "todo",
        kind: "task",
        doubtNote: null,
      },
      by: { actor: "t", model: null },
    });
    // 原文含图片占位；元素引文引它，但 tags 没带多模态标签
    const raw = seedFenceRaw(db, "报名截止 10 月 20 日 [图片](https://x/a.jpg)");
    const r = runFence(db, raw, {
      changes: [
        {
          action: "update_item",
          itemId: "i1",
          elements: [{ label: "报名入口", text: "见海报", quotes: ["[图片](https://x/a.jpg)"] }],
          tags: {},
          resolveDoubt: false,
        },
      ],
    });
    expect(r.rejected[0]?.reason).toContain("多模态/图片");
  });

  it("引用 [图片](url) 占位且带了「多模态/图片」标签 → 接受", () => {
    const db = makeDb(":memory:");
    repo.appendItemVersion(db, {
      itemId: "i1",
      action: "create_item",
      detail: "seed",
      snapshot: {
        elements: [{ label: "name", text: "A" }],
        tags: [],
        status: "todo",
        kind: "task",
        doubtNote: null,
      },
      by: { actor: "t", model: null },
    });
    const raw = seedFenceRaw(db, "报名截止 10 月 20 日 [图片](https://x/a.jpg)");
    const r = runFence(db, raw, {
      changes: [
        {
          action: "update_item",
          itemId: "i1",
          elements: [{ label: "报名入口", text: "见海报", quotes: ["[图片](https://x/a.jpg)"] }],
          tags: { "": "多模态/图片" },
          resolveDoubt: false,
        },
      ],
    });
    expect(r.rejected).toHaveLength(0);
    expect(r.accepted).toHaveLength(1);
  });
});

describe("围栏：引文逐字校验（第 6 轮审查）", () => {
  it("引文逐字（跨空格/换行的空白差异不构成改写）→ 接受", () => {
    const db = makeDb(":memory:");
    const result = runFence(db, seedFenceRaw(db), {
      changes: [
        {
          action: "create_item",
          elements: [
            {
              label: "name",
              text: "数据结构作业",
              quotes: ["数据结构\n老师说下周要交第三次作业"],
            },
            { label: "dueDate", text: "2026-10-01T00:00:00", quotes: [] },
          ],
          tags: [],
          doubtNote: null,
        },
      ],
    });
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
  });

  it("引文改写（非原文逐字）→ 拒收，不得混入证据链", () => {
    const db = makeDb(":memory:");
    const result = runFence(db, seedFenceRaw(db), {
      changes: [
        {
          action: "create_item",
          elements: [
            // 改写：原文是「老师说下周要交第三次作业」，这里丢了「要交第三次」
            { label: "name", text: "数据结构作业", quotes: ["老师说下周交作业"] },
            { label: "dueDate", text: "2026-10-01T00:00:00", quotes: [] },
          ],
          tags: [],
          doubtNote: null,
        },
      ],
    });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("引文");
  });

  it("拒收原因回喂模型后可修正：改回逐字引文 → 第二次过围栏", () => {
    const db = makeDb(":memory:");
    const bad = runFence(db, seedFenceRaw(db), {
      changes: [
        {
          action: "create_item",
          elements: [
            { label: "name", text: "数据结构作业", quotes: ["老师说下周交作业"] },
            { label: "dueDate", text: "2026-10-01T00:00:00", quotes: [] },
          ],
          tags: [],
          doubtNote: null,
        },
      ],
    });
    expect(bad.rejected).toHaveLength(1);

    const repaired = runFence(db, seedFenceRaw(db), {
      changes: [
        {
          action: "create_item",
          elements: [
            { label: "name", text: "数据结构作业", quotes: ["老师说下周要交第三次作业"] },
            { label: "dueDate", text: "2026-10-01T00:00:00", quotes: [] },
          ],
          tags: [],
          doubtNote: null,
        },
      ],
    });
    expect(repaired.rejected).toHaveLength(0);
    expect(repaired.accepted).toHaveLength(1);
  });

  it("行协议收紧：跨消息拼引文被拒（前缀插入非空白——那种引文本就不是单条消息的逐字，specs/003 三轮评审）", () => {
    const db = makeDb(":memory:");
    const raw = repo.insertRawInput(db, {
      content: "[10:00] 小明: 通知：作业\n[10:00] 小明: 截止10月8日",
      sourceType: "nc",
      sourceIdentity: { sourceLabel: "群" },
      receivedAt: "2026-09-28T10:00:00",
      eventTime: null,
    });
    const list: ChangeList = {
      changes: [
        {
          action: "create_item",
          elements: [
            // 单条消息内的引文：仍是子串，过
            { label: "name", text: "作业", note: null, quotes: ["通知：作业"] },
            // 跨两条消息拼的引文：行前缀隔开，拒（squeeze 只去空白，去不掉 [10:00] 小明: ）
            {
              label: "ddl",
              text: "2026-10-08T23:59:59",
              note: null,
              quotes: ["通知：作业\n截止10月8日"],
            },
          ],
          tags: [],
          doubtNote: null,
        },
      ],
    };
    const { accepted, rejected } = runFence(db, raw, list);
    expect(accepted).toHaveLength(0); // create_item 任一元素引文不合法 → 整项拒
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toContain("引文不是原文逐字");
  });
});

describe("围栏 007：kind 与 ddl 形状", () => {
  it("create_item(kind=notice) 带 dueDate → 整条拒收（FR-003/OQ-2：通知无 ddl 是结构红线）", () => {
    const db = makeDb(":memory:");
    const raw = seedFenceRaw(db);
    const r = runFence(db, raw, {
      changes: [
        {
          action: "create_item",
          kind: "notice",
          elements: [
            { label: "name", text: "数据结构 老师说下周要交第三次作业", quotes: [] },
            { label: "dueDate", text: "2026-09-24T22:00:00", note: null, quotes: [] },
          ],
          tags: [],
          doubtNote: null,
        },
      ],
    });
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.reason).toMatch(/dueDate/);
  });

  it("create_item(kind=notice) 无 dueDate → 接受", () => {
    const db = makeDb(":memory:");
    const raw = seedFenceRaw(db);
    const r = runFence(db, raw, {
      changes: [
        {
          action: "create_item",
          kind: "notice",
          elements: [{ label: "name", text: "数据结构 老师说下周要交第三次作业", quotes: [] }],
          tags: [],
          doubtNote: null,
        },
      ],
    });
    expect(r.rejected).toHaveLength(0);
    expect(r.accepted).toHaveLength(1);
  });

  it("update_item 把带 dueDate 的 task 切成 notice → 拒（元素只增改不删，ddl 删不掉）", () => {
    const db = makeDb(":memory:");
    const raw = seedFenceRaw(db);
    repo.appendItemVersion(db, {
      itemId: "i1",
      action: "create_item",
      detail: "seed",
      snapshot: {
        elements: [
          { label: "name", text: "数据结构 老师说下周要交第三次作业" },
          { label: "dueDate", text: "2026-09-24T22:00:00", note: null },
        ],
        tags: [],
        status: "todo",
        kind: "task",
        doubtNote: null,
      },
      by: { actor: "t", model: null },
    });
    const r = runFence(db, raw, {
      changes: [
        {
          action: "update_item",
          itemId: "i1",
          kind: "notice",
          elements: [],
          tags: {},
          resolveDoubt: false,
        },
      ],
    });
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/dueDate/);
  });

  it("update_item 把没有 ddl 元素的 task 切成 notice → 接受（FR-014：ddl 形状是唯一约束）", () => {
    const db = makeDb(":memory:");
    const raw = seedFenceRaw(db);
    // 日期未知的 task = 根本没有 dueDate 元素（不是「留空的元素」——那仍是「有 ddl」）
    executeChanges(
      db,
      raw,
      [
        {
          action: "create_item",
          elements: [{ label: "name", text: "数据结构 老师说下周要交第三次作业", quotes: [] }],
          tags: [],
          doubtNote: null,
        },
      ],
      { actor: "agent0", model: "test" },
    );
    const item = repo.deriveItems(db)[0];
    if (!item) throw new Error("播种失败");
    expect(itemDueDate(item)).toBeNull();

    const r = runFence(db, raw, {
      changes: [
        {
          action: "update_item",
          itemId: item.id,
          kind: "notice",
          elements: [],
          tags: {},
          resolveDoubt: false,
        },
      ],
    });
    expect(r.rejected).toHaveLength(0);
    expect(r.accepted).toHaveLength(1);
  });

  it("complete_item 打给 notice → 拒（US2-2：通知不参与完成演化，按 kind 判）", () => {
    const db = makeDb(":memory:");
    const raw = seedFenceRaw(db);
    repo.appendItemVersion(db, {
      itemId: "n1",
      action: "create_item",
      detail: "seed",
      snapshot: {
        elements: [{ label: "name", text: "数据结构 老师说下周要交第三次作业" }],
        tags: [],
        status: "todo",
        kind: "notice",
        doubtNote: null,
      },
      by: { actor: "t", model: null },
    });
    const r = runFence(db, raw, {
      changes: [{ action: "complete_item", itemId: "n1" }],
    });
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/通知/);
  });

  it("写 trashed 条目 → 拒（OQ-12：回收站只读，要改先恢复）", () => {
    const db = makeDb(":memory:");
    const raw = seedFenceRaw(db);
    repo.appendItemVersion(db, {
      itemId: "i1",
      action: "create_item",
      detail: "seed",
      snapshot: {
        elements: [{ label: "name", text: "数据结构 老师说下周要交第三次作业" }],
        tags: [],
        status: "trashed",
        kind: "task",
        doubtNote: null,
      },
      by: { actor: "t", model: null },
    });
    const r = runFence(db, raw, {
      changes: [
        {
          action: "update_item",
          itemId: "i1",
          elements: [{ label: "地点", text: "明理楼3楼", quotes: [] }],
          tags: {},
          resolveDoubt: false,
        },
      ],
    });
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/回收站/);
  });
});

describe("围栏 007：批内投影（同批多次改动按序校验）", () => {
  /** 造一条无 ddl 的 task（可切 notice）。 */
  function seedTask(db: ReturnType<typeof makeDb>): string {
    repo.appendItemVersion(db, {
      itemId: "x1",
      action: "create_item",
      detail: "seed",
      snapshot: {
        elements: [{ label: "name", text: "数据结构 老师说下周要交第三次作业" }],
        tags: [],
        status: "todo",
        kind: "task",
        doubtNote: null,
      },
      by: { actor: "t", model: null },
    });
    return "x1";
  }

  it("同批先切 notice、再加 dueDate → 第二条被拒（批前快照会放行，投影必须拦住）", () => {
    const db = makeDb(":memory:");
    const raw = seedFenceRaw(db);
    const id = seedTask(db);
    const r = runFence(db, raw, {
      changes: [
        {
          action: "update_item",
          itemId: id,
          kind: "notice",
          elements: [],
          tags: {},
          resolveDoubt: false,
        },
        {
          action: "update_item",
          itemId: id,
          elements: [{ label: "dueDate", text: "2026-09-24T22:00:00", note: null, quotes: [] }],
          tags: {},
          resolveDoubt: false,
        },
      ],
    });
    expect(r.accepted).toHaveLength(1); // 第一条（切 notice）过
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.reason).toMatch(/dueDate/);
  });

  it("同批先切 notice、再 complete → complete 被拒（通知不参与完成演化）", () => {
    const db = makeDb(":memory:");
    const raw = seedFenceRaw(db);
    const id = seedTask(db);
    const r = runFence(db, raw, {
      changes: [
        {
          action: "update_item",
          itemId: id,
          kind: "notice",
          elements: [],
          tags: {},
          resolveDoubt: false,
        },
        { action: "complete_item", itemId: id },
      ],
    });
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected[0]?.reason).toMatch(/通知/);
  });
});
