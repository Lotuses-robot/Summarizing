// 对话面板滚动锚定的判定（specs/001-chat-scroll-anchor）。
// 纯决策函数住 lib（项目惯例，参照 urgency/appearance「独立导出以便直接测试」）；
// DOM 接线（ref/onScroll/滚到底）在 ChatPanel，不在这里。

/** 「仍停在底部」的判定容差（px）：几十像素内的滚动抖动/亚像素差不算离开底部。 */
const NEAR_BOTTOM_TOLERANCE_PX = 48;

/** 滚动容器是否停在底部附近——「跟随最新消息」与否的唯一依据（spec FR-003）。
 *  无滚动条（scrollHeight ≤ clientHeight）时恒为真：没有可离开的底部（spec Edge Case）。 */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  tolerancePx: number = NEAR_BOTTOM_TOLERANCE_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= tolerancePx;
}
