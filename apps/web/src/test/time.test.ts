import { describe, expect, it } from "vitest";
import { fmtShortTime, fmtTimeSec } from "../lib/time";

// 全站短时间口径（走查修订⑤ 2026-10-10）：两函数同源补零，精度按面分行。

describe("lib/time 短时间格式", () => {
  it("fmtShortTime：MM-DD HH:mm 补齐位数（看板 ddl / 流水列表与状态卡共用）", () => {
    expect(fmtShortTime("2026-10-01T09:05:00")).toBe("10-01 09:05");
    // 单数月也补零（删掉月份 padStart 此断言必红）
    expect(fmtShortTime("2026-01-05T03:04:00")).toBe("01-05 03:04");
  });

  it("fmtTimeSec：审计面带秒（流水详情时间线——trace 相隔数秒需可分辨）", () => {
    expect(fmtTimeSec("2026-10-01T09:05:07")).toBe("10-01 09:05:07");
    // 同秒前缀与 fmtShortTime 严格同源（秒只是后缀追加）
    expect(fmtTimeSec("2026-10-01T09:05:07").startsWith(fmtShortTime("2026-10-01T09:05:07"))).toBe(
      true,
    );
  });
});
