import { X } from "lucide-react";
import { cn } from "../lib/cn";

/** 关闭按钮（2026-10-22 用户定）：圆形底 + 居中叉，全站弹层/面板/浮层统一用这一个。
 *
 *  尺寸取 40px（`h-10 w-10`），手指设备放大到 44px——与 Apple HIG 的 44pt 最小命中区对齐；
 *  不再用文字「关闭」按钮（窄屏一行里文字按钮既占宽又不像可点）。
 *  `label` 只进 `title`/`aria-label`：圆形钮没有文字，读屏靠它。 */
export function CloseButton({
  onClick,
  label = "关闭",
  className,
}: {
  onClick: () => void;
  /** 读屏与悬停提示（「关闭设置」「关闭对话」等，按场景说清楚关的是什么）。 */
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-black/5 hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11 dark:hover:bg-white/10",
        className,
      )}
    >
      <X size={18} />
    </button>
  );
}
