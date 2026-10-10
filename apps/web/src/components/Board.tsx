import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Archive, Check, ChevronDown, ChevronRight, Undo2 } from "lucide-react";
import {
  dueDateElement,
  itemName,
  relativeDueText,
  type BoardView,
  type ItemRow,
} from "@summarizing/shared";
import { cn } from "../lib/cn";
import { loadSectionFold, saveSectionFold } from "../lib/appearance";
import { pushEscLayer } from "../lib/escLayer";
import { doneFadeStrength, TINT_CAP_PERCENT, urgencyStrength } from "../lib/urgency";
import type { BoardFilter } from "./FilterBar";
import { api } from "../api";
import { ItemBody } from "./board/ItemBody";

type RowAction = "complete" | "reopen" | "archive";

// 四段元数据唯一出处（D-80/D-83；D-89 存疑段退场）——段名/提示/空态只改这里，派生物（allRows/段定位/计数）全部由此推导
type SectionKey = Exclude<keyof BoardView, "failedRawInputs">;
const SECTION_META: {
  key: SectionKey;
  title: string;
  hint: string | undefined;
  emptyText: string;
}[] = [
  {
    key: "undated",
    title: "日期未知",
    hint: undefined,
    emptyText: "其余已知事项都有日期",
  },
  {
    key: "scheduled",
    title: "已排期",
    hint: undefined,
    emptyText: "暂无已排期事项",
  },
  {
    key: "done",
    title: "已完成",
    hint: undefined,
    emptyText: "还没有完成过事项",
  },
  {
    key: "archived",
    title: "已归档",
    hint: undefined,
    emptyText: "暂无已归档事项",
  },
];

const NEAR_MS = 24 * 60 * 60_000; // 临近 = 24h 内到期（05§二 四点标记）

/** 日期显示成「月-日 时:分」——看板行内的短格式。 */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 看板单行（用户 2026-09-27 行布局 v3，借鉴 Todoist/Things 3）：标题 → 相对人话 ddl → tags
 *  同一条阅读线内联（不用视线右缘远跳）；ddl 颜色编码（过期红/临近 accent/远灰），悬停给绝对时间；
 *  右缘只留状态点与新微标。悬停显形快捷按钮（勾=完成/恢复、归档）。
 *  点击整行 = 展开/收起详情（单开互斥由看板保证）；键盘 ↑↓ 选中行有底色。 */
function Row({
  row,
  expanded,
  flash,
  active,
  viewedLocally,
  onToggle,
  onTag,
  onQuickAction,
  children,
}: {
  row: ItemRow;
  expanded: boolean;
  flash: boolean;
  active: boolean;
  viewedLocally: ReadonlySet<string>;
  onToggle: () => void;
  onTag: (tag: string) => void;
  onQuickAction: (id: string, action: RowAction) => void;
  children: ReactNode;
}) {
  const { item } = row;
  const dueElement = dueDateElement(item);
  const dueText = dueElement?.text ?? null;
  const dueNote = dueElement?.note ?? null;
  // 「新」微标：待办且未被打开过（点开即消，用户 2026-09-27）；已完成/已归档不亮
  const isNew = item.status === "todo" && !row.viewed && !viewedLocally.has(item.id);
  // 临近/过期都在渲染期派生（01§4.15「派生不落库」）；只对待办追讨
  const dueTs = dueText === null ? Number.NaN : new Date(dueText).getTime();
  const near =
    !row.overdue &&
    item.status === "todo" &&
    !Number.isNaN(dueTs) &&
    dueTs >= Date.now() &&
    dueTs - Date.now() <= NEAR_MS;
  // 行内时间字的红标：只要 ddl 已过且未归档就标红（含已完成行——「逾期才完成」也是值得看见的信息）
  const timeOverdue = !Number.isNaN(dueTs) && item.status !== "archived" && dueTs < Date.now();
  // 相对人话时间（Todoist 式）：非法日期退回短格式——不编造
  const dueRelative = dueText === null ? null : relativeDueText(dueText, new Date());
  // 越临近越强调（用户 2026-09-27 二轮：立方浓淡曲线，lib/urgency 唯一出处）——
  // 7h≈83% / 2d≈22% / 4.5d≈0.1%，临期急剧加深、远期几乎隐形；过期行另有红色描边语义，不参与渐变
  const urgency = item.status === "todo" && !row.overdue ? urgencyStrength(dueTs, Date.now()) : 0;
  // 已完成淡出（同款立方曲线）——锚定完成时刻（completedAt）：刚完成最浓，越久淡得越快
  const doneFade =
    item.status === "done" ? doneFadeStrength(row.completedAt ?? row.updatedAt, Date.now()) : 0;
  // 日期未知（用户 2026-09-27 二轮：不要背景，改主题色细边框——与过期红框同手法；
  // 2026-09-30 修：原固定蓝 info 不跟色板，改 accent）

  /** 行背景色：待办临近渐强 / 已完成淡出——全部从主题强调色出（跟色板走）；
   *  封顶同档（TINT_CAP_PERCENT）——「刚完成最亮」由此成立（走查修订 2026-09-30）。 */
  const rowBg = (() => {
    if (item.status === "done" && doneFade > 0) {
      return `color-mix(in oklab, var(--accent) ${Math.round(doneFade * TINT_CAP_PERCENT)}%, var(--surface))`;
    }
    if (urgency > 0) {
      return `color-mix(in oklab, var(--accent) ${Math.round(urgency * TINT_CAP_PERCENT)}%, var(--surface))`;
    }
    return undefined;
  })();

  return (
    <li
      id={`row-${item.id}`}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-md border border-transparent py-2 pl-5 pr-3 hover:bg-canvas",
        row.overdue && "bg-danger-soft/40", // 逾期轻提示：淡红底（用户 2026-09-27：去框留底）
        near ? "border-accent/60" : "", // 近截止高亮（跟色板走）
        flash && "row-flash",
        active && "bg-canvas ring-1 ring-accent",
      )}
      style={
        rowBg
          ? {
              backgroundColor: rowBg,
            }
          : undefined
      }
      onClick={onToggle}
    >
      {/* 左缘状态条（用户 2026-09-27 定；D-89 修订）：仅保留推断条（存疑琥珀条随存疑段退场）；
          2026-09-30 修：固定蓝 info → 主题色 accent（跟色板走）。
          固定高度钉在标题行——不随展开体拉伸（否则展开行的条会巨长）。 */}
      {row.dueDateInferred && dueNote !== null && (
        <span
          className="absolute left-1.5 top-2.5 h-5 w-1 rounded-full bg-accent"
          title={`推断：${dueText ?? ""} · 依据：${dueNote}`}
        />
      )}
      <div className="flex items-center gap-2 text-sm font-medium">
        <span
          className={cn(
            "min-w-0 truncate",
            item.status === "done" && "text-ink-muted line-through",
          )}
        >
          {itemName(item.elements)}
        </span>
        {dueText !== null && (
          <span
            className={cn(
              "shrink-0 text-xs font-normal",
              timeOverdue ? "text-danger" : near ? "text-accent" : "text-ink-muted",
            )}
            title={`到期 ${fmtDate(dueText)}`}
          >
            {dueRelative ?? fmtDate(dueText)}
          </span>
        )}
        {isNew && <span className="chip shrink-0 border-accent/50 text-accent">新</span>}
        {item.tags.map((t) => (
          <button
            key={t}
            className="chip shrink-0 cursor-pointer hover:text-accent"
            title={`筛选标签「${t}」`}
            onClick={(e) => {
              e.stopPropagation();
              onTag(t);
            }}
          >
            {t}
          </button>
        ))}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs font-normal text-ink-muted">
          {item.status !== "archived" && (
            <button
              className="row-act"
              title="归档"
              onClick={(e) => {
                e.stopPropagation();
                onQuickAction(item.id, "archive");
              }}
            >
              <Archive size={13} />
            </button>
          )}
          {item.status === "todo" && (
            <button
              className="row-act"
              title="标完成"
              onClick={(e) => {
                e.stopPropagation();
                onQuickAction(item.id, "complete");
              }}
            >
              <Check size={13} />
            </button>
          )}
          {item.status !== "todo" && (
            <button
              className="row-act"
              title={item.status === "archived" ? "撤回归档" : "恢复待办"}
              onClick={(e) => {
                e.stopPropagation();
                onQuickAction(item.id, "reopen");
              }}
            >
              <Undo2 size={13} />
            </button>
          )}
        </span>
      </div>
      {expanded && (
        // 滚动规（用户 2026-09-26 修订）：max-h + 内滚；不做 overscroll 锁——滚到底自然接页面滚动。
        // 框内不放标题/收起按钮（用户 2026-09-27：框外行标题常驻、即收起入口，框内重复属冗余）；
        // 展开体内点击在此掐掉冒泡，否则任何点击都会冒到行上触发收起。
        <div
          className="mt-2 max-h-[70vh] overflow-y-auto rounded-md border border-line bg-surface"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bg-canvas/40">{children}</div>
        </div>
      )}
    </li>
  );
}

/** 看板段：计数头（总计数，不随筛选变）+ 折叠 + 空态一句话（禁愧疚/鸡血措辞）。 */
function Section({
  title,
  rows,
  total,
  hint,
  emptyText,
  folded,
  expandedId,
  flashId,
  activeId,
  viewedLocally,
  onToggleFold,
  onToggleExpand,
  onTag,
  onQuickAction,
}: {
  title: string;
  rows: ItemRow[];
  total: number;
  hint: string | undefined;
  emptyText: string;
  folded: boolean;
  expandedId: string | null;
  flashId: string | null;
  activeId: string | null;
  viewedLocally: ReadonlySet<string>;
  onToggleFold: () => void;
  onToggleExpand: (id: string) => void;
  onTag: (tag: string) => void;
  onQuickAction: (id: string, action: RowAction) => void;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface p-3">
      <button
        className="flex w-full items-center gap-2 text-left text-sm font-semibold"
        onClick={onToggleFold}
      >
        {folded ? (
          <ChevronRight size={14} className="text-ink-muted" />
        ) : (
          <ChevronDown size={14} className="text-ink-muted" />
        )}
        {title}
        <span className="rounded-full bg-canvas px-1.5 text-xs font-normal text-ink-muted">
          {total}
        </span>
      </button>
      {!folded && (
        <>
          {hint !== undefined && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
          {rows.length === 0 ? (
            <p className="mt-2 text-xs text-ink-muted">
              {total === 0 ? emptyText : "无匹配当前筛选"}
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {rows.map((row) => (
                <Row
                  key={row.item.id}
                  row={row}
                  expanded={expandedId === row.item.id}
                  flash={flashId === row.item.id}
                  active={activeId === row.item.id}
                  viewedLocally={viewedLocally}
                  onToggle={() => onToggleExpand(row.item.id)}
                  onTag={onTag}
                  onQuickAction={onQuickAction}
                >
                  {expandedId === row.item.id && <ItemBody id={row.item.id} />}
                </Row>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** 看板四段（01§4.3 / D-89）+ 行内展开（单开互斥）+ 深链定位；筛选状态在 App 顶栏（FilterBar），
 *  这里只按 filter prop 过滤。 */
export function Board({
  board,
  onRefresh,
  focus,
  filter,
  onTagClick,
}: {
  board: BoardView;
  onRefresh: () => void;
  focus: { id: string; token: number } | null;
  filter: BoardFilter;
  onTagClick: (tag: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [viewedLocally, setViewedLocally] = useState<ReadonlySet<string>>(new Set());
  const [folded, setFolded] = useState<Record<SectionKey, boolean>>(() => ({
    undated: loadSectionFold("undated"),
    scheduled: loadSectionFold("scheduled"),
    done: loadSectionFold("done"),
    archived: loadSectionFold("archived"),
  }));
  const handledToken = useRef(0);

  /** 筛选谓词：选中的标签 token 全部必须携带（AND 收窄）；查询串对标题与 tags 做包含匹配（D-80）。 */
  const visible = useCallback(
    (r: ItemRow): boolean => {
      if (!filter.tags.every((t) => r.item.tags.includes(t))) return false;
      const q = filter.query.trim();
      if (q !== "") {
        const hay = [itemName(r.item.elements), ...r.item.tags];
        if (!hay.some((s) => s.includes(q))) return false;
      }
      return true;
    },
    [filter],
  );

  const allRows = useMemo(() => SECTION_META.flatMap((m) => board[m.key]), [board]);

  /** 事项 id → 所在段 key（键盘导航与「展开行是否可见」判定共用）——段名集合从 SECTION_META
   *  派生（唯一出处），拼错段名无处可写。 */
  const sectionKeyById = useMemo(() => {
    const m = new Map<string, SectionKey>();
    for (const meta of SECTION_META) {
      for (const r of board[meta.key]) m.set(r.item.id, meta.key);
    }
    return m;
  }, [board]);

  /** 当前筛选下的可见行（段折叠在键盘导航处另行排除）。 */
  const visibleRows = useMemo(() => allRows.filter(visible), [allRows, visible]);

  // Esc 分层退出：展开体打开期间注册「收起」层（05§六）
  useEffect(() => {
    if (expandedId === null) return;
    return pushEscLayer(() => setExpandedId(null));
  }, [expandedId]);

  // 点开（任何路径：点击/键盘/深链）即标记已查看，「新」即消（用户 2026-09-27）；
  // 上报失败仅延后消失（下次轮询/展开重报）
  useEffect(() => {
    if (expandedId === null) return;
    setViewedLocally((s) => new Set(s).add(expandedId));
    void api.viewed(expandedId).catch(() => {});
  }, [expandedId]);

  // 展开行被筛掉/所在段折叠后，收起展开态（纯数据判定，不依赖 DOM 时序）
  useEffect(() => {
    if (expandedId === null) return;
    const key = sectionKeyById.get(expandedId);
    const hidden =
      key === undefined || folded[key] || !visibleRows.some((r) => r.item.id === expandedId);
    if (hidden) setExpandedId(null);
  }, [expandedId, sectionKeyById, folded, visibleRows]);

  // 键盘流（05§六）：↑↓ 行间移动、Enter 展开/收起；输入态/按钮聚焦让路（Enter 要留给按钮原生激活）。
  // 不带依赖数组注册——闭包每渲染都新鲜，省得追依赖
  useEffect(() => {
    /** 行导航：↑↓ 移动选中、Enter 切换展开（输入元素与按钮聚焦时不拦；IME 组合态不拦）。 */
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLButtonElement
      ) {
        return;
      }
      const flat = visibleRows.filter((r) => {
        const key = sectionKeyById.get(r.item.id);
        return key === undefined ? true : !folded[key];
      });
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (flat.length === 0) return;
        const idx = activeId === null ? -1 : flat.findIndex((r) => r.item.id === activeId);
        // ↑ 从未选中直接跳最后一行，↓ 跳第一行；到顶底就停
        const next =
          idx === -1
            ? e.key === "ArrowDown"
              ? 0
              : flat.length - 1
            : e.key === "ArrowDown"
              ? Math.min(idx + 1, flat.length - 1)
              : Math.max(idx - 1, 0);
        const target = flat[next];
        if (target === undefined) return;
        setActiveId(target.item.id);
        document.getElementById(`row-${target.item.id}`)?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && activeId !== null) {
        e.preventDefault();
        setExpandedId(expandedId === activeId ? null : activeId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const sections = SECTION_META.map((m) => ({ ...m, rows: board[m.key] }));

  /** 切换折叠：状态与记忆同写（偏好，丢了不影响功能）。 */
  const toggleFold = (key: SectionKey) => {
    const next = !folded[key];
    setFolded({ ...folded, [key]: next });
    saveSectionFold(key, next);
  };

  /** 展开切换：单开互斥——展开 B 自动收起 A（D-80 手风琴）。 */
  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  /** 行悬停快捷动作：发状态请求 + 刷新看板；展开体随行换段，收起避免旧详情误导。
   *  失败无按钮级提示（看板无 toast 机制）——刷新让看板如实呈现现状。 */
  const quickAction = (id: string, action: RowAction) => {
    const p =
      action === "complete"
        ? api.complete(id)
        : action === "reopen"
          ? api.reopen(id)
          : api.archive(id);
    void p
      .then(() => {
        setExpandedId(null);
        onRefresh();
      })
      .catch(() => onRefresh());
  };

  /** 深链（05§三）：展开所在段 → 展开行 → 布局稳定后滚到行并短促高亮（清筛选由 App 统一做）。
   *  token 防同一条深链被看板轮询重放。 */
  useEffect(() => {
    if (focus === null || focus.token === handledToken.current) return;
    handledToken.current = focus.token;
    setExpandedId(focus.id);
    const key = sectionKeyById.get(focus.id) ?? null;
    if (key !== null) {
      setFolded((f) => ({ ...f, [key]: false }));
      saveSectionFold(key, false);
    }
    setFlashId(focus.id);
    // 对话面板收起 / 段展开都改变布局——两帧后坐标才对
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document
          .getElementById(`row-${focus.id}`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }),
    );
  }, [focus, board, sectionKeyById]);

  // 「新」/flash 微标的消退计时独立成 effect：不随深链 effect 因轮询重跑而被 cleanup 误清
  useEffect(() => {
    if (flashId === null) return;
    const t = window.setTimeout(() => setFlashId(null), 2000);
    return () => window.clearTimeout(t);
  }, [flashId]);

  if (allRows.length === 0) {
    return (
      <main className="p-4">
        <div className="card text-sm text-ink-muted">
          还没有任何事项。有新信息随时丢进来，agent0 会自己理成事项。
        </div>
      </main>
    );
  }

  return (
    <main className="space-y-4 p-4">
      {sections.map((s) => (
        <Section
          key={s.key}
          title={s.title}
          rows={s.rows.filter(visible)}
          total={s.rows.length}
          hint={s.hint}
          emptyText={s.emptyText}
          folded={folded[s.key]}
          expandedId={expandedId}
          flashId={flashId}
          activeId={activeId}
          viewedLocally={viewedLocally}
          onToggleFold={() => toggleFold(s.key)}
          onToggleExpand={toggleExpand}
          onTag={onTagClick}
          onQuickAction={quickAction}
        />
      ))}
    </main>
  );
}
