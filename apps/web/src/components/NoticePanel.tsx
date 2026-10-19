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
// （进回收站、可撤销）。左右缘常驻浅提示同时也是点击兜底。
// 自动选择：进入 / 筛选变化 / 清除 / 稍后之后，选下一条未跳过的；轮询不抢焦点。
// 拖动走直接 DOM 变换（不经 state）——ItemBody 内容重不参与逐帧重渲染，手感跟手。

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
  const dxRef = useRef(0);
  const cardBodyRef = useRef<HTMLDivElement | null>(null);
  const revealRef = useRef<HTMLDivElement | null>(null);
  const leftActRef = useRef<HTMLSpanElement | null>(null);
  const rightActRef = useRef<HTMLSpanElement | null>(null);
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

  // 选中即已读——但**只在"选中的那条发生变化"时**标：轮询把同一条内容更新后应亮「未读」
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

  /** 倒计时 interval（用 ref 持有——避免每次渲染重置）。 */
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

  /** 撤销窗口的 Esc 层：只取消本次清除（按「是否有待删」注册，避免每秒重注册）。 */
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

  /** 稍后：进本次跳过集合，选下一条未跳过的（不写库）。 */
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

  // ── 拖动：直接改写 DOM（不 setState），内容不参与逐帧重渲染 ──
  /** 按下：记录起点与卡宽；交互元素上不启动拖动（点证据/链接/按钮要正常）。 */
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pending !== null || selected === null) return;
    if ((e.target as HTMLElement).closest("button,a,summary,input,textarea,select")) return;
    dragRef.current = { startX: e.clientX, width: cardBodyRef.current?.clientWidth ?? 320 };
    dxRef.current = 0;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (cardBodyRef.current !== null) cardBodyRef.current.style.transition = "none";
    if (revealRef.current !== null) revealRef.current.style.display = "block";
  };
  /** 移动：位移限制在 ±60% 卡宽；底层动作层随位移加深，方向决定露哪一侧。 */
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d === null) return;
    const limit = d.width * 0.6;
    const dx = Math.max(-limit, Math.min(limit, e.clientX - d.startX));
    dxRef.current = dx;
    if (cardBodyRef.current !== null) {
      cardBodyRef.current.style.transform = `translateX(${dx}px)`;
    }
    const strength = Math.min(1, Math.abs(dx) / Math.max(1, d.width * SWIPE_RATIO));
    if (revealRef.current !== null) {
      revealRef.current.style.opacity = String(0.35 + strength * 0.65);
    }
    if (leftActRef.current !== null) {
      leftActRef.current.style.display = dx > 4 ? "inline-flex" : "none";
      leftActRef.current.style.opacity = String(strength);
    }
    if (rightActRef.current !== null) {
      rightActRef.current.style.display = dx < -4 ? "inline-flex" : "none";
      rightActRef.current.style.opacity = String(strength);
    }
  };
  /** 松开：过阈值即执行（右=清除、左=稍后），否则回弹。 */
  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    const dx = dxRef.current;
    dxRef.current = 0;
    if (cardBodyRef.current !== null) {
      cardBodyRef.current.style.transition = "";
      cardBodyRef.current.style.transform = "";
    }
    if (revealRef.current !== null) revealRef.current.style.display = "none";
    if (leftActRef.current !== null) leftActRef.current.style.display = "none";
    if (rightActRef.current !== null) rightActRef.current.style.display = "none";
    if (d === null || selected === null) return;
    const threshold = d.width * SWIPE_RATIO;
    if (dx >= threshold)
      startDelete(selected); // 向右拖 = 清除
    else if (dx <= -threshold) skip(selected); // 向左拖 = 稍后
  };

  const emptyCardText =
    notices.length === 0
      ? "还没有通知——群里发来的、不用你去做但值得知道的事会落到这"
      : visible.length === 0
        ? "没有匹配的通知"
        : "这一轮没有待看的通知";

  /** 该条是否未读（本地标记也算已读）。 */
  const isUnread = (r: NoticeRow): boolean =>
    !r.viewed && viewedLocally.get(r.item.id) !== r.updatedAt;

  return (
    <div className="px-4 py-3">
      {actionError !== null && (
        <p className="mb-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
          {actionError}
        </p>
      )}

      {/* 主卡：固定（列表滚动时不动）；内容超出在卡内滚动 */}
      <div className="sticky top-0 z-10 -mx-1 bg-canvas px-1 pb-3">
        <div className="relative">
          {/* 底层：低一层的画布色 + 方向箭头 + 垂直居中的动作词（拖动时露出，标题不抢） */}
          <div
            ref={revealRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 hidden overflow-hidden rounded-lg bg-canvas"
            style={{ opacity: 0.35 }}
          >
            <span
              ref={leftActRef}
              className="absolute left-6 top-1/2 hidden -translate-y-1/2 items-center gap-1 text-sm font-medium text-ink-muted"
            >
              {">>>"} 清除
            </span>
            <span
              ref={rightActRef}
              className="absolute right-6 top-1/2 hidden -translate-y-1/2 items-center gap-1 text-sm font-medium text-ink-muted"
            >
              稍后 {"<<<"}
            </span>
          </div>

          {/* 卡片本体 */}
          <div
            ref={cardBodyRef}
            className="relative z-10 touch-pan-y rounded-lg border border-line bg-surface transition-transform duration-150"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {/* 左右缘垂直居中的常驻浅提示（同时是点击兜底）；内容已内缩，不会与正文相撞 */}
            {selected !== null && pending === null && (
              <>
                <button
                  className="absolute left-1 top-1/2 z-10 -translate-y-1/2 cursor-pointer rounded px-1 py-0.5 text-[10px] text-ink-muted/50 hover:bg-canvas hover:text-ink-muted"
                  title="稍后（本次跳过；也可向左拖动卡片）"
                  onClick={() => skip(selected)}
                >
                  ‹ 稍后
                </button>
                <button
                  className="absolute right-1 top-1/2 z-10 -translate-y-1/2 cursor-pointer rounded px-1 py-0.5 text-[10px] text-ink-muted/50 hover:bg-canvas hover:text-ink-muted"
                  title="清除（进回收站，可撤销；也可向右拖动卡片）"
                  onClick={() => startDelete(selected)}
                >
                  清除 ›
                </button>
              </>
            )}

            {selected !== null ? (
              <div>
                {/* 标题在上、meta 一行小灰字在下——来源不再做成 chip（用户 2026-10-19） */}
                <div className="px-6 pt-4">
                  <h2 className="pr-3 text-lg font-semibold leading-snug">
                    {itemName(selected.item.elements)}
                  </h2>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        isUnread(selected) ? "bg-accent" : "bg-line",
                      )}
                      title={isUnread(selected) ? "未读" : "已读"}
                      aria-label={isUnread(selected) ? "未读" : "已读"}
                    />
                    {selected.sourceLabel !== null && <span>{selected.sourceLabel}</span>}
                    <span title={`更新于 ${fmtFullTime(selected.updatedAt)}`}>
                      {fmtShortTime(selected.updatedAt)}
                    </span>
                    {selected.item.tags.map((t) => (
                      <span key={t} className="text-ink-muted/70">
                        #{t}
                      </span>
                    ))}
                    <span className="ml-auto tabular-nums">
                      {selectedIndex + 1}/{visible.length}
                    </span>
                  </div>
                </div>
                {/* 内容：复用展开体（阅读器形态：去小节标题、空的基本信息不渲染） */}
                <div className="max-h-[60vh] overflow-y-auto px-2">
                  <ItemBody id={selected.item.id} variant="reader" />
                </div>
              </div>
            ) : (
              <p className="px-6 py-10 text-sm text-ink-muted">{emptyCardText}</p>
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

      {/* 下方列表：只做索引与选择（未读点 + 语义名 + 来源 + 时间） */}
      {visible.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {visible.map((r) => {
            const isSelected = r.item.id === selectedId;
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
                      isUnread(r) ? "bg-accent" : "bg-line",
                    )}
                    title={isUnread(r) ? "未读" : "已读"}
                    aria-label={isUnread(r) ? "未读" : "已读"}
                  />
                  <span className="min-w-0 flex-1 truncate">{itemName(r.item.elements)}</span>
                  {r.sourceLabel !== null && (
                    <span className="shrink-0 text-xs text-ink-muted">{r.sourceLabel}</span>
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
