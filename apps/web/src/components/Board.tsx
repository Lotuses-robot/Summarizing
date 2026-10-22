import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Trash2, Undo2 } from "lucide-react";
import {
  dueDateElement,
  itemName,
  MULTIMODAL_IMAGE_TAG,
  relativeDueText,
  wallClockToEpoch,
  type BoardView,
  type ItemRow,
} from "@summarizing/shared";
import { cn } from "../lib/cn";
import { UNDO_SECONDS, useSwipeActions } from "../lib/swipe";
import {
  loadSectionFold,
  loadSwipeHintSeen,
  markSwipeHintSeen,
  saveSectionFold,
} from "../lib/appearance";
import { pushEscLayer } from "../lib/escLayer";
import { GestureHint } from "./GestureHint";
import { UndoButton } from "./UndoButton";
import { doneFadeStrength, TINT_CAP_PERCENT, urgencyStrength } from "../lib/urgency";
import { fmtShortTime } from "../lib/time";
import { matchesFilter, type BoardFilter } from "./FilterBar";
import { api } from "../api";
import { ItemBody } from "./board/ItemBody";

type RowAction = "complete" | "reopen" | "trash";

// 三段元数据唯一出处（D-80；D-89 存疑段退场；007 取消归档后三段）——段名/提示/空态只改这里，派生物（allRows/段定位/计数）全部由此推导
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
];

const NEAR_MS = 24 * 60 * 60_000; // 临近 = 24h 内到期（05§二 四点标记）

/** 看板单行（用户 2026-09-27 行布局 v3，借鉴 Todoist/Things 3）：标题 → 相对人话 ddl → tags
 *  同一条阅读线内联（不用视线右缘远跳）；ddl 颜色编码（过期红/临近 accent/远灰），悬停给绝对时间；
 *  右缘只留状态点与新微标。悬停显形快捷按钮（勾=完成/恢复、删除）。
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
  pendingTrash,
  onCancelTrash,
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
  /** 本行处于删除的撤销窗口里（行右移+模糊消失，中央一颗撤销钮）。 */
  pendingTrash: boolean;
  /** 撤销本行的删除。 */
  onCancelTrash: () => void;
  children: ReactNode;
}) {
  const { item } = row;
  const dueElement = dueDateElement(item);
  const dueText = dueElement?.text ?? null;
  const dueNote = dueElement?.note ?? null;
  // 「新」微标：待办且未被打开过（点开即消，用户 2026-09-27）；已完成不亮
  const isNew = item.status === "todo" && !row.viewed && !viewedLocally.has(item.id);
  // 临近/过期都在渲染期派生（01§4.15「派生不落库」）；只对待办追讨
  const dueTs = dueText === null ? Number.NaN : wallClockToEpoch(dueText); // 固定 +08:00 解析（D-97）
  const near =
    !row.overdue &&
    item.status === "todo" &&
    !Number.isNaN(dueTs) &&
    dueTs >= Date.now() &&
    dueTs - Date.now() <= NEAR_MS;
  // 行内时间字的红标：ddl 已过就标红（含已完成行——「逾期才完成」也是值得看见的信息）
  const timeOverdue = !Number.isNaN(dueTs) && dueTs < Date.now();
  // 相对人话时间（Todoist 式）：非法日期退回短格式——不编造
  const dueRelative = dueText === null ? null : relativeDueText(dueText, new Date());
  /** 时间字（相对人话或短格式）+ 色调 + 悬停全量：桌面与窄屏两处渲染共用**同一个来源**，
   *  不会各说各话（用户 2026-10-22：桌面端别把到期时间挤掉）。 */
  const dueLabel = dueText === null ? null : (dueRelative ?? fmtShortTime(dueText));
  const dueTone = timeOverdue ? "text-danger" : near ? "text-accent" : "text-ink-muted";
  const dueTitle = dueText === null ? "" : `到期 ${fmtShortTime(dueText)}`;
  // 越临近越强调（用户 2026-09-27 二轮：立方浓淡曲线，lib/urgency 唯一出处）——
  // 7h≈83% / 2d≈22% / 4.5d≈0.1%，临期急剧加深、远期几乎隐形；过期行另有淡红底语义（去框留底），不参与渐变
  const urgency = item.status === "todo" && !row.overdue ? urgencyStrength(dueTs, Date.now()) : 0;
  // 已完成淡出（同款立方曲线）——锚定完成时刻（completedAt）：刚完成最浓，越久淡得越快
  const doneFade =
    item.status === "done" ? doneFadeStrength(row.completedAt ?? row.updatedAt, Date.now()) : 0;
  // 日期未知不再给行描边（走查 2026-10-10 晚：段头已标明「日期未知」，行框反抢注意力——用户要求去掉）
  /** 行背景色：待办临近渐强 / 已完成淡出——全部从主题强调色出（跟色板走）；
   *  封顶同档（TINT_CAP_PERCENT）——「刚完成最亮」由此成立（走查修订 2026-09-30）。 */
  const rowBg = (() => {
    // 逾期淡红底：与 surface 混成**不透明**色——`bg-danger-soft/40` 带 alpha，行本体滑开时
    // 会透出底层手势提示（用户 2026-10-22：「过期的红色背景好像还是透明的」）。
    // ⚠️ 只能用 `--danger`（真变量）套两层 mix：`--danger-soft` 不存在（theme 里只有
    // `--color-danger-soft` 这个给 utility 用的别名），直接 var 它会 invalid → 算成透明。
    if (row.overdue) {
      return "color-mix(in oklab, color-mix(in oklab, var(--danger) 11%, var(--surface)) 40%, var(--surface))";
    }
    if (item.status === "done" && doneFade > 0) {
      return `color-mix(in oklab, var(--accent) ${Math.round(doneFade * TINT_CAP_PERCENT)}%, var(--surface))`;
    }
    if (urgency > 0) {
      return `color-mix(in oklab, var(--accent) ${Math.round(urgency * TINT_CAP_PERCENT)}%, var(--surface))`;
    }
    return undefined;
  })();

  /** 横滑：右滑 = 移入回收站，左滑 = 完成 / 撤销完成（与通知页同一套手势，lib/swipe 唯一实现）。
   *  手势结束仍会来一次 click——用它吞掉，否则滑完会顺手把行展开。 */
  const swipe = useSwipeActions({
    enabled: true,
    ratio: 0.35,
    onSwipe: (dir) => {
      if (dir === "right") onQuickAction(item.id, "trash");
      else onQuickAction(item.id, item.status === "todo" ? "complete" : "reopen");
    },
  });
  /** 行点击：拖动过就只复位、不展开。 */
  const handleRowClick = () => {
    if (swipe.movedRef.current) {
      swipe.movedRef.current = false;
      return;
    }
    onToggle();
  };

  return (
    <li id={`row-${item.id}`} className="group relative overflow-hidden rounded-md">
      {/* 底层动作提示：右滑露出左边「移入回收站」、左滑露出右边「完成 / 撤销完成」。
          提示只做「这一下会发生什么」，不可点——手势是唯一入口（与通知主卡同款）。 */}
      <div
        ref={swipe.revealRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 hidden overflow-hidden rounded-md bg-canvas"
        style={{ opacity: 0.35 }}
      >
        <span
          data-side="left"
          className="absolute left-4 top-1/2 flex -translate-y-1/2 items-center gap-1.5 text-sm font-medium text-ink-muted"
          style={{ visibility: "hidden" }}
        >
          <span className="text-lg leading-none">‹</span>移入回收站
        </span>
        <span
          data-side="right"
          className="absolute right-4 top-1/2 flex -translate-y-1/2 items-center gap-1.5 text-sm font-medium text-ink-muted"
          style={{ visibility: "hidden" }}
        >
          {item.status === "todo" ? "完成" : "撤销完成"}
          <span className="text-lg leading-none">›</span>
        </span>
      </div>
      {/* 行本体：背景/描边/闪示都在它身上，拖动时整体平移 */}
      <div
        ref={swipe.bodyRef}
        {...swipe.handlers}
        className={cn(
          // bg-surface 必须实心：行本体不拖动时是透明的，底层手势提示会「透」到事项文字上
          // （用户 2026-10-22：「又跑上来祸害事项了，会遮挡到」）。拖动后由它遮住提示，只露出滑开的缝。
          "relative z-10 cursor-pointer rounded-md border border-transparent bg-surface py-2 pl-5 pr-3 transition-transform duration-150 hover:bg-canvas",
          // 删除的撤销窗口：边右移边糊掉（时长由下面 style 的 transitionDuration 给，
          // 不从 className 拼——Tailwind 扫不到模板字符串里的类名）
          pendingTrash &&
            "pointer-events-none translate-x-[110%] opacity-0 blur-[3px] transition-all",
          near ? "border-accent/60" : "", // 仅临近 24h 描边（主题强调色系，跟色板走）
          flash && "row-flash",
          active && "bg-canvas ring-1 ring-accent",
        )}
        style={{
          ...(rowBg ? { backgroundColor: rowBg } : {}),
          // 撤销窗口的时长 = 撤销窗口本身：行在这 2 秒里慢慢滑出去糊掉，到点才写库
          ...(pendingTrash ? { transitionDuration: `${UNDO_SECONDS}s` } : {}),
        }}
        onClick={handleRowClick}
      >
        {/* 两行封顶（2026-10-22 二次走查，用户定）：窄屏第一行 = 标题 + 操作按钮，第二行 = ddl / 「新」/ 标签，
          标签**横向滑动**查看（不再换行到第三行）；**没有 meta 的行不渲染第二行**——此前标题 basis-full
          让每行都占两行，没标签时第二行只剩隐形按钮，看起来就是一条空白行。
          DOM 顺序仍是「标题 → meta → 操作」；窄屏只靠 order 把操作提到第一行右端——sm 起 order 归位，
          恢复原单行阅读线（标题 → 相对 ddl → tags → 右缘操作）。 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm font-medium sm:flex-nowrap">
          {/* 标题（+ 左缘推断条）：条挂在标题自己的盒子里、按标题行垂直居中——
            桌面端（单行，行高被 chip 撑高）与窄屏（标题独占一行）都对齐第一行文本。
            条画在标题盒**外面**（-left-3.5），所以截断放在内层 span 上，别让 overflow 剪掉它。 */}
          <span
            className={cn(
              "relative order-1 min-w-0 flex-1 sm:order-none sm:flex-initial",
              item.status === "done" && "text-ink-muted line-through",
            )}
          >
            {row.dueDateInferred && dueNote !== null && (
              <span
                aria-hidden
                className="absolute -left-3.5 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-accent"
                title={`推断：${dueText ?? ""} · 依据：${dueNote}`}
              />
            )}
            <span className="block truncate">{itemName(item.elements)}</span>
          </span>
          {dueLabel !== null && (
            // 桌面端：到期时间独立成一位、**永不压缩**——「不够位置就挤标题和标签，别挤时间」
            // （用户 2026-10-22）。窄屏那一份在下面可滑动的第二行里（sm:hidden / hidden sm:inline 互补）。
            <span
              className={cn("hidden shrink-0 text-xs font-normal sm:inline", dueTone)}
              title={dueTitle}
            >
              {dueLabel}
            </span>
          )}
          {(dueText !== null || isNew || item.tags.length > 0) && (
            // 窄屏 = 可横向滑动的第二行；桌面端 = 紧挨标题的一段标签，
            // **flex-1 basis 0** 让它占满剩余空间：剩余空间为 0 时它先被压到零（标签先让位），
            // 标题此后才截断——「先挤标签，再挤标题」（用户 2026-10-22）。
            <span className="row-meta no-scrollbar order-3 flex w-full min-w-0 items-center gap-x-2 overflow-x-auto pr-1 sm:order-none sm:flex-1 sm:overflow-hidden">
              {dueLabel !== null && (
                // 窄屏这一份留在可滑动的第二行里；桌面那份在 meta **外面**（sm:hidden / hidden sm:inline）
                <span
                  className={cn("shrink-0 text-xs font-normal sm:hidden", dueTone)}
                  title={dueTitle}
                >
                  {dueLabel}
                </span>
              )}
              {isNew && <span className="chip shrink-0 border-accent/50 text-accent">新</span>}
              {item.tags.map((t) => (
                <button
                  key={t}
                  className={cn(
                    "chip shrink-0 cursor-pointer hover:text-accent",
                    // 多模态标签（D-104）：读图得来的内容——高亮区分，一眼可辨（不静默）
                    t === MULTIMODAL_IMAGE_TAG && "border-accent/60 bg-accent/10 text-accent",
                  )}
                  title={
                    t === MULTIMODAL_IMAGE_TAG
                      ? "此事项含读图得来的内容（AI 从图片识别）"
                      : `筛选标签「${t}」`
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onTag(t);
                  }}
                >
                  {t}
                </button>
              ))}
            </span>
          )}
          {/* 快捷动作：窄屏与标题同一行、居右（展开时常驻；非展开靠悬停，触屏由 .row-act 的
            pointer-coarse 兜底常显）。容器钉 h-5（= 文字行高）：钮本身 24/32px 只向外溢出、
            不把这一行撑高——否则标题被居中到「钮的高度」，上下留白就不等了（用户 2026-10-22）。 */}
          <span
            className={cn(
              "order-2 ml-auto flex h-5 shrink-0 items-center gap-1 text-xs font-normal text-ink-muted sm:order-none",
              expanded && "row-actions-open",
            )}
          >
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
                title="恢复待办"
                onClick={(e) => {
                  e.stopPropagation();
                  onQuickAction(item.id, "reopen");
                }}
              >
                <Undo2 size={13} />
              </button>
            )}
            <button
              className="row-act"
              title="删除（进回收站，可恢复）"
              onClick={(e) => {
                e.stopPropagation();
                onQuickAction(item.id, "trash");
              }}
            >
              <Trash2 size={13} />
            </button>
          </span>
        </div>
        {expanded && (
          // 滚动规（用户 2026-09-26 修订）：max-h + 内滚；不做 overscroll 锁——滚到底自然接页面滚动。
          // 框内不放标题/收起按钮（用户 2026-09-27：框外行标题常驻、即收起入口，框内重复属冗余）；
          // 展开体内点击在此掐掉冒泡，否则任何点击都会冒到行上触发收起。
          <div
            className="mt-2 max-h-[70dvh] overflow-y-auto rounded-lg border border-line bg-surface"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-canvas/40">{children}</div>
          </div>
        )}
      </div>
      {pendingTrash && (
        // 撤销钮是**行体的兄弟**：行体在滑出去变糊，这颗钮必须原地不动、也不跟着糊——
        // 这 2 秒里它是唯一该点的东西。
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <UndoButton onClick={onCancelTrash} label="撤销删除" />
        </div>
      )}
    </li>
  );
}

/** 看板段：计数头（**显示条数——随筛选变**）+ 折叠 + 空态一句话（禁愧疚/鸡血措辞）。
 *  total = 段内总条数（不随筛选变），仅用于区分「这段本就空」与「筛选后无匹配」。 */
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
  pendingTrashId,
  onCancelTrash,
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
  /** 正在撤销窗口里的行 id（该行滑出模糊、中央显示撤销钮）。 */
  pendingTrashId: string | null;
  /** 撤销该行的删除。 */
  onCancelTrash: () => void;
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-3">
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
          {rows.length}
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
                  pendingTrash={pendingTrashId === row.item.id}
                  onCancelTrash={onCancelTrash}
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

/** 看板三段（01§4.3；D-89 四段 → 007 三段）+ 行内展开（单开互斥）+ 深链定位；筛选状态在 App 顶栏（FilterBar），
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
  /** 行内快捷动作失败必须可见（红线「不许静默」）。 */
  const [actionError, setActionError] = useState<string | null>(null);
  /** 待提交的删除（撤销窗口内）：行会边右移边糊掉消失，**行中央始终有一颗撤销钮**。
   *  到点才写库——与通知主卡同一套「先给反悔、后落笔」（用户 2026-10-22：不做底部悬浮条）。 */
  const [pendingTrash, setPendingTrash] = useState<string | null>(null);
  const trashTimer = useRef<number | null>(null);
  const pendingTrashRef = useRef<string | null>(null);
  useEffect(() => {
    pendingTrashRef.current = pendingTrash;
  }, [pendingTrash]);
  /** 首次手势提示：滑过一次 / 点过「知道了」即永久收起（本机记忆）。 */
  const [hintVisible, setHintVisible] = useState(() => !loadSwipeHintSeen("board"));
  const [folded, setFolded] = useState<Record<SectionKey, boolean>>(() => ({
    undated: loadSectionFold("undated"),
    scheduled: loadSectionFold("scheduled"),
    done: loadSectionFold("done"),
  }));
  const handledToken = useRef(0);

  /** 筛选谓词：选中的标签 token 全部必须携带（AND 收窄）；查询串对标题与 tags 做包含匹配（D-80）。 */
  /** 筛选谓词：语义单一出处 = FilterBar.matchesFilter（与通知页共用，防两套真相）。 */
  const visible = useCallback((r: ItemRow): boolean => matchesFilter(r.item, filter), [filter]);

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
  /** 清掉撤销计时器。 */
  const clearTrashTimer = () => {
    if (trashTimer.current !== null) {
      window.clearTimeout(trashTimer.current);
      trashTimer.current = null;
    }
  };

  /** 真正删掉（写库 → 刷新）。失败如实说，行留在原地。 */
  const commitTrash = (id: string) => {
    clearTrashTimer();
    setPendingTrash(null);
    void api
      .trash(id)
      .then(() => {
        setActionError(null);
        setExpandedId(null);
        onRefresh();
      })
      .catch(() => {
        setActionError("删除失败——这条还在，请稍后重试");
        onRefresh();
      });
  };

  /** 开始撤销窗口：先把上一个待删的提交掉（同时只能有一条在飞）。 */
  const startTrash = (id: string) => {
    const prev = pendingTrashRef.current;
    if (prev !== null && prev !== id) commitTrash(prev);
    clearTrashTimer();
    setPendingTrash(id);
    trashTimer.current = window.setTimeout(() => commitTrash(id), UNDO_SECONDS * 1000);
  };

  /** 撤销：清计时器、行复原，一个字节都不写库。 */
  const cancelTrash = useCallback(() => {
    if (trashTimer.current !== null) {
      window.clearTimeout(trashTimer.current);
      trashTimer.current = null;
    }
    setPendingTrash(null);
  }, []);

  /** Esc 只撤退撤销窗口，不惊动页面层。 */
  const trashPending = pendingTrash !== null;
  useEffect(() => {
    if (!trashPending) return;
    return pushEscLayer(cancelTrash);
  }, [trashPending, cancelTrash]);

  /** 卸载（离开看板/切视图）时：未到点的删除**立即提交**——意图已表达，不静默丢弃。 */
  useEffect(() => {
    return () => {
      clearTrashTimer();
      const id = pendingTrashRef.current;
      if (id !== null) void api.trash(id).catch(() => undefined);
    };
  }, []);

  /** 行内快捷动作：完成/撤销完成立刻写库；**删除先进撤销窗口**（不立刻落笔）。 */
  const quickAction = (id: string, action: RowAction) => {
    // 用过一次（图标或手势）就不再需要手势提示
    markSwipeHintSeen("board");
    setHintVisible(false);
    // 删除不立刻落笔：进撤销窗口，行滑出糊掉、中央那颗撤回钮还能救回来
    if (action === "trash") {
      startTrash(id);
      return;
    }
    void (action === "complete" ? api.complete(id) : api.reopen(id))
      .then(() => {
        setActionError(null);
        setExpandedId(null);
        onRefresh();
      })
      .catch(() => {
        // 失败必须可见（红线「不许静默」）：否则用户分不清「没点中」与「删失败了」
        setActionError("操作失败——状态没有改变，请稍后重试");
        onRefresh();
      });
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
      <main className="page-x py-4">
        <div className="card text-sm text-ink-muted">
          还没有任何事项。有新信息随时丢进来，agent0 会自己理成事项。
        </div>
      </main>
    );
  }

  return (
    <main className="page-x space-y-4 py-4">
      {hintVisible && (
        <GestureHint
          text="右滑移入回收站 · 左滑完成（已完成的行左滑是撤销完成）"
          onDismiss={() => {
            markSwipeHintSeen("board");
            setHintVisible(false);
          }}
        />
      )}
      {actionError !== null && (
        <p className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
          {actionError}
        </p>
      )}
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
          pendingTrashId={pendingTrash}
          onCancelTrash={cancelTrash}
        />
      ))}
    </main>
  );
}
