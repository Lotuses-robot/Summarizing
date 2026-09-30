import { describe, expect, it } from "vitest";
import { relativeDueText } from "./index";

describe("relativeDueText（ddl 相对时间，05§三）", () => {
  const now = new Date("2026-09-26 12:00:00");

  it("2 天以上按天（未来向上取整催紧迫感）", () => {
    expect(relativeDueText("2026-09-29 12:00:00", now)).toBe("还有 3 天");
    expect(relativeDueText("2026-09-29 18:00:00", now)).toBe("还有 4 天");
  });

  it("2 天以上按天（过去向下取整不夸大）", () => {
    expect(relativeDueText("2026-09-24 00:00:00", now)).toBe("已过期 2 天");
    expect(relativeDueText("2026-09-23 12:00:00", now)).toBe("已过期 3 天");
  });

  it("不足 2 天按小时", () => {
    expect(relativeDueText("2026-09-27 00:00:00", now)).toBe("还有 12 小时");
    expect(relativeDueText("2026-09-26 10:00:00", now)).toBe("已过期 2 小时");
    expect(relativeDueText("2026-09-26 12:30:00", now)).toBe("还有 1 小时");
  });

  it("非法日期返回 null（调用方隐藏，不编造）", () => {
    expect(relativeDueText("不是日期", now)).toBeNull();
  });
});
