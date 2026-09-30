import { LayoutDashboard, Settings, TriangleAlert } from "lucide-react";
import { cn } from "../lib/cn";

/** 最左活动栏（05§一）：主视图切换（看板 / 存疑库审核，D-89）+ 设置固定最底。
 *  对话开关不在这——它管的停靠面板在右边，开关也放右边（用户 2026-09-26 定）。 */
export function ActivityBar({
  view,
  uncertainCount,
  onHome,
  onShowUncertain,
  onOpenSettings,
}: {
  view: "board" | "uncertain";
  /** open 条数——徽标计数（0 = 不显示徽标）。 */
  uncertainCount: number;
  /** 看板图标：在审核页时 = 切回看板；已在看板 = 回顶部锚点。 */
  onHome: () => void;
  onShowUncertain: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-2">
      <button
        title={view === "board" ? "回到看板顶部" : "回看板"}
        onClick={onHome}
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-md text-accent hover:bg-accent-soft",
          view !== "board" && "text-ink-muted hover:text-accent",
        )}
      >
        <LayoutDashboard size={18} />
      </button>
      <button
        title={uncertainCount > 0 ? `存疑库审核（${uncertainCount} 条待定夺）` : "存疑库审核（空）"}
        onClick={onShowUncertain}
        className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent-soft hover:text-accent",
          view === "uncertain" ? "text-accent" : "text-ink-muted",
        )}
      >
        <TriangleAlert size={18} />
        {uncertainCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-warn px-1 text-center text-[10px] font-medium leading-4 text-surface">
            {uncertainCount}
          </span>
        )}
      </button>
      <button
        title="设置"
        onClick={onOpenSettings}
        className="mt-auto flex h-9 w-9 items-center justify-center rounded-md text-ink-muted hover:bg-accent-soft hover:text-accent"
      >
        <Settings size={18} />
      </button>
    </nav>
  );
}
