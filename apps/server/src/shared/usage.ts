import { errText } from "@summarizing/shared";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import type { LlmUsage } from "./llm";

// 用量落行（010）：所有**成功**的模型调用各记一行；失败无 usage 可记（流水另有留痕）。
// 记录是旁路——写失败只留痕，绝不让「记账」拖垮用户看得见的那次调用。

/** 记录一次成功调用的 usage。usage 为 null（服务商未提供）时不落行——不拿 0 冒充。 */
export function recordUsage(
  db: Db,
  actor: "agent0" | "chat",
  model: string,
  usage: LlmUsage | null,
): void {
  if (usage === null) return;
  try {
    repo.insertLlmUsage(db, {
      actor,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens,
    });
  } catch (err) {
    process.stderr.write(`[usage] 用量落行失败（不影响本次调用）：${errText(err)}\n`);
  }
}
