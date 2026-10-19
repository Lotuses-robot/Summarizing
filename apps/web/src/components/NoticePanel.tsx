import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { itemName, type NoticeRow } from "@summarizing/shared";
import { api } from "../api";
import { cn } from "../lib/cn";
import { pushEscLayer } from "../lib/escLayer";
import { ItemBody } from "./board/ItemBody";
import { fmtFullTime, fmtShortTime } from "../lib/time";

// 通知页（007 / D-108 阅读器形态）：主卡固定展示当前通知的完整内容（复用 ItemBody），
// 下方列表只做索引与选择。手势：向左拖 = 稍后（本次跳过，不写库）、向右拖 = 清除
// （进回收站、可撤销）。常驻的左右缘提示同时也是点击兜底（鼠标用户无需拖）。
// 自动选择：进入 / 筛选变化 / 清除 / 稍后之后，选下一条未跳过的；轮询不抢焦点。

/** 拖动阈值：卡片宽度的 35%。 */
const SWIPE_RATIO = 0.35;
/** 清除的撤销窗口（秒）。 */
const UNDO_SECONDS = 3;

/** 环形倒计时：细环随剩余秒数消退，数字居中（用户 2026-10-19 定的样式）。 */
function CountdownRing({ remaining, total }: { remaining: number; total: number }) {
  const R = 22;
  const C = 2 * Math.PI * R;
  const progress = Math.max(0, Math.min(1, remaining / total));
  return (
    <div className="relative h-16 w-16">
      <svg viewBox="0 0 56 56" className="h-16 w-16 -rotate-90">
        <circle cx="28" cy="28" r={R} fill="none" strokeWidth="2" className="stroke-line" />
        <circle
          cx="28"
          cy="28"
          r={R}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - progress)}
          className="stroke-accent transition-[stroke-dashoffset] duration-1000 ease-linear"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-lg font-medium tabular-nums text-ink">
        {remaining}
      </span>
    </div>
  );
}

/** 通知页：主卡阅读器 + 下方列表（D-108）。 */
export function NoticePanel({
  notices,
  filter,
  onRefresh,
  focus = null,
}: {
  notices: NoticeRow[];
  /** 与看板同款筛选谓词（tag + 文本——FilterBar 复用，不另造机制）。 */
  filter: (r: NoticeRow) => boolean;
  onRefresh: () => void;
  /** 对话 chips 深链（05§三）：选中该条；token 防轮询重放。 */
  focus?: { id: string; token: number } | null;
}) {
  const visible = notices.filter(filter);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 本次「稍后」集合：不落库、离开页面即忘（用户 2026-10-19：「放在那里不管」）。 */
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  /** 本地已读：id → 标记时的 updatedAt（同一次更新内抑制重复上报）。 */
  const [viewedLocally, setViewedLocally] = useState<ReadonlyMap<string, string>>(new Map());
  /** 清除倒计时（延迟提交：到 0 才真正写库，撤回则什么都没发生）。 */
  const [pending, setPending] = useState<{ id: string; title: string; remaining: number } | null>(
    null,
  );
  /** 删除/撤销失败必须可见（红线「不许静默」）。 */
  const [actionError, setActionError] = useState<string | null>(null);
  /** 拖动位移（px）：正 = 向右（清除），负 = 向左（稍后）。 */
  const [drag, setDrag] = useState<{ dx: number } | null>(null);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; width: number } | null>(null);
  const pendingRef = useRef<typeof pending>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  /** 当前选中行（不在可见集里则 null）。 */
  const selected = visible.find((r) => r.item.id === selectedId) ?? null;
  const selectedIndex = selected === null ? -1 : visible.indexOf(selected);
  /** 下一条未跳过的候选（从当前条之后找；没有则 null）。 */
  const nextUnskippedAfter = useCallback(
    (id: string | null): NoticeRow | null => {
      const start = id === null ? -1 : visible.findIndex((r) => r.item.id === id);
      for (let i = start + 1; i < visible.length; i++) {
        const r = visible[i];
        if (r && !skipped.has(r.item.id)) return r;
      }
      return null;
    },
    [visible, skipped],
  );

  /** 选中并标已读（自动选中/点列表/深链共用；同一次更新内只报一次）。 */
  const select = useCallback(
    (row: NoticeRow) => {
      setSelectedId(row.item.id);
      if (row.viewed || viewedLocally.get(row.item.id) === row.updatedAt) return;
      setViewedLocally((cur) => new Map(cur).set(row.item.id, row.updatedAt));
      void api.viewed(row.item.id).catch(() => {
        // 上报失败：撤掉本地标记，再次选中时可重试（徽标不会永久卡住）
        setViewedLocally((cur) => {
          const copy = new Map(cur);
          copy.delete(row.item.id);
          return copy;
        });
      });
    },
    [viewedLocally],
  );

  // 自动选择：当前选中不在可见集里（进入/筛选变化/被清掉）→ 选第一条未跳过的。
  // 轮询只替换数组内容，选中项仍在就保持不动（不抢焦点）。
  const visibleKey = visible.map((r) => r.item.id).join(",");
  useEffect(() => {
    setSelectedId((cur) => {
      if (cur !== null && visible.some((r) => r.item.id === cur)) return cur;
      return visible.find((r) => !skipped.has(r.item.id))?.item.id ?? null;
    });
    // visibleKey 表达「可见集变化」；skipped 变化不算（由 skip/清除路径自己推进）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);

  // 选中即已读——但**只在"选中的那条发生变化"时**标：轮询把同一条内容更新后应亮「新」
  // （OQ-11：更新后重新标未读），不能被每轮刷新立刻又标回已读。
  const selectRef = useRef(select);
  useEffect(() => {
    selectRef.current = select;
  }, [select]);
  const noticesRef = useRef(notices);
  useEffect(() => {
    noticesRef.current = notices;
  }, [notices]);
  const lastMarked = useRef<string | null>(null);
  useEffect(() => {
    if (selectedId === null) {
      lastMarked.current = null;
      return;
    }
    if (lastMarked.current === selectedId) return;
    const row = noticesRef.current.find((r) => r.item.id === selectedId);
    if (row === undefined) return;
    lastMarked.current = selectedId;
    selectRef.current(row);
  }, [selectedId]);

  // 深链：选中目标（token 防轮询重放）
  const handledToken = useRef(0);
  useEffect(() => {
    if (focus === null || focus.token === handledToken.current) return;
    handledToken.current = focus.token;
    const row = notices.find((r) => r.item.id === focus.id);
    if (row) select(row);
  }, [focus, notices, select]);

  /** 真正提交清除：写库 → 刷新 → 选下一条。失败则如实报错，条目保留。 */
  const commitDelete = useCallback(
    (id: string) => {
      const next = nextUnskippedAfter(id);
      void api
        .trash(id)
        .then(() => {
          setActionError(null);
          setPending(null);
          setSelectedId(next?.item.id ?? null);
          onRefresh();
        })
        .catch(() => {
          setPending(null);
          setActionError("清除失败——这条还在，请稍后重试");
          onRefresh();
        });
    },
    [nextUnskippedAfter, onRefresh],
  );
  /** 计时器回调取最新 commitDelete（渲染期间闭包会过期）。 */
  const commitRef = useRef(commitDelete);
  useEffect(() => {
    commitRef.current = commitDelete;
  }, [commitDelete]);

  /** 倒计时 interval（用 ref 持有——避免每次渲染重置、也避免 effect 依赖抖动）。 */
  const timerRef = useRef<number | null>(null);
  /** 取消撤销窗口（撤回按钮 / Esc）。 */
  const cancelDelete = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setPending(null);
    setActionError(null);
  }, []);

  /** 撤销窗口的 Esc 层：只取消本次清除，不连带弹走页面（按「是否有待删」注册，避免每秒重注册）。 */
  const hasPending = pending !== null;
  useEffect(() => {
    if (!hasPending) return;
    return pushEscLayer(cancelDelete);
  }, [hasPending, cancelDelete]);

  /** 组件卸载（离开通知页）时：清计时器；未到点的清除**立即提交**——意图已表达，不静默丢弃。 */
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      const p = pendingRef.current;
      if (p !== null) void api.trash(p.id).catch(() => undefined);
    };
  }, []);

  /** 稍后：进本次跳过集合，选下一条未跳过的。 */
  const skip = useCallback(
    (row: NoticeRow) => {
      const next = nextUnskippedAfter(row.item.id);
      setSkipped((cur) => new Set(cur).add(row.item.id));
      setSelectedId(next?.item.id ?? null);
    },
    [nextUnskippedAfter],
  );

  /** 开始清除：进入模糊 + 环形倒计时（延迟提交，可撤回）。 */
  const startDelete = useCallback((row: NoticeRow) => {
    setActionError(null);
    setPending({ id: row.item.id, title: itemName(row.item.elements), remaining: UNDO_SECONDS });
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    let remaining: number = UNDO_SECONDS;
    timerRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        if (timerRef.current !== null) {
          window.clearInterval(timerRef.current);
          timerRef.current = null;
        }
        commitRef.current(row.item.id);
      } else {
        setPending((cur) => (cur === null ? cur : { ...cur, remaining }));
      }
    }, 1000);
  }, []);

  // ── 拖动 ──
  /** 按下：记录起点与卡宽；交互元素上不启动拖动（点证据/链接/按钮要正常）。 */
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pending !== null) return;
    if (selected === null) return;
    // 交互元素上的按下不启动拖动（点证据/链接/按钮要正常工作）
    if ((e.target as HTMLElement).closest("button,a,summary,input,textarea,select")) return;
    dragRef.current = { startX: e.clientX, width: cardRef.current?.clientWidth ?? 320 };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ dx: 0 });
  };
  /** 移动：位移限制在 ±60% 卡宽内（越界回弹由阈值逻辑兜住）。 */
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d === null) return;
    const limit = d.width * 0.6;
    const dx = Math.max(-limit, Math.min(limit, e.clientX - d.startX));
    setDrag({ dx });
  };
  /** 松开：过阈值即执行（右=清除、左=稍后），否则回弹。 */
  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d === null || selected === null) {
      setDrag(null);
      return;
    }
    const dx = drag?.dx ?? 0;
    const threshold = d.width * SWIPE_RATIO;
    if (dx >= threshold)
      startDelete(selected); // 向右拖 = 清除
    else if (dx <= -threshold) skip(selected); // 向左拖 = 稍后
    setDrag(null);
  };

  const dragDx = drag?.dx ?? 0;
  const thresholdNow = (cardRef.current?.clientWidth ?? 320) * SWIPE_RATIO;
  const dragStrength = Math.min(1, Math.abs(dragDx) / Math.max(1, thresholdNow));

  const emptyCardText =
    notices.length === 0
      ? "还没有通知——群里发来的、不用你去做但值得知道的事会落到这"
      : visible.length === 0
        ? "没有匹配的通知"
        : "这一轮没有待看的通知";

  return (
    <div className="px-4 py-3">
      {actionError !== null && (
        <p className="mb-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
          {actionError}
        </p>
      )}

      {/* 主卡：固定（列表滚动时不动）；内容超出在卡内滚动 */}
      <div className="sticky top-0 z-10 -mx-1 bg-canvas px-1 pb-3">
        <div ref={cardRef} className="relative">
          {/* 底层：低一层的画布色 + 方向箭头 + 垂直居中的动作词（拖动时露出） */}
          {drag !== null && dragDx !== 0 && (
            <div
              aria-hidden
              className="absolute inset-0 flex items-center justify-between overflow-hidden rounded-lg bg-canvas px-4 text-sm text-ink-muted"
              style={{ opacity: 0.4 + dragStrength * 0.6 }}
            >
              {dragDx > 0 ? (
                <span className="flex items-center gap-1 font-medium">{">>>"} 清除</span>
              ) : (
                <span className="flex-1" />
              )}
              {dragDx < 0 ? (
                <span className="flex items-center gap-1 font-medium">稍后 {"<<<"}</span>
              ) : null}
            </div>
          )}

          {/* 卡片本体 */}
          <div
            className={cn(
              // touch-pan-y：纵向滚动照常，横向拖动归我们处理（手机端）
              "relative z-10 touch-pan-y rounded-lg border border-line bg-surface transition-transform",
              drag === null && "duration-150",
            )}
            style={{ transform: dragDx === 0 ? undefined : `translateX(${dragDx}px)` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {/* 左右缘垂直居中的常驻提示（同时是点击兜底） */}
            {selected !== null && pending === null && (
              <>
                <button
                  className="absolute left-1 top-1/2 z-10 -translate-y-1/2 cursor-pointer rounded px-1.5 py-1 text-xs text-ink-muted/40 hover:bg-canvas hover:text-ink-muted"
                  title="稍后（本次跳过；也可向左拖动卡片）"
                  onClick={() => skip(selected)}
                >
                  ‹ 稍后
                </button>
                <button
                  className="absolute right-1 top-1/2 z-10 -translate-y-1/2 cursor-pointer rounded px-1.5 py-1 text-xs text-ink-muted/40 hover:bg-canvas hover:text-ink-muted"
                  title="清除（进回收站，可撤销；也可向右拖动卡片）"
                  onClick={() => startDelete(selected)}
                >
                  清除 ›
                </button>
              </>
            )}

            {selected !== null ? (
              <div>
                {/* 头部：来源 / 时间 / 未读 / 进度 */}
                <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs text-ink-muted">
                  {selected.sourceLabel !== null && (
                    <span className="chip">{selected.sourceLabel}</span>
                  )}
                  <span title={`更新于 ${fmtFullTime(selected.updatedAt)}`}>
                    {fmtShortTime(selected.updatedAt)}
                  </span>
                  {!selected.viewed &&
                    viewedLocally.get(selected.item.id) !== selected.updatedAt && (
                      <span className="chip border-accent/50 text-accent">新</span>
                    )}
                  {selected.item.tags.map((t) => (
                    <span key={t} className="chip">
                      {t}
                    </span>
                  ))}
                  <span className="ml-auto tabular-nums">
                    {selectedIndex + 1}/{visible.length}
                  </span>
                </div>
                {/* 标题：语义名（ItemBody 不渲染 name——看板行才渲染，这里由主卡承担 H1） */}
                <h2 className="px-4 pt-3 text-base font-semibold">
                  {itemName(selected.item.elements)}
                </h2>
                {/* 内容：复用事项展开体（元素/证据/来源信息一整套） */}
                <div className="max-h-[60vh] overflow-y-auto">
                  <ItemBody id={selected.item.id} />
                </div>
              </div>
            ) : (
              <p className="px-4 py-10 text-sm text-ink-muted">{emptyCardText}</p>
            )}

            {/* 清除的撤销窗口：模糊卡片 + 环形倒计时 + 撤回 */}
            {pending !== null && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-lg bg-surface/40 backdrop-blur-md">
                <p className="text-sm font-medium text-ink">已清除</p>
                <CountdownRing remaining={pending.remaining} total={UNDO_SECONDS} />
                <button className="btn" onClick={cancelDelete}>
                  撤 回
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 下方列表：只做索引与选择 */}
      {visible.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {visible.map((r) => {
            const isSelected = r.item.id === selectedId;
            const unread =
              !r.viewed && viewedLocally.get(r.item.id) !== r.updatedAt && !skipped.has(r.item.id);
            return (
              <li key={r.item.id}>
                <button
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-md border border-transparent px-3 py-1.5 text-left text-sm hover:bg-canvas",
                    isSelected && "border-line bg-canvas",
                  )}
                  onClick={() => select(r)}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      unread ? "bg-accent" : "bg-line",
                    )}
                    aria-hidden
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      skipped.has(r.item.id) && "text-ink-muted",
                    )}
                  >
                    {itemName(r.item.elements)}
                  </span>
                  {skipped.has(r.item.id) && <span className="chip shrink-0">稍后</span>}
                  {r.sourceLabel !== null && (
                    <span className="chip shrink-0 text-ink-muted">{r.sourceLabel}</span>
                  )}
                  <span
                    className="shrink-0 text-xs text-ink-muted"
                    title={fmtFullTime(r.updatedAt)}
                  >
                    {fmtShortTime(r.updatedAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
