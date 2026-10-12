import { describe, expect, it } from "vitest";
import { wallClockFromDate, wallClockFromUnix, parseWallClock, normalizeWallClock } from "./time";

// 北京时间定死（D-97）：产时/解析恒按 UTC+8——**不依赖运行机器时区**（服务器是 UTC 也无碍）。
// 这些断言是本次改动的不变量：任一机器时区下都必须成立（CI 若跑在 UTC 也照样过）。

describe("墙钟 = 北京时间（D-97 定死 UTC+8）", () => {
  it("wallClockFromDate：epoch → 北京分量（UTC 时刻 +8h）", () => {
    // 2026-01-01T00:00:00Z = 北京时间 08:00
    expect(wallClockFromDate(new Date(Date.parse("2026-01-01T00:00:00Z")))).toBe(
      "2026-01-01T08:00:00",
    );
    // 跨日：2025-12-31T16:00:00Z = 北京 2026-01-01T00:00:00
    expect(wallClockFromDate(new Date(Date.parse("2025-12-31T16:00:00Z")))).toBe(
      "2026-01-01T00:00:00",
    );
    // 跨日反向：2026-01-01T20:00:00Z = 北京 2026-01-02T04:00:00
    expect(wallClockFromDate(new Date(Date.parse("2026-01-01T20:00:00Z")))).toBe(
      "2026-01-02T04:00:00",
    );
  });

  it("parseWallClock：北京串解析回 epoch（补 +08:00，往返一致）", () => {
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    expect(parseWallClock("2026-01-01T08:00:00")).toBe(epoch);
    expect(wallClockFromDate(new Date(parseWallClock("2026-01-01T08:00:00")))).toBe(
      "2026-01-01T08:00:00",
    );
    // 已带时区标记的串不重复补
    expect(parseWallClock("2026-01-01T08:00:00+08:00")).toBe(epoch);
    // 非法
    expect(Number.isNaN(parseWallClock("不是日期"))).toBe(true);
  });

  it("wallClockFromUnix：unix 秒（UTC 基准）→ 北京时间", () => {
    // 1790595828 = 2026-09-28T11:43:48Z → 北京 19:43:48
    expect(wallClockFromUnix(1790595828)).toBe("2026-09-28T19:43:48");
  });

  it("normalizeWallClock：纯日期补北京午夜", () => {
    expect(normalizeWallClock("2026-01-01")).toBe("2026-01-01T00:00:00");
    expect(normalizeWallClock("2026-01-01T08:00:00")).toBe("2026-01-01T08:00:00");
    expect(normalizeWallClock(null)).toBeNull();
  });
});
