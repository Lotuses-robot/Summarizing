/** 一次性提示条（底部浮起）：删除后可撤销（2026-10-22 用户定）。
 *  删除仍然一步到位（D-106 不弹确认），但给出 5 秒反悔窗口——让用户「敢点」。
 *  位置避开底部悬浮导航：窄屏抬高到导航上方，宽屏贴底。 */
export function UndoBar({
  text,
  actionLabel,
  onAction,
}: {
  /** 一句话，如「已移入回收站」。 */
  text: string;
  /** 动作按钮文案，如「撤销」。 */
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-5 sm:bottom-6"
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-line bg-surface px-4 py-2 shadow-lg">
        <span className="text-sm text-ink">{text}</span>
        <button className="cursor-pointer text-sm font-medium text-accent" onClick={onAction}>
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
