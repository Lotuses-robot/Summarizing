import { describe, expect, it } from "vitest";
import { doneFadeStrength, TINT_CAP_PERCENT, urgencyStrength } from "../lib/urgency";

// 浓淡曲线的数值口径（终轮验证 L2：urgencyStrength 此前零覆盖——「唯一出处」只钉了一半）。

const NOW = Date.parse("2026-09-30T12:00:00");
const HOUR = 60 * 60_000;

describe("urgencyStrength（待办临近渐强）", () => {
  it("恰到期/已过期/非法日期 → 0", () => {
    expect(urgencyStrength(NOW, NOW)).toBe(0);
    expect(urgencyStrength(NOW - HOUR, NOW)).toBe(0);
    expect(urgencyStrength(Number.NaN, NOW)).toBe(0);
  });

  it("超窗（≥5 天）→ 0；12 小时 → 0.9³ = 0.729", () => {
    expect(urgencyStrength(NOW + 5 * 24 * HOUR, NOW)).toBe(0);
    expect(urgencyStrength(NOW + 6 * 24 * HOUR, NOW)).toBe(0);
    expect(urgencyStrength(NOW + 12 * HOUR, NOW)).toBeCloseTo(0.9 ** 3, 10);
  });

  it("两条曲线共用同一封顶（单一出处）", () => {
    expect(TINT_CAP_PERCENT).toBe(40);
    // 刚完成满格、恰到期 todo 满格——并列最浓，「刚完成最亮」成立（走查修订②）
    expect(Math.round(doneFadeStrength("2026-09-30 12:00:00", NOW) * TINT_CAP_PERCENT)).toBe(40);
    expect(Math.round(1 * TINT_CAP_PERCENT)).toBe(40);
  });
});
