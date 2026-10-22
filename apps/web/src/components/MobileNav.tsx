import { useEffect, useRef, useState } from "react";
import {
  ChartColumn,
  CircleUserRound,
  Ellipsis,
  Inbox,
  Info,
  LayoutDashboard,
  MessageSquare,
  ScrollText,
  Settings,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
import { pushEscLayer } from "../lib/escLayer";
import type { View } from "./ActivityBar";

// 窄屏底部导航（2026-10-22 用户定，果味悬浮导航）：
// **左「更多」独立悬浮 · 中三颗连成一组 · 右「对话」独立悬浮**。
// 视觉层级靠间距表达，而非等距排开（用户 2026-10-22：组内要连在一起，组与组之间自然拉开；
// 屏边留白比组间距更大——「浮着」而不是「贴着」）。
// 「更多」「处理」有二级：点在它正上方冒气泡（挂在各自相对容器里，与钮同轴）；
// 展开时整屏下半部渐变磨玻璃，注意力收到底部。
// 收起规则：再点同钮 / 选中任一项 / 点内容区 / 页面滚动 / Esc（用户定「失焦消失」）。
// 宽屏（≥640）用左侧竖栏，本组件不渲染。

/** 一枚二级气泡：标签 + 图标 + 点击动作。 */
interface BubbleItem {
  key: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
  run: () => void;
}

/** 一个可点击的导航钮（直接入口或带二级的组入口）。 */
interface NavButton {
  key: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
  /** 直接入口对应的视图（判断当前高亮）；组入口给出它覆盖的一组成员视图。 */
  views?: View[];
  items?: BubbleItem[];
  run?: () => void;
}

/** 徽标角标（与活动栏同款：有数才显示）。 */
function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-warn px-1 text-center text-[10px] font-medium leading-4 text-surface">
      {count}
    </span>
  );
}

/** 窄屏底部导航（悬浮圆钮 + 上冒气泡）。 */
export function MobileNav({
  view,
  uncertainCount,
  unreadNoticeCount,
  onShowBoard,
  onShowNotice,
  onShowUncertain,
  onShowPipeline,
  onShowTrash,
  onOpenUsage,
  onOpenAccount,
  onOpenSettings,
  onOpenAbout,
  onToggleChat,
}: {
  view: View;
  uncertainCount: number;
  unreadNoticeCount: number;
  onShowBoard: () => void;
  onShowNotice: () => void;
  onShowUncertain: () => void;
  onShowPipeline: () => void;
  onShowTrash: () => void;
  onOpenUsage: () => void;
  onOpenAccount: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  onToggleChat: () => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 「更多」：配置与账户类杂项（低频，独立悬浮在最左）
  const more: NavButton = {
    key: "more",
    label: "更多",
    icon: Ellipsis,
    items: [
      { key: "usage", label: "用量", icon: ChartColumn, run: onOpenUsage },
      { key: "account", label: "账户", icon: CircleUserRound, run: onOpenAccount },
      { key: "settings", label: "设置", icon: Settings, run: onOpenSettings },
      { key: "about", label: "关于", icon: Info, run: onOpenAbout },
    ],
  };

  // 中间三颗连成一组：事项 / 通知 /（处理 = 存疑 + 流水 + 回收站）
  const middle: NavButton[] = [
    { key: "board", label: "事项", icon: LayoutDashboard, views: ["board"], run: onShowBoard },
    {
      key: "notice",
      label: "通知",
      icon: Inbox,
      views: ["notice"],
      badge: unreadNoticeCount,
      run: onShowNotice,
    },
    {
      key: "process",
      label: "处理",
      icon: TriangleAlert,
      views: ["uncertain", "pipeline", "trash"],
      badge: uncertainCount,
      items: [
        {
          key: "uncertain",
          label: "存疑",
          icon: TriangleAlert,
          badge: uncertainCount,
          run: onShowUncertain,
        },
        { key: "pipeline", label: "流水", icon: ScrollText, run: onShowPipeline },
        { key: "trash", label: "回收站", icon: Trash2, run: onShowTrash },
      ],
    },
  ];

  /** 当前展开的那一组的气泡（磨玻璃遮罩要盖到它们的顶边）。 */
  const openItems =
    openKey === null
      ? []
      : openKey === more.key
        ? (more.items ?? [])
        : (middle.find((b) => b.key === openKey)?.items ?? []);

  // Esc 分层退出：气泡开着 → 只收气泡（不惊动页面层）
  useEffect(() => {
    if (openKey === null) return;
    return pushEscLayer(() => setOpenKey(null));
  }, [openKey]);

  // 「失焦消失」：点内容区 / 页面滚动 都收起（捕获阶段——不依赖气泡自身是否收到事件）
  useEffect(() => {
    if (openKey === null) return;
    /** 点击落在导航之外 → 收起（钮自己的点击在 onClick 里处理）。 */
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && e.target instanceof Node && root.contains(e.target)) return;
      setOpenKey(null);
    };
    /** 主区滚动 → 收起（气泡是浮层，跟着内容走会漂）。 */
    const onScroll = () => setOpenKey(null);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [openKey]);

  /** 点气泡：先收气泡，再执行动作（不留下悬空的一层）。 */
  const pick = (item: BubbleItem) => {
    setOpenKey(null);
    item.run();
  };

  /** 渲染一个导航钮（含它的气泡列与当前视图标记）。size = 直径（px）。 */
  const renderButton = (b: NavButton, size: "outer" | "inner") => {
    const isOpen = openKey === b.key;
    const isActive = b.views?.includes(view) ?? false;
    // 收进局部常量：narrowing 才能带进下方 map 回调（属性访问的收窄跨不进闭包）
    const items = b.items;
    const px = size === "outer" ? "h-14 w-14" : "h-12 w-12";
    return (
      <div key={b.key} className="relative">
        <button
          title={b.label}
          aria-expanded={b.items === undefined ? undefined : isOpen}
          onClick={() => {
            if (b.items !== undefined) {
              setOpenKey((cur) => (cur === b.key ? null : b.key));
              return;
            }
            setOpenKey(null);
            b.run?.();
          }}
          className={cn(
            "relative flex items-center justify-center rounded-full transition-all active:scale-95",
            px,
            // 组内钮没有自己的底（坐在胶囊上）——展开态换成一块中性实底，读作「选出的一格」；
            // 独立钮展开态是抬起加阴影。两者都不用主题色，绿只留给「当前视图」。
            size === "inner"
              ? isOpen
                ? "bg-surface text-ink shadow-sm"
                : isActive
                  ? "text-accent"
                  : "text-ink-muted active:bg-accent-soft"
              : cn(
                  "glass",
                  isOpen ? "text-ink shadow-lg" : isActive ? "text-accent" : "text-ink-muted",
                ),
          )}
        >
          <b.icon size={size === "outer" ? 22 : 20} />
          <Badge count={b.badge ?? 0} />
          {/* 当前视图标记：钮下缘一枚小圆点。与「展开态」不同源——同屏最多一处绿（用户 2026-10-22）。 */}
          <span
            className={cn(
              "absolute bottom-1 h-1 w-1 rounded-full bg-accent transition-opacity",
              isActive ? "opacity-100" : "opacity-0",
            )}
          />
        </button>
        {isOpen && items !== undefined && (
          // 间距从**可视表面**量起：组内钮坐在胶囊上，胶囊的 3px 内边距 + 1px 边框露在钮外，
          // 所以从钮顶算起要多让出这 4px——否则中间那颗的气泡比两侧的贴得更紧（用户 2026-10-22）。
          <div
            className={cn(
              "absolute bottom-full left-1/2 flex -translate-x-1/2 flex-col items-center gap-2.5",
              size === "inner" ? "mb-[calc(0.75rem+4px)]" : "mb-3",
            )}
          >
            {/* 阅读顺序自上而下（与宽屏竖栏同序）；离钮最近的那颗先冒出，往外一颗颗接上 */}
            {items.map((it, i) => (
              <button
                key={it.key}
                title={it.label}
                onClick={() => pick(it)}
                className="bubble-in glass relative flex h-[3.25rem] w-[3.25rem] shrink-0 items-center justify-center rounded-full text-ink shadow-md"
                style={{ animationDelay: `${(items.length - 1 - i) * 40}ms` }}
              >
                <it.icon size={19} />
                <Badge count={it.badge ?? 0} />
                <span className="pointer-events-none absolute left-full ml-2.5 whitespace-nowrap text-xs text-ink-muted">
                  {it.label}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* 气泡展开时，屏幕下半部渐变磨玻璃（用户 2026-10-22）：
          **遮罩顶边跟着气泡列的顶边走**（用户二次反馈「模糊效果不够高，按照弹出来泡泡的高度往上模糊」），
          所以高度按气泡数算出、再上探 1.5rem 做一段软过渡；越靠下越糊，把注意力收到底部导航上。 */}
      {openKey !== null && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-x-0 bottom-0 z-20 sm:hidden"
          style={{
            // 常量与下方样式一一对应：留白 1.25 + 胶囊 3.5 + 气泡间隙 1.1875 + 上探 4，
            // 气泡 3.25/颗、气泡间距 0.625——改气泡尺寸时这里要一起改。
            // 上探的 4rem 正是遮罩渐变长度：到最外侧那颗气泡的顶边时已是全糊。
            height: `calc(${4 + 1.25 + 3.5 + 1.1875}rem + ${openItems.length} * 3.25rem + ${openItems.length - 1} * 0.625rem + env(safe-area-inset-bottom))`,
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            maskImage: "linear-gradient(to bottom, transparent, black 4rem)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent, black 4rem)",
          }}
        />
      )}

      <div
        ref={rootRef}
        // 三层结构，间距随语义递增：钮内 0 → 组内 gap-1（4px）→ 组间自然拉开 → 屏边 1.25rem。
        // pointer-events-none 的大容器铺满底部，只让钮本身接收点击、不挡主区滚动。
        className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex items-center justify-between px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:hidden"
      >
        {/* 左：更多（独立悬浮） */}
        <div className="pointer-events-auto">{renderButton(more, "outer")}</div>

        {/* 中：事项 / 通知 / 处理 **连成一组**（同一层毛玻璃胶囊，组内 4px）。
            内边距 3px + 边框 1px：胶囊外高 = 48 + 6 + 2 = 56，与两侧独立钮同高——
            三区落在同一条视觉基线上（用户 2026-10-22：胶囊比旁边大，气泡就贴得紧了）。 */}
        <div className="glass pointer-events-auto flex items-center gap-1 rounded-full p-[3px]">
          {middle.map((b) => renderButton(b, "inner"))}
        </div>

        {/* 右：对话（独立悬浮，主题色实心——唯一录入入口） */}
        <button
          title="对话"
          onClick={onToggleChat}
          className="pointer-events-auto flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-lg active:scale-95"
        >
          <MessageSquare size={22} />
        </button>
      </div>
    </>
  );
}
