// 看板行浓淡的两条曲线（D-89 收口：同立方、同封顶；**窗口不同**——待办看「还剩多久」(24h)、
// 完成看「过去多久」(5 天)。唯一出处，Row 只调用）。
// 纯决策函数住 lib（项目惯例，参照 lib/appearance 的 resolveDark「独立导出以便直接测试」）。

import { wallClockToEpoch } from "@summarizing/shared";

/** 待办渐强窗口：**24 小时**——与行的「临近」描边同一个阈值（用户 2026-10-22：
 *  「排期还有一段时间的也有绿色」，5 天窗在 30 小时外仍有 17% 底色）。 */
const URGENT_WINDOW_MS = 24 * 60 * 60_000;

/** 完成淡出窗口：5 天（刚完成最浓，越久越淡——量的是一件事过去多久，与待办紧迫不同轴）。 */
const DONE_FADE_WINDOW_MS = 5 * 24 * 60 * 60_000;

/** 浓淡封顶：两条曲线共用的最大混合比（%）——待办「恰到期」与「刚完成」并列为最浓。 */
export const TINT_CAP_PERCENT = 40;

/** 待办临近强度（0..1，立方曲线，24 小时窗；过期/非法日期/超窗归 0）。 */
export function urgencyStrength(dueTsMs: number, nowMs: number): number {
  if (Number.isNaN(dueTsMs)) return 0;
  const ms = dueTsMs - nowMs;
  if (ms <= 0 || ms >= URGENT_WINDOW_MS) return 0;
  const p = 1 - ms / URGENT_WINDOW_MS;
  return p ** 3;
}

/** 完成淡出强度（0..1，立方曲线，锚完成时刻；脏 anchor/负年龄/超窗夹取为 0）。 */
export function doneFadeStrength(anchor: string, nowMs: number): number {
  const anchorMs = wallClockToEpoch(anchor); // 墙钟串按固定 +08:00 解析（D-97）
  if (Number.isNaN(anchorMs)) return 0;
  const age = Math.max(nowMs - anchorMs, 0);
  if (age >= DONE_FADE_WINDOW_MS) return 0;
  const r = 1 - age / DONE_FADE_WINDOW_MS;
  return r ** 3;
}
