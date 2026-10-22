import { MoveHorizontal } from "lucide-react";

/** 首次使用的手势提示（2026-10-22 用户定：手势不能靠蒙）。
 *  只做一行说明 + 一个「知道了」；滑过一次或点过它就永久不再出现（父组件负责记已读）。 */
export function GestureHint({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div className="pt-2">
      <div className="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-ink-muted">
        <MoveHorizontal size={14} className="shrink-0" />
        <span className="min-w-0 flex-1">{text}</span>
        <button className="shrink-0 cursor-pointer underline" onClick={onDismiss}>
          知道了
        </button>
      </div>
    </div>
  );
}
