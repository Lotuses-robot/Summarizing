import { describe, expect, it } from "vitest";
import { IngestRequestSchema } from "./index";

// 进站口 eventTime 的形状守卫（D-97 走查收紧）：入口与 dueDate 出口同口径——北京墙钟串或 null。
// 脏形态枚举一次列全（边界加固三规矩①）：null / 纯日期 / 带时区标记 / 假日期 / 非日期串 / 缺席。

/** 造一个最小合法进站体（只换 eventTime）。 */
function body(eventTime: unknown) {
  return {
    content: "群里说的作业通知",
    source: "paste",
    identity: { displayName: "测试" },
    eventTime,
  };
}

describe("IngestRequestSchema.eventTime（北京墙钟或 null）", () => {
  it("合法：完整墙钟串 / 纯日期 / null / 缺席（默认 null）", () => {
    expect(IngestRequestSchema.safeParse(body("2026-09-28T10:15:00")).success).toBe(true);
    expect(IngestRequestSchema.safeParse(body("2026-09-28")).success).toBe(true); // 纯日期合法
    expect(IngestRequestSchema.safeParse(body(null)).success).toBe(true); // 无事件时间
    const noField = IngestRequestSchema.safeParse({
      content: "x",
      source: "paste",
      identity: { displayName: "测试" },
    });
    expect(noField.success).toBe(true);
    if (noField.success) expect(noField.data.eventTime).toBeNull(); // default(null)
  });

  it("脏形态一律拒（带时区标记 / 假日期 / 非日期串 / 空串）", () => {
    expect(IngestRequestSchema.safeParse(body("2026-09-28T10:00:00Z")).success).toBe(false); // Z
    expect(IngestRequestSchema.safeParse(body("2026-09-28T10:00:00+08:00")).success).toBe(false); // 偏移
    expect(IngestRequestSchema.safeParse(body("2026-02-30T10:00:00")).success).toBe(false); // 假日期
    expect(IngestRequestSchema.safeParse(body("明天")).success).toBe(false);
    expect(IngestRequestSchema.safeParse(body("")).success).toBe(false);
    expect(IngestRequestSchema.safeParse(body("2026/09/28")).success).toBe(false); // 斜杠
  });
});
