import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
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
import { Pagination } from "./Pagination";
import { UndoButton } from "./UndoButton";
import { doneFadeStrength, TINT_CAP_PERCENT, urgencyStrength } from "../lib/urgency";
import { fmtShortTime } from "../lib/time";
import { matchesFilter, type BoardFilter } from "./FilterBar";
import { api } from "../api";
import { ItemBody } from "./board/ItemBody";

type RowAction = "complete" | "reopen" | "trash";

// 三段元数据唯一出处（D-80；D-89 存疑段退场；007 取消归档后三段）——段名/提示/空态只改这里，派生物（allRows/段定位/计数）全部由此推导
type SectionKey = "undated" | "scheduled" | "done";
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
 *  同一条阅读线内联（不用视线右缘远跳）；ddl 颜色编码（过期红/临近 accent/远灰），悬停给绝对时间。
 *  行操作只有手势（右滑删除、左滑完成/撤销），行右缘不再放按钮（用户 2026-10-22）。
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

  /** 松手时的位移与速度（px / px·ms⁻¹）：撤销窗口的动画从这儿接着走，不重新起步。 */
  const releaseRef = useRef({
    dx: 0,
    velocity: 0,
  }); /** 横滑：右滑 = 移入回收站，左滑 = 完成 / 撤销完成（与通知页同一套手势，lib/swipe 唯一实现）。
   *  **展开态不接手势**（用户 2026-10-23）：展开体里有可交互内容（引文、按钮、图片、可选中文字），
   *  横滑会把指针抢走，交互就废了。比「再加一个锁钮」简洁——展开本来就是「我要读它」的状态，
   *  这一态下不需要滑动手势；收起即恢复。
   *  手势结束仍会来一次 click——用它吞掉，否则滑完会顺手把行展开。 */
  const swipe = useSwipeActions({
    enabled: !expanded && !pendingTrash,
    ratio: 0.35,
    onSwipe: (dir, info) => {
      releaseRef.current = info;
      if (dir === "right") onQuickAction(item.id, "trash");
      else onQuickAction(item.id, item.status === "todo" ? "complete" : "reopen");
    },
  });
  /** 撤销窗口的滑出动画：**接管松手速度**，再加速甩出去。
   *  时长 = 剩余距离 ÷ 释放速度，缓动取初斜率恰为 1 的曲线（`cubic-bezier(.5,.5,1,1)`）——
   *  于是起手速度正好等于松手速度（不突变），之后一路加速，读起来是「顺着你的劲儿甩出去」。 */
  useEffect(() => {
    if (!pendingTrash) return;
    const el = swipe.bodyRef.current;
    if (el === null) return;
    const width = el.clientWidth > 0 ? el.clientWidth : 360;
    const startX = releaseRef.current.dx;
    const target = width * 1.1;
    // 慢速松手也要有个底速，否则会「贴着屏幕慢慢挪」；快甩则封顶最短时长
    const speed = Math.max(Math.abs(releaseRef.current.velocity), 0.35);
    const duration = Math.min(900, Math.max(160, (target - startX) / speed));
    const anim = el.animate(
      [
        { transform: `translateX(${startX}px)`, opacity: 1, filter: "blur(0px)" },
        { transform: `translateX(${target}px)`, opacity: 0, filter: "blur(3px)" },
      ],
      { duration, easing: "cubic-bezier(0.5, 0.5, 1, 1)", fill: "forwards" },
    );
    // 取消是正常路径（撤销/卸载）：吞掉 finished 的 rejection，别让它变成未处理异常
    void anim.finished.catch(() => undefined);
    // 位移交给动画，内联值清掉——撤销时才能从动画停下的位置干净滑回
    el.style.transform = "";
    return () => {
      const from = getComputedStyle(el).transform;
      anim.cancel();
      // 撤销：从当前位置滑回原处（不硬切）
      const back = el.animate(
        [
          { transform: from, opacity: 0, filter: "blur(3px)" },
          { transform: "translateX(0px)", opacity: 1, filter: "blur(0px)" },
        ],
        { duration: 180, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
      );
      void back.finished.catch(() => undefined);
    };
  }, [pendingTrash, swipe.bodyRef]);
  /** 行点击：拖动过就只复位、不展开。 */
  const handleRowClick = () => {
    if (swipe.movedRef.current) {
      swipe.movedRef.current = false;
      return;
    }
    onToggle();
  };

  return (
    <li id={`row-${item.id}`} className="relative overflow-hidden rounded-md">
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
          "relative z-10 cursor-pointer rounded-md border border-transparent bg-surface py-2 pl-5 pr-3 transition-all duration-150 hover:bg-canvas",
          // 删除的撤销窗口：滑出/淡出/变糊都由上面那段 Web Animations 接管（速度从松手处接），
          // 这里只负责「这 2 秒里别再点它」
          pendingTrash && "pointer-events-none",
          near ? "border-accent/60" : "", // 仅临近 24h 描边（主题强调色系，跟色板走）
          flash && "row-flash",
          active && "bg-canvas ring-1 ring-accent",
        )}
        style={rowBg ? { backgroundColor: rowBg } : undefined}
        onClick={handleRowClick}
      >
        {/* 两行封顶（2026-10-22 二次走查，用户定）：窄屏第一行 = 标题独占整行，第二行 = ddl / 「新」/ 标签；
          **没有 meta 的行不渲染第二行**（此前标题 basis-full 让每行都占两行，没标签时第二行只剩空白）。
          sm 起单行阅读线：标题 → 相对 ddl → tags。 */}
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
            <span
              className={cn(
                "row-meta no-scrollbar order-3 flex w-full min-w-0 items-center gap-x-2 pr-1 sm:order-none sm:flex-1 sm:overflow-hidden",
                // 收起态：标签条不滑动——横向手势要能穿过标签落到整行的拖动删除上（用户 2026-10-22）；
                // 展开态：标签条自己横向滑动查看
                expanded ? "overflow-x-auto" : "overflow-hidden",
              )}
              // 收起态下标签本身是按钮（起手会跳开手势）；这层标记让横拖穿过它归整行。
              // 展开态反过来：整个标签条标记成「自己的」，横拖归标签横滑、不拖动行。
              data-swipe-through={expanded ? undefined : ""}
              data-swipe-own={expanded ? "" : undefined}
            >
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
                    // 收起行里横拖是从标签上起手的（data-swipe-through）：拖完松手不该顺带筛选
                    if (swipe.movedRef.current) {
                      swipe.movedRef.current = false;
                      return;
                    }
                    onTag(t);
                  }}
                >
                  {t}
                </button>
              ))}
            </span>
          )}
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
          <UndoButton onClick={onCancelTrash} label="撤销删除" fadeSeconds={UNDO_SECONDS} />
        </div>
      )}
    </li>
  );
}

/** 看板段：计数头（**显示条数——随筛选变**）+ 折叠 + 空态一句话（禁愧疚/鸡血措辞）。
 *  total = 段内总条数（不随筛选变），仅用于区分「这段本就空」与「筛选后无匹配」。
 *  `footer` = 段尾的附加内容（分页控件；已完成段用）。 */
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
  footer,
  count,
  note,
  loading,
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
  /** 段尾附加内容（已完成段的分页控件）。缺席 = 没有。 */
  footer?: ReactNode;
  /** 段头计数（默认 = 当前展示的行数）。分页段传「本页 / 全部」式文案。 */
  count?: string;
  /** 段头下方的一句补充（分页段的「筛选只作用于本页」说明）。 */
  note?: string;
  /** 本段「有数据但这次没取行」——刚从折叠展开、还没拿到行的那一帧（或取行失败）。
   *  这时说「无匹配当前筛选」是假话（筛选框可能是空的）。 */
  loading?: boolean;
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
          {count ?? rows.length}
        </span>
      </button>
      {!folded && (
        <>
          {hint !== undefined && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
          {note !== undefined && <p className="mt-1 text-xs text-ink-muted">{note}</p>}
          {rows.length === 0 ? (
            <p className="mt-2 text-xs text-ink-muted">
              {/* 三种「没有行」必须分开说，否则会说错话：
                  ①总数为 0 = 这段本来就空；②有行但被筛掉 = 无匹配；
                  ③**有数据但本次没取行**（分页段折叠→展开的这一帧，或取行失败）——既不是空也不是无匹配。 */}
              {total === 0 ? emptyText : loading ? "正在载入…" : "无匹配当前筛选"}
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
          {footer}
        </>
      )}
    </section>
  );
}

/** 看板三段（01§4.3；D-89 四段 → 007 三段）+ 行内展开（单开互斥）+ 深链定位；筛选状态在 App 顶栏（FilterBar），
 *  这里只按 filter prop 过滤。
 *
 *  **「已完成」段的折叠与页码归 App**（2026-10-27）：折叠要发到服务端（`folded=1` = 一个 done 行都不查），
 *  页码要随请求走。Board 只负责渲染与把点击转出去——自己不记 done 的折叠，
 *  否则「看着折叠、其实每次都在拉」这类两套真相就出来了。
 *  日期未知 / 已排期的折叠仍是本机偏好，留在这里。 */
export function Board({
  board,
  onRefresh,
  onDonePage,
  onDoneFold,
  doneFolded,
  focus,
  filter,
  onTagClick,
}: {
  board: BoardView;
  /** 重拉看板（不传参 = 沿用当前页与折叠态）。 */
  onRefresh: () => void;
  /** 已完成段翻页。 */
  onDonePage: (page: number) => void;
  /** 切已完成段折叠（App 落偏好 + 重拉）。 */
  onDoneFold: (folded: boolean) => void;
  /** 已完成段当前是否折叠（App 持）——**与下发给服务端的 `folded` 是同一个值**。 */
  doneFolded: boolean;
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
  /** 日期未知 / 已排期的折叠（本机偏好）。**已完成段不在这里**——它归 App（见组件注释）。 */
  const [folded, setFolded] = useState<{ undated: boolean; scheduled: boolean }>(() => ({
    undated: loadSectionFold("undated"),
    scheduled: loadSectionFold("scheduled"),
  }));
  /** 任一折叠态（含 App 持的 done）——键盘导航与「展开行是否可见」判定共用。 */
  const foldedOf = useCallback(
    (key: SectionKey): boolean => (key === "done" ? doneFolded : folded[key]),
    [folded, doneFolded],
  );
  const handledToken = useRef(0);
  /** 深链待命：目标行还没到手（已完成折叠/不在本页）时记下 id，行到了再展开（见深链 effect）。 */
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);

  /** 筛选谓词：选中的标签 token 全部必须携带（AND 收窄）；查询串对标题与 tags 做包含匹配（D-80）。 */
  /** 筛选谓词：语义单一出处 = FilterBar.matchesFilter（与通知页共用，防两套真相）。 */
  const visible = useCallback((r: ItemRow): boolean => matchesFilter(r.item, filter), [filter]);

  const allRows = useMemo(() => SECTION_META.flatMap((m) => board[m.key]), [board]);

  /** 事项 id → 所在段 key（键盘导航与「展开行是否可见」判定共用）——段名集合从 SECTION_META
   *  派生（唯一出处），拼错段名无处可写。
   *
   *  ⚠️ 只覆盖**手上真有行**的那些段：已完成折叠时 `board.done` 是空的，这里就查不到 id。
   *  深链因此不能只靠这张表判断「目标在不在已完成」——见下面 `mentionableSection`。 */
  const sectionKeyById = useMemo(() => {
    const m = new Map<string, SectionKey>();
    for (const meta of SECTION_META) {
      for (const r of board[meta.key]) m.set(r.item.id, meta.key);
    }
    return m;
  }, [board]);

  /** 目标 id 落在哪一段（深链用，**不受分页/折叠影响**）。
   *
   *  为什么不能用 `sectionKeyById`：已完成折叠时里面根本没有 done 行（服务端没查），
   *  拿它判「key === "done"」永远不成立 → 展开分支不可达 → 点 chip 完全没反应（review 逮出）。
   *  服务端的 `mentionables` 是全量清单（非回收站），命中即说明「这条存在、但手上没有它的行」；
   *  这时展开已完成段让服务端补查。 */
  const mentionableIds = useMemo(() => new Set(board.mentionables.map((m) => m.id)), [board]);

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
      key === undefined || foldedOf(key) || !visibleRows.some((r) => r.item.id === expandedId);
    if (hidden) setExpandedId(null);
    // foldedOf 是纯函数（读 props 与 state）；依赖列全它的两个来源
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedId, sectionKeyById, folded, doneFolded, visibleRows]);

  /** 滚到某一行（深链与待命深链共用；两帧后坐标才对——展开体与段展开都会改变布局）。 */
  const scrollToRow = useCallback((id: string): void => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document
          .getElementById(`row-${id}`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }),
    );
  }, []);

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
        return key === undefined ? true : !foldedOf(key);
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

  /** 切换折叠：日期未知/已排期是本机偏好（这里写）；已完成归 App（要连带重拉），转出去。 */
  const toggleFold = (key: SectionKey) => {
    if (key === "done") {
      onDoneFold(!doneFolded);
      return;
    }
    const next = !folded[key];
    setFolded({ ...folded, [key]: next });
    saveSectionFold(key, next);
  };

  /** 展开切换：单开互斥——展开 B 自动收起 A（D-80 手风琴）。 */
  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

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
    // 钮暗到底就是提交时刻（没有额外停留）
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

  /** 手势动作：完成/撤销完成立刻写库；**删除先进撤销窗口**（不立刻落笔）。 */
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
   *  token 防同一条深链被看板轮询重放。
   *
   *  ⚠️ 已完成段**分页且默认折叠**：目标行多半不在手上（折叠时服务端一个 done 行都不查）。
   *  这时不能直接 `setExpandedId`——「展开行不可见就收起」的判定会立刻把它清掉，
   *  点 chip 就成了完全没反应（review 逮出）。改为**记一条待命**（`pendingFocus`）：
   *  先去要行（展开已完成段 → App 重拉），行到手后由下面那段 effect 接着展开并滚动。
   *
   *  ⚠️ 即使用户展开着，目标也可能在别的页——那属于「翻页才看得到」，这里不替用户翻页猜位置
   *  （猜错同样是「点了没反应」，而且会把用户从正在读的那页拽走）。 */
  useEffect(() => {
    if (focus === null || focus.token === handledToken.current) return;
    handledToken.current = focus.token;
    const key = sectionKeyById.get(focus.id) ?? null;
    if (key === null && mentionableIds.has(focus.id)) {
      // 这条存在，但手上没有它的行（已完成折叠 / 不在本页 / 未取行）→ 先去要行
      setPendingFocus(focus.id);
      if (doneFolded) onDoneFold(false);
      return;
    }
    setPendingFocus(null);
    setExpandedId(focus.id);
    if (key !== null) {
      setFolded((f) => ({ ...f, [key]: false }));
      saveSectionFold(key, false);
    }
    setFlashId(focus.id);
    scrollToRow(focus.id);
  }, [focus, board, sectionKeyById, mentionableIds, doneFolded, onDoneFold, scrollToRow]);

  /** 待命深链：目标行到手就展开、高亮、滚过去（上面那段 effect 把 id 交过来）。 */
  useEffect(() => {
    if (pendingFocus === null) return;
    if (!sectionKeyById.has(pendingFocus)) return; // 还没到（重拉在路上）
    setExpandedId(pendingFocus);
    setFlashId(pendingFocus);
    setPendingFocus(null);
    scrollToRow(pendingFocus);
  }, [pendingFocus, sectionKeyById, scrollToRow]);

  // 「新」/flash 微标的消退计时独立成 effect：不随深链 effect 因轮询重跑而被 cleanup 误清
  useEffect(() => {
    if (flashId === null) return;
    const t = window.setTimeout(() => setFlashId(null), 2000);
    return () => window.clearTimeout(t);
  }, [flashId]);

  if (allRows.length === 0 && board.doneMeta.total === 0) {
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
          title="这一页可以左右滑"
          lines={[
            "向右滑：移入回收站（2 秒内可撤销）",
            "向左滑：标完成；已完成的行向左滑是撤销完成",
            "点一行：展开详情",
          ]}
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
      {sections.map((s) => {
        const rows = s.rows.filter(visible);
        // 已完成段：条数取 `doneMeta.total`（全量），不是本页行数——段头要回答「一共完成过多少」。
        // 折叠时本页行是空的（服务端没查），段头照样要点得出数。
        const meta = s.key === "done" ? board.doneMeta : null;
        return (
          <Section
            key={s.key}
            title={s.title}
            rows={rows}
            // 本页筛选后的行数 vs 本页全部行数（`total` 另作「这段一共多少」用于空态判定）
            total={meta?.total ?? s.rows.length}
            // 段头计数：非分页段 = 筛选后行数（随筛选变）；分页段 = **全量总数**（跨页可比，
            // 且折叠时也点得出数）。两种口径都写在这儿，避免同屏两套数字说不清。
            count={meta !== null ? String(meta.total) : undefined}
            hint={s.hint}
            // 分页段：筛选只作用于当前这一页。**有多页就说明**（不只在筛出空结果时）——
            // 否则「你看到的不是全部」这件事实在正常阅读时完全不可见。
            note={
              meta !== null && meta.pageCount > 1
                ? "已完成每页 20 条；筛选只作用于本页，更早的请翻页"
                : undefined
            }
            emptyText={s.emptyText}
            folded={foldedOf(s.key)}
            // 「有数据但这次没取行」：刚展开还没拿到 payload（此时 payload 仍是折叠态那份），
            // 或取行失败。这一帧说「无匹配」是假话——列单为 0 只是因为没查。
            // 「有数据但这次没取行」：段已展开、总数 > 0、但手上的行是空的。
            // 两个来源都能造成这一帧：刚点开段头（载荷还是折叠那份），或取行失败。
            // ⚠️ 判据看**界面的折叠态**（`foldedOf`），不是载荷里的 `meta.folded`——
            // 后者滞后一帧，正是要靠它区分的那一帧。
            loading={!foldedOf(s.key) && meta !== null && meta.total > 0 && s.rows.length === 0}
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
            footer={
              meta !== null && !meta.folded ? (
                <Pagination meta={meta} onPage={onDonePage} />
              ) : undefined
            }
          />
        );
      })}
    </main>
  );
}
