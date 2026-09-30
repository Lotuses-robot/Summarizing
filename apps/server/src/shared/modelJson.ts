import type { ZodType } from "zod";

// 模型自由文本 → 结构化对象：剥代码围栏、截取最外层 JSON、过 zod；
// 不合规返回 null（由调用方决定重试还是兜底）。fence 与 chat 共用，避免容错逻辑分叉。

/** 从模型输出里提取并校验 JSON；失败返回 null。 */
export function parseModelJson<T>(text: string, schema: ZodType<T>): T | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return schema.parse(JSON.parse(cleaned.slice(start, end + 1)));
  } catch {
    return null;
  }
}
