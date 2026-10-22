import type { ZodType } from "zod";

// 模型自由文本 → 结构化对象：剥代码围栏、截取最外层 JSON、过 zod；
// 不合规返回 null（由调用方决定重试还是兜底）。fence 与 chat 共用，避免容错逻辑分叉。

/** 解析结果：成功给值；失败给**一句人话原因**——重试时回喂给模型，比只说「不合法」有效得多。 */
export type ModelJsonParse<T> = { ok: true; value: T } | { ok: false; reason: string };

/** 从模型输出里提取并校验 JSON；失败时把原因一并带出（digest 的纠正提示用它）。
 *  原因分三类且都截断到一行：没找到 JSON / JSON 语法错 / 字段不合规（带上 zod 的第一处路径）。 */
export function parseModelJsonDetailed<T>(text: string, schema: ZodType<T>): ModelJsonParse<T> {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, reason: "输出里没有 JSON 对象（找不到 { }）" };
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `JSON 语法错误：${msg.slice(0, 160)}` };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  // 只报第一处：模型一次改一处更容易改对（报一串反而照抄不全）
  const first = parsed.error.issues[0];
  const at = first === undefined ? "" : first.path.join(".") || "(根)";
  const why = first?.message ?? "字段不合规";
  return { ok: false, reason: `字段不合规（${at}）：${why.slice(0, 160)}` };
}
