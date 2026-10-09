// 异常转人话的通用工具（2026-10-09 自 agent0/digest.ts 迁出——app/chat/routes 多处使用，与消化无关）。

/** 异常 → 人话单行（日志与回喂共用；仓库内统一出处）。 */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
