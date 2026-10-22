import {
  ChartColumn,
  CircleUserRound,
  Info,
  Inbox,
  LayoutDashboard,
  ScrollText,
  Settings,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { cn } from "../lib/cn";

/** 活动栏一级入口标识（007 定序）——每个值对应一个主视图，各自一个入口图标。 */
export type View = "board" | "notice" | "uncertain" | "pipeline" | "trash";

/** 活动栏一级入口（007 定序）：看板 → 通知 → 存疑库审核 → 流水 → 回收站；账户/设置/关于固定最底。
 *  通知/回收站各是一个**入口**（点了进新页面），图标只是门牌——与看板/存疑库/流水平级。 */
export function ActivityBar({
  view,
  uncertainCount,
  unreadNoticeCount,
  onHome,
  onShowNotice,
  onShowUncertain,
  onShowPipeline,
  onShowTrash,
  onOpenUsage,
  onOpenAccount,
  onOpenSettings,
  onOpenAbout,
}: {
  view: View;
  /** open 条数——徽标计数（0 = 不显示徽标）。 */
  uncertainCount: number;
  /** 未读通知数——有未读才显示（纯计数，不写「你还有 N 条没看」式措辞，OQ-10）。 */
  unreadNoticeCount: number;
  /** 看板图标：在别页时 = 切回看板；已在看板 = 回顶部锚点。 */
  onHome: () => void;
  onShowNotice: () => void;
  onShowUncertain: () => void;
  onShowPipeline: () => void;
  onShowTrash: () => void;
  /** 用量仪表盘（010）：左下角独立入口——与账户/设置/关于同组。 */
  onOpenUsage: () => void;
  /** 账户弹层（用户名/改密/接入地址/退出——006）。 */
  onOpenAccount: () => void;
  onOpenSettings: () => void;
  /** 关于弹层（产品信息 + 更新日志——2026-10-13）。 */
  onOpenAbout: () => void;
}) {
  return (
    // 窄屏隐藏（<640px）：改用底部悬浮导航 MobileNav；这 48px 宽度全部还给内容区
    <nav className="hidden w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-2 sm:flex">
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
        title={unreadNoticeCount > 0 ? `通知（${unreadNoticeCount} 条未读）` : "通知（都已读过）"}
        onClick={onShowNotice}
        className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent-soft hover:text-accent",
          view === "notice" ? "text-accent" : "text-ink-muted",
        )}
      >
        <Inbox size={18} />
        {unreadNoticeCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-warn px-1 text-center text-[10px] font-medium leading-4 text-surface">
            {unreadNoticeCount}
          </span>
        )}
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
        title="流水：一条信息从进站到成事项的全程"
        onClick={onShowPipeline}
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent-soft hover:text-accent",
          view === "pipeline" ? "text-accent" : "text-ink-muted",
        )}
      >
        <ScrollText size={18} />
      </button>
      <button
        title="回收站：删掉的信息，可恢复"
        onClick={onShowTrash}
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent-soft hover:text-accent",
          view === "trash" ? "text-accent" : "text-ink-muted",
        )}
      >
        <Trash2 size={18} />
      </button>
      <button
        title="用量：这段时间花掉了多少 token"
        onClick={onOpenUsage}
        className="mt-auto flex h-9 w-9 items-center justify-center rounded-md text-ink-muted hover:bg-accent-soft hover:text-accent"
      >
        <ChartColumn size={18} />
      </button>
      <button
        title="账户"
        onClick={onOpenAccount}
        className="flex h-9 w-9 items-center justify-center rounded-md text-ink-muted hover:bg-accent-soft hover:text-accent"
      >
        <CircleUserRound size={18} />
      </button>
      <button
        title="设置"
        onClick={onOpenSettings}
        className="flex h-9 w-9 items-center justify-center rounded-md text-ink-muted hover:bg-accent-soft hover:text-accent"
      >
        <Settings size={18} />
      </button>
      <button
        title="关于（版本与更新日志）"
        onClick={onOpenAbout}
        className="flex h-9 w-9 items-center justify-center rounded-md text-ink-muted hover:bg-accent-soft hover:text-accent"
      >
        <Info size={18} />
      </button>
    </nav>
  );
}
