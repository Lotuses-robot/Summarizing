// 全站时间显示（D-64 立，D-97 定死北京）：库内时刻一律是**北京墙钟串** `YYYY-MM-DDTHH:mm:ss`——
// 显示即**纯字符串裁剪**（不做时区换算：串本身就是北京时间，转换只会引入机器时区偏差）。

/** 北京时间墙钟串 → 「MM-DD HH:mm」（月/日/时/分补零；看板 ddl + 流水列表/状态卡共用）。
 *  纯字符串裁剪：零时区参与，绝对保真（D-97）。 */
export function fmtShortTime(iso: string): string {
  // "YYYY-MM-DDTHH:mm:ss" → date="YYYY-MM-DD" time="HH:mm:ss"
  const [date = "", time = ""] = iso.split("T");
  const [, mm = "", dd = ""] = date.split("-");
  const [hh = "", mi = ""] = time.split(":");
  return `${mm}-${dd} ${hh}:${mi}`;
}

/** 同款短格式带秒「MM-DD HH:mm:ss」——审计面（流水详情时间线）专用：
 *  digest_trace 事件常相隔数秒，分钟精度在时间线上分不开（走查批次 2026-10-10）。 */
export function fmtTimeSec(iso: string): string {
  const sec = iso.split("T")[1]?.split(":")[2] ?? "00";
  return `${fmtShortTime(iso)}:${sec}`;
}

/** 北京墙钟串 → 带年份的长格式「YYYY-MM-DD HH:mm:ss」——长期记录面（版本历史/引文悬浮窗）。 */
export function fmtFullTime(iso: string): string {
  const [date = "", time = ""] = iso.split("T");
  return `${date} ${time.slice(0, 8)}`;
}
