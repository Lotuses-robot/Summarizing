import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { DIGEST_MAX_ROUNDS, type PipelineRun, type PipelineRunDetail } from "@summarizing/shared";
import { api } from "../../api";
import { cn } from "../../lib/cn";

/** 消化状态 → 色点 + 文字。 */
function stateInfo(state: PipelineRun["digestState"]): { dot: string; text: string } {
  switch (state) {
    case "digesting":
      return { dot: "bg-amber-500", text: "消化中" };
    case "digested":
      return { dot: "bg-emerald-500", text: "已消化" };
    case "failed":
      return { dot: "bg-red-500", text: "未处理" };
    case "pending":
      return { dot: "bg-zinc-400", text: "排队中" };
  }
}

/** 流水事件节点色。 */
function eventDot(action: string): string {
  if (action === "digest_done" || action === "complete_item") return "bg-emerald-500";
  if (action === "digest_failed") return "bg-red-500";
  if (action === "fence_reject") return "bg-amber-500";
  if (action === "digest_trace" || action === "repair_round") return "bg-sky-500";
  return "bg-zinc-400";
}

/** 单批详情：原文 + 纯时间线（事件按发生顺序排列，节点色区分类型）。 */
function RunDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<PipelineRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .pipelineRun(id)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch((err) => {
        if (alive) setError(String(err));
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (error !== null) {
    return <p className="px-4 py-2 text-xs text-danger">详情加载失败：{error}</p>;
  }
  if (detail === null) {
    return <p className="px-4 py-2 text-xs text-ink-muted">详情加载中…</p>;
  }

  // 最新在上（走查 2026-10-10：与状态卡轨迹同向——越往下越旧）
  const events = [...detail.events].reverse();
  return (
    <div data-testid="run-detail" className="rounded-b-lg bg-surface px-4 pb-3.5 pt-2">
      <section>
        <p className="whitespace-pre-wrap rounded-md bg-canvas px-2.5 py-2 text-xs leading-relaxed">
          {detail.raw.content}
        </p>
      </section>
      <div className="mt-3 space-y-0">
        {events.map((e, i) => (
          <div key={e.id} className="flex gap-3">
            <div className="flex flex-col items-center pt-1">
              <span
                className={cn("h-2 w-2 shrink-0 rounded-full", eventDot(e.action))}
                title={e.action}
              />
              {i < events.length - 1 && (
                <span className="w-px flex-1 bg-line" data-testid="timeline-spine" />
              )}
            </div>
            <div className="min-w-0 flex-1 pb-3">
              <p className="text-xs leading-relaxed">{e.detail}</p>
              <p className="mt-0.5 text-[10px] text-ink-muted/60">{e.at}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 列表/卡片共用的时间显示：MM-DD HH:mm。 */
function fmtTime(s: string): string {
  return s.slice(5, 16).replace("T", " ");
}

/** 空闲态卡的图标与文案（仅在没有消化中批次与完成闪示时调用：说清「空闲」+ 最近一批结局）。 */
function idleCard(latest: PipelineRun | undefined): {
  icon: ReactNode;
  title: string;
  sub: string;
  tone: string;
} {
  if (latest === undefined) {
    return {
      icon: <Circle size={20} className="shrink-0 text-ink-muted/50" />,
      title: "空闲",
      sub: "等待第一条信息。",
      tone: "text-ink-muted",
    };
  }
  if (latest.digestState === "pending") {
    return {
      icon: <Clock size={20} className="shrink-0 text-ink-muted" />,
      title: "排队中",
      sub: "等待开始消化……",
      tone: "text-ink-muted",
    };
  }
  if (latest.digestState === "failed") {
    // 失败不许在卡上消失（01§8.3 静默红线）：红叉 + 措辞直说未处理
    return {
      icon: <XCircle size={20} className="shrink-0 text-red-500" />,
      title: "空闲",
      sub: `最近一批未处理：${latest.sourceLabel}`,
      tone: "text-danger",
    };
  }
  return {
    icon: <CheckCircle2 size={20} className="shrink-0 text-emerald-500" />,
    title: "空闲",
    sub: latest.summary !== null ? `最近一批已消化——${latest.summary}` : "最近一批已消化。",
    tone: "text-ink-muted",
  };
}

/** 大状态卡骨架（走查 2026-10-10）：顶栏元信息 + 大 H1 状态字 + 详情区——三种形态共用。 */
function HeroCard({
  shell,
  meta,
  children,
}: {
  shell: string; // 卡壳配色（琥珀=消化中 / 翠绿=完成闪示 / 面板色=空闲）
  meta: ReactNode; // 顶栏：图标 + 来源 + 右侧计时
  children: ReactNode; // 大 H1 + 详情区
}) {
  return (
    <div className={cn("rounded-2xl px-5 py-5", shell)}>
      <div className="flex items-center gap-2.5">{meta}</div>
      {children}
    </div>
  );
}

/** 消化中卡：黄色转圈（用户定的状态语义）+ 大 H1「消化中」+ 已跑耗时 + 流动条 + 渐隐轨迹。 */
function DigestingCard({
  run,
  events,
  now,
  pendingCount,
}: {
  run: PipelineRun;
  events: PipelineRunDetail["events"];
  now: number;
  pendingCount: number;
}) {
  const elapsedSec = Math.max(0, Math.floor((now - new Date(run.receivedAt).getTime()) / 1000));
  // 最近 3 条事件倒序（最新在上，旧的向下渐隐——「滚动栏 + 残影」）
  const recent = events.slice(-3).reverse();
  // 轮次进度：digest_trace 一条 = 完成一轮（真实事件驱动；上限 = 服务端硬约束）
  const rounds = events.filter((e) => e.action === "digest_trace").length;
  const roundPct = Math.min(100, Math.round((rounds / DIGEST_MAX_ROUNDS) * 100));
  return (
    <HeroCard
      shell="border border-amber-200 bg-gradient-to-b from-amber-50/80 to-amber-50/20 dark:border-amber-500/20 dark:from-amber-500/10 dark:to-transparent"
      meta={
        <>
          <Loader2 size={16} className="shrink-0 animate-spin text-amber-500" />
          <span className="text-xs font-medium text-amber-700/90 dark:text-amber-400/90">
            {run.sourceLabel}
          </span>
          <span className="ml-auto text-xs tabular-nums text-ink-muted/70">
            {rounds > 0 && `第 ${rounds}/${DIGEST_MAX_ROUNDS} 轮 · `}已跑 {elapsedSec}s
          </span>
        </>
      }
    >
      <p className="mt-4 text-3xl font-semibold tracking-tight text-amber-900 dark:text-amber-200">
        消化中
      </p>
      {/* 轮次进度条：宽度 = 已完成轮数/上限（真实推进，不是纯装饰动画） */}
      <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-amber-200/50 dark:bg-amber-500/10">
        <div
          className="h-full animate-pulse rounded-full bg-amber-400 transition-[width] duration-700"
          style={{ width: `${Math.max(5, roundPct)}%`, animationDuration: "2s" }}
        />
      </div>
      {/* 实时轨迹：最新一条最亮，越旧越淡（残影） */}
      {recent.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {recent.map((e, i) => (
            <p
              key={e.id}
              className="truncate text-xs text-amber-800 dark:text-amber-300"
              style={{ opacity: i === 0 ? 1 : i === 1 ? 0.45 : 0.25 }}
            >
              {e.detail}
            </p>
          ))}
        </div>
      )}
      {pendingCount > 0 && (
        <p className="mt-2 text-[10px] text-amber-700/70 dark:text-amber-400/60">
          另有 {pendingCount} 个批次排队中
        </p>
      )}
    </HeroCard>
  );
}

/** 完成闪示卡（走查 2026-10-10）：digesting→digested 的那次轮询置顶 3s——绿勾弹出 + 卡片淡入。 */
function DoneCard({ run }: { run: PipelineRun }) {
  return (
    <HeroCard
      shell="flash-in border border-emerald-200 bg-gradient-to-b from-emerald-50/80 to-emerald-50/20 dark:border-emerald-500/20 dark:from-emerald-500/10 dark:to-transparent"
      meta={
        <>
          <span className="text-xs font-medium text-emerald-700/90 dark:text-emerald-400/90">
            {run.sourceLabel}
          </span>
          <span className="ml-auto text-xs tabular-nums text-ink-muted/70">
            {fmtTime(run.receivedAt)}
          </span>
        </>
      }
    >
      <div className="mt-4 flex items-center gap-3">
        <CheckCircle2 size={30} className="pop-in shrink-0 text-emerald-500" />
        <p className="text-3xl font-semibold tracking-tight text-emerald-900 dark:text-emerald-200">
          已完成
        </p>
      </div>
      <p className="mt-2.5 truncate text-sm text-emerald-800/90 dark:text-emerald-300/90">
        {run.summary ?? "已消化"}
      </p>
    </HeroCard>
  );
}

/** 空闲卡：大 H1「空闲/排队中」+ 最近一批结局（绿勾/红叉/灰圈靠卡片左侧图符表达）。 */
function IdleCard({ latest }: { latest: PipelineRun | undefined }) {
  const idle = idleCard(latest);
  return (
    <HeroCard
      shell="border border-line/60 bg-surface"
      meta={
        <>
          {latest !== undefined && (
            <span className="text-xs font-medium text-ink-muted/80">{latest.sourceLabel}</span>
          )}
          <span className="ml-auto text-xs tabular-nums text-ink-muted/60">
            {latest !== undefined ? fmtTime(latest.receivedAt) : ""}
          </span>
        </>
      }
    >
      <div className="mt-4 flex items-center gap-3">
        {idle.icon}
        <p className="text-3xl font-semibold tracking-tight">{idle.title}</p>
      </div>
      <p className={cn("mt-2.5 truncate text-sm", idle.tone)}>{idle.sub}</p>
    </HeroCard>
  );
}

/** 常驻状态卡编排：完成闪示 → 消化中卡（可多张）→ 空闲卡。优先级从上到下。 */
function StatusCard({
  runs,
  traces,
  now,
  flash,
}: {
  runs: PipelineRun[];
  traces: Record<string, PipelineRunDetail["events"]>;
  now: number;
  flash: PipelineRun | null;
}) {
  const digesting = runs.filter((r) => r.digestState === "digesting");
  const pendingCount = runs.filter((r) => r.digestState === "pending").length;
  const latest = runs[0];
  return (
    <div className="mb-5 space-y-3">
      {flash !== null && <DoneCard run={flash} />}
      {digesting.map((run) => (
        <DigestingCard
          key={run.id}
          run={run}
          events={traces[run.id] ?? []}
          now={now}
          pendingCount={pendingCount}
        />
      ))}
      {flash === null && digesting.length === 0 && <IdleCard latest={latest} />}
    </div>
  );
}

/** 流水视图：常驻状态卡（消化中→实时轨迹；空闲→最近一批结局）+ 极简批次列表。
 *  轮询频率自适应：有消化中批次 3s，空闲 10s（消化是异步的，快轮询让轨迹实时浮出）。 */
export function PipelineView() {
  const [runs, setRuns] = useState<PipelineRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // 消化中批次的实时轨迹（runs 列表不含事件详情——单独拉 detail 喂状态卡）
  const [traces, setTraces] = useState<Record<string, PipelineRunDetail["events"]>>({});
  // 完成闪示（走查 2026-10-10）：digesting→digested 的那次轮询置「已完成」卡 3 秒
  const [flash, setFlash] = useState<PipelineRun | null>(null);
  const prevStates = useRef(new Map<string, PipelineRun["digestState"]>());
  const baselined = useRef(false); // 首轮只建底（历史批次不许闪）
  const openedAt = useRef(Date.now());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    api
      .pipelineRuns(50)
      .then((r) => {
        // 完成后闪示，两类：①上次轮询见它在消化 → 现在完成；②页开后新到的批次一轮就完成
        // （没赶上 digesting 的快消化——2s 松弛吸收 receivedAt 秒级截断）
        const prev = prevStates.current;
        const isBaseline = !baselined.current;
        const justDone = r.runs.find(
          (run) =>
            run.digestState === "digested" &&
            (prev.get(run.id) === "digesting" ||
              (!isBaseline &&
                !prev.has(run.id) &&
                Date.parse(run.receivedAt) >= openedAt.current - 2000)),
        );
        prevStates.current = new Map(r.runs.map((run) => [run.id, run.digestState]));
        baselined.current = true;
        setRuns(r.runs);
        setError(null);
        if (justDone) {
          setFlash(justDone);
          if (flashTimer.current !== null) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setFlash(null), 3000);
        }
        // 拉每个消化中批次的轨迹（失败静默——轨迹是锦上添花，不阻塞列表）
        for (const run of r.runs.filter((x) => x.digestState === "digesting")) {
          api
            .pipelineRun(run.id)
            .then((detail) => {
              setTraces((cur) => ({ ...cur, [run.id]: detail.events ?? [] }));
            })
            .catch(() => {
              // 轨迹拉取失败：状态卡退化为无轨迹（列表本身照常可用）
            });
        }
      })
      .catch((err) => setError(String(err)));
  }, []);

  // 卸载时清掉闪示计时器（防卸载后 setState）
  useEffect(() => {
    return () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    };
  }, []);

  const hasDigesting = runs?.some((r) => r.digestState === "digesting") ?? false;

  useEffect(() => {
    load();
    const timer = setInterval(load, hasDigesting ? 3_000 : 10_000);
    return () => clearInterval(timer);
  }, [load, hasDigesting]);

  // 耗时计时器：有 digesting 批次时每秒跳一次（纯前端视觉，不触发刷新）
  useEffect(() => {
    if (!hasDigesting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasDigesting]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      {/* ── 常驻状态卡（空闲也在——没卡片让人以为页面死了）── */}
      {runs !== null && <StatusCard runs={runs} traces={traces} now={now} flash={flash} />}

      {/* ── 标题 + 刷新 ── */}
      <div className="mb-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            流水
            {runs !== null && runs.length > 0 && (
              <span className="ml-2 text-xs text-ink-muted">{runs.length} 个批次</span>
            )}
          </h2>
          <button
            title="刷新"
            onClick={load}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent"
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <p className="mt-1 text-xs text-ink-muted">
          每条信息从进站到消化的全程留痕——点开行看 agent0 的思考与工具使用。
        </p>
      </div>

      {error !== null && <p className="mb-2 text-xs text-danger">流水加载失败：{error}</p>}
      {runs !== null && runs.length === 0 && (
        <p className="mt-6 text-sm text-ink-muted">还没有批次——去对话或群里丢点信息。</p>
      )}

      {/* ── 极简批次列表（无边框，纯行 + 间距）── */}
      <div className="divide-y divide-line/40">
        {runs?.map((run) => {
          const info = stateInfo(run.digestState);
          const open = openId === run.id;
          return (
            <div key={run.id}>
              <button
                onClick={() => setOpenId(open ? null : run.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-1 py-2.5 text-left transition-colors",
                  // 展开时行与详情拼成一张圆角卡（走查 2026-10-10：方下方圆不协调）
                  open ? "rounded-t-lg bg-surface" : "rounded-lg hover:bg-surface",
                )}
              >
                <span className={cn("h-2 w-2 shrink-0 rounded-full", info.dot)} />
                <span className="text-[10px] text-ink-muted">{info.text}</span>
                <span className="text-xs font-medium">{run.sourceLabel}</span>
                {run.summary !== null && (
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">
                    {run.summary}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[10px] text-ink-muted/50">
                  {fmtTime(run.receivedAt)}
                </span>
                <ChevronRight
                  size={13}
                  className={cn(
                    "shrink-0 text-ink-muted/40 transition-transform",
                    open && "rotate-90",
                  )}
                />
              </button>
              {open && <RunDetail id={run.id} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
