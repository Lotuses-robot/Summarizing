import { describe, expect, it } from "vitest";
import type { ChangeList } from "@summarizing/shared";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";
import { runFence } from "../executor/fence";

/** 围栏夹具的原文（引文逐字校验的比对基准）。 */
const RAW_TEXT = "数据结构 老师说下周要交第三次作业 好像还要交实验报告？";

/** 造一条围栏用的 RawInput（引文校验要对着原文比对）。 */
function seedFenceRaw(db: ReturnType<typeof makeDb>) {
  return repo.insertRawInput(db, {
    content: RAW_TEXT,
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
          setElements: [{ label: "dueDate", text: "2026-10-01T00:00:00", quotes: [] }],
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
  it("update_item 的 setElements 含 name → 拒收（防双 name）", () => {
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
        doubtNote: null,
      },
      by: { actor: "t", model: null },
    });
    const r = runFence(db, seedFenceRaw(db), {
      changes: [
        {
          action: "update_item",
          itemId: "i1",
          setElements: [{ label: "name", text: "B", quotes: [] }],
          resolveDoubt: false,
        },
      ],
    });
    expect(r.rejected[0]?.reason).toContain("name");
  });

  it("add_element 补固定元素 dueDate → 拒收", () => {
    const db = makeDb(":memory:");
    repo.appendItemVersion(db, {
      itemId: "i1",
      action: "create_item",
      detail: "seed",
      snapshot: {
        elements: [{ label: "name", text: "A" }],
        tags: [],
        status: "todo",
        doubtNote: null,
      },
      by: { actor: "t", model: null },
    });
    const r = runFence(db, seedFenceRaw(db), {
      changes: [
        {
          action: "add_element",
          itemId: "i1",
          element: { label: "dueDate", text: "2026-10-01T00:00:00", quotes: [] },
        },
      ],
    });
    expect(r.rejected[0]?.reason).toContain("固定元素");
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
});
