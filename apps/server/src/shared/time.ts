// 时间工具（D-64）：全库统一本地墙钟时间 `YYYY-MM-DDTHH:mm:ss`，无时区标记。
// 格式校验已收敛到 shared 的 localWallClockSchema（类型即校验）；这里只留规范化/解析/当前时间。

/** 规范化：纯日期补本地午夜，使库内格式绝对统一（字符串序 = 时间序）。 */
export function normalizeWallClock(date: string | null): string | null {
  if (date === null) return null;
  const t = date.trim();
  return t.includes("T") ? t : `${t}T00:00:00`;
}

/** 解析为时间戳（本地墙钟无时区，Date.parse 结果正确）；非法返回 NaN。 */
export function parseWallClock(text: string): number {
  return Date.parse(text);
}

/** 当前**本地墙钟**时间戳（`YYYY-MM-DDTHH:mm:ss`，无时区标记）——落库时间统一走它（D-64）。 */
export function nowLocalWallClock(): string {
  const d = new Date();
  /** 两位数补零（月份/日期/时分秒）。 */
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** Unix 秒 → 本地墙钟（D-84：nc 等外部事件自带 unix 秒时刻，转成本库统一格式）。 */
export function wallClockFromUnix(seconds: number): string {
  const d = new Date(seconds * 1000);
  /** 两位数补零（月份/日期/时分秒）。 */
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}
