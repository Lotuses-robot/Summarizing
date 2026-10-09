import { describe, expect, it } from "vitest";
import { isNearBottom } from "../lib/scrollAnchor";

// 滚动锚定判定（specs/001）：跟随与否的唯一依据，纯函数直测。

describe("isNearBottom（滚动锚定判定）", () => {
  it("恰在底部（距离 0）→ 真", () => {
    expect(isNearBottom(600, 1000, 400)).toBe(true);
  });

  it("容差内（≤48px）→ 真：抖动不打断跟随", () => {
    expect(isNearBottom(560, 1000, 400)).toBe(true); // 距离 40
  });

  it("容差外（>48px）→ 假：用户已上翻", () => {
    expect(isNearBottom(500, 1000, 400)).toBe(false); // 距离 100
  });

  it("无滚动条（scrollHeight ≤ clientHeight）→ 恒真：没有可离开的底部", () => {
    expect(isNearBottom(0, 300, 400)).toBe(true);
    expect(isNearBottom(0, 400, 400)).toBe(true);
  });

  it("自定义容差生效", () => {
    expect(isNearBottom(500, 1000, 400, 120)).toBe(true);
  });
});
