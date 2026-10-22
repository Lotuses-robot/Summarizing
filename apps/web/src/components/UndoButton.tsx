import { Undo2 } from "lucide-react";
import { cn } from "../lib/cn";

/** 撤销钮（2026-10-22 用户定：不再用文字「撤回/撤销」，也不做底部悬浮条——撤销就长在被打断的东西上）。
 *  尺寸与关闭钮同一档：40px，手指设备 44px；图标是它唯一的语义，所以 title/aria-label 必须写清楚撤销的是什么。
 *  `fadeSeconds` = 撤销窗口：钮在这段时间里**逐渐变暗**，暗到底就是提交时刻——倒计时不再是另一个环/数字。 */
export function UndoButton({
  onClick,
  label,
  fadeSeconds,
}: {
  onClick: () => void;
  label: string;
  /** 传入即启用「渐暗倒计时」（秒）；不传就是常亮。 */
  fadeSeconds?: number;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-line bg-surface text-ink shadow-md transition-transform active:scale-95 pointer-coarse:h-11 pointer-coarse:w-11",
        fadeSeconds !== undefined && "undo-fade",
      )}
      style={fadeSeconds === undefined ? undefined : { animationDuration: `${fadeSeconds}s` }}
    >
      <Undo2 size={18} />
    </button>
  );
}
