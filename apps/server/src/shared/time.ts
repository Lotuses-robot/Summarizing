// 时间工具（D-64 立，D-97 定死北京时间）：全库统一**北京时间墙钟** `YYYY-MM-DDTHH:mm:ss`，无时区标记。
// 口径 = UTC+8（固定，**不看运行机器时区**——服务器是 UTC 也无碍）。字符串序 = 时间序。
// 格式校验已收敛到 shared 的 wallClockSchema（类型即校验）；这里只留规范化/解析/当前时间。

/** 北京时间的固定 UTC 偏移（分钟）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60_000;

/** 规范化：纯日期补午夜（北京时间原点），使库内格式绝对统一（字符串序 = 时间序）。 */
export function normalizeWallClock(date: string | null): string | null {
  if (date === null) return null;
  const t = date.trim();
  return t.includes("T") ? t : `${t}T00:00:00`;
}

/** 北京墙钟串 → epoch 毫秒：补显式 `+08:00` 偏移解析（**不依赖机器时区**）；非法返回 NaN。 */
export function parseWallClock(text: string): number {
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}+08:00`;
  return Date.parse(withZone);
}

/** Date → 北京墙钟串（格式化**唯一出处**：now/Unix/过期时刻计算共用）。
 *  取「秒数 +8h 后的 UTC 分量」= 北京时间分量——**与机器时区无关**。 */
export function wallClockFromDate(d: Date): string {
  const shifted = new Date(d.getTime() + BEIJING_OFFSET_MS);
  /** 两位数补零（月份/日期/时分秒）。 */
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`
  );
}

/** 当前**北京时间**墙钟戳（`YYYY-MM-DDTHH:mm:ss`，无时区标记）——落库时间统一走它（D-97）。 */
export function nowWallClock(): string {
  return wallClockFromDate(new Date());
}

/** Unix 秒 → 北京墙钟（D-84：nc 等外部事件自带 unix 秒时刻，转成本库统一格式）。 */
export function wallClockFromUnix(seconds: number): string {
  return wallClockFromDate(new Date(seconds * 1000));
}

/** 北京墙钟某日 00:00 的墙钟串：`daysBack = 0` 为今日，6 = 六天前（含今日共 7 个日历日）。
 *  纯 UTC 分量算术（+8h 后归零到 UTC 日界再减回）——与机器时区无关（D-97 同口径）。 */
export function beijingDayStart(now: Date, daysBack = 0): string {
  const beijingMidnight = new Date(now.getTime() + BEIJING_OFFSET_MS);
  beijingMidnight.setUTCHours(0, 0, 0, 0);
  return wallClockFromDate(
    new Date(beijingMidnight.getTime() - daysBack * 86_400_000 - BEIJING_OFFSET_MS),
  );
}
