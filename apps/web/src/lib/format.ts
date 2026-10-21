/** 数字压缩显示（用户 2026-10-21 指定）：1000 → 1K、12345 → 12.3K、1234567 → 1.23M。
 *  用 en-US 的 compact 记法（K/M/B），**不用 zh-CN 的「万/亿」**——按用户点名要 K/M。
 *  千位以下原样返回；`maximumSignificantDigits: 3` = 最多 3 位有效数字。 */
export function fmtCompact(n: number): string {
  if (Math.abs(n) < 1000) return String(n);
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumSignificantDigits: 3,
  }).format(n);
}

/** 精确值的千分位写法——给压缩数字当悬浮提示（「12.3K」悬浮看到「12,345」）。 */
export function fmtExact(n: number): string {
  return n.toLocaleString("zh-CN");
}
