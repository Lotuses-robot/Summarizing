// 看板行浓淡的两条曲线（D-89 收口：同窗口、同立方、同封顶——唯一出处，Row 只调用）。
// 纯决策函数住 lib（项目惯例，参照 lib/appearance 的 resolveDark「独立导出以便直接测试」）。

/** 紧迫度窗口：5 天（待办临近渐强与完成淡出共用）。 */
const URGENCY_MS = 5 * 24 * 60 * 60_000;

/** 浓淡封顶：两条曲线共用的最大混合比（%）——待办「恰到期」与「刚完成」并列为最浓。 */
export const TINT_CAP_PERCENT = 40;

/** 待办临近强度（0..1，立方曲线，5 天窗；过期/非法日期/超窗归 0）。 */
export function urgencyStrength(dueTsMs: number, nowMs: number): number {
  if (Number.isNaN(dueTsMs)) return 0;
  const ms = dueTsMs - nowMs;
  if (ms <= 0 || ms >= URGENCY_MS) return 0;
  const p = 1 - ms / URGENCY_MS;
  return p ** 3;
}

/** 完成淡出强度（0..1，立方曲线，锚完成时刻；脏 anchor/负年龄/超窗夹取为 0）。 */
export function doneFadeStrength(anchor: string, nowMs: number): number {
  const anchorMs = new Date(anchor).getTime();
  if (Number.isNaN(anchorMs)) return 0;
  const age = Math.max(nowMs - anchorMs, 0);
  if (age >= URGENCY_MS) return 0;
  const r = 1 - age / URGENCY_MS;
  return r ** 3;
}
