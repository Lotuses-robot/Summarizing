import { describe, expect, it } from "vitest";
import { matchesFilter } from "../components/FilterBar";
import type { Item } from "@summarizing/shared";

// 筛选谓词单一出处（看板三段与通知页共用）：tag AND 收窄 + 查询串匹配语义名/tags。
// 这条测试的存在意义：此前通知页抄了一份同构谓词、注释还声称有测试，实际没有。

/** 造一个最小 Item（只有筛选用到的字段有意义）。 */
function item(name: string, tags: string[] = []): Item {
  return {
    id: `id-${name}`,
    elements: [{ label: "name", text: name }],
    tags,
    status: "todo",
    kind: "task",
    doubtNote: null,
  };
}

describe("matchesFilter（筛选唯一出处）", () => {
  it("无筛选条件 → 全部通过", () => {
    expect(matchesFilter(item("英语作业"), { query: "", tags: [] })).toBe(true);
  });

  it("tag 全部命中才通过（AND 收窄）", () => {
    const it0 = item("英语作业", ["英语课", "作业"]);
    expect(matchesFilter(it0, { query: "", tags: ["英语课"] })).toBe(true);
    expect(matchesFilter(it0, { query: "", tags: ["英语课", "作业"] })).toBe(true);
    expect(matchesFilter(it0, { query: "", tags: ["英语课", "数学课"] })).toBe(false);
  });

  it("查询串匹配语义名或 tags（包含匹配）", () => {
    const it0 = item("英语作业", ["英语课"]);
    expect(matchesFilter(it0, { query: "英语", tags: [] })).toBe(true); // 命中名字
    expect(matchesFilter(it0, { query: "课", tags: [] })).toBe(true); // 命中 tag
    expect(matchesFilter(it0, { query: "数学", tags: [] })).toBe(false);
  });

  it("tag 与查询串同时存在 → 都满足才通过", () => {
    const it0 = item("英语作业", ["英语课"]);
    expect(matchesFilter(it0, { query: "作业", tags: ["英语课"] })).toBe(true);
    expect(matchesFilter(it0, { query: "数学", tags: ["英语课"] })).toBe(false);
  });
});
