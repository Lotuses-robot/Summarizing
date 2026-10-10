/** 时间戳（墙钟串/ISO）→「MM-DD HH:mm」全站统一短格式——月/日/时/分补零（用户 2026-10-10 定：统一口径 = 补齐位数）。
 *  看板 ddl 与流水（列表/状态卡/详情时间线）共用；长期记录类（版本历史/引文悬浮窗）另有带年份的长格式，不在此列。 */
export function fmtShortTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
