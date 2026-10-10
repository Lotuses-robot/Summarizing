import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import type { PipelineRun, PipelineRunDetail } from "@summarizing/shared";
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

  return (
    <div className="mx-1 mb-2 space-y-3 rounded-lg bg-surface px-3.5 pb-3 pt-3">
      <section>
        <p className="whitespace-pre-wrap rounded-md bg-canvas px-2.5 py-2 text-xs leading-relaxed">
          {detail.raw.content}
        </p>
      </section>
      <div className="space-y-0">
        {detail.events.map((e, i) => (
          <div key={e.id} className="flex gap-3">
            <div className="flex flex-col items-center pt-1">
              <span
                className={cn("h-2 w-2 shrink-0 rounded-full", eventDot(e.action))}
                title={e.action}
              />
              {i < detail.events.length - 1 && (
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

/** 空闲态卡的图标与文案（仅在没有消化中批次时调用：说清「空闲」+ 最近一批结局）。 */
function idleCard(latest: PipelineRun | undefined): {
  icon: ReactNode;
  title: string;
  sub: string;
  tone: string;
} {
  if (latest === undefined) {
    return {
      icon: <Circle size={14} className="shrink-0 text-ink-muted/50" />,
      title: "空闲",
      sub: "等待第一条信息。",
      tone: "text-ink-muted",
    };
  }
  if (latest.digestState === "pending") {
    return {
      icon: <Clock size={14} className="shrink-0 text-ink-muted" />,
      title: "排队中",
      sub: "等待开始消化……",
      tone: "text-ink-muted",
    };
  }
  if (latest.digestState === "failed") {
    // 失败不许在卡上消失（01§8.3 静默红线）：红叉 + 措辞直说未处理
    return {
      icon: <XCircle size={14} className="shrink-0 text-red-500" />,
      title: "空闲",
      sub: `最近一批未处理：${latest.sourceLabel}`,
      tone: "text-danger",
    };
  }
  return {
    icon: <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />,
    title: "空闲",
    sub: latest.summary !== null ? `最近一批已消化——${latest.summary}` : "最近一批已消化。",
    tone: "text-ink-muted",
  };
}

/** 常驻状态卡（2026-10-10 走查）：agent0 现在在干什么——
 *  消化中：琥珀卡（转圈 + 来源 + 已跑耗时 + 流动条 + 渐隐轨迹）；无在途：空闲/排队卡（图标标最近一批结局）。 */
function StatusCard({
  runs,
  traces,
  now,
}: {
  runs: PipelineRun[];
  traces: Record<string, PipelineRunDetail["events"]>;
  now: number;
}) {
  const digesting = runs.filter((r) => r.digestState === "digesting");
  const pendingCount = runs.filter((r) => r.digestState === "pending").length;
  const latest = runs[0];

  if (digesting.length > 0) {
    return (
      <div className="mb-5 space-y-3">
        {digesting.map((run) => {
          const elapsedSec = Math.max(
            0,
            Math.floor((now - new Date(run.receivedAt).getTime()) / 1000),
          );
          // 最近 3 条事件倒序（最新在上，旧的向下渐隐——「滚动栏 + 残影」）
          const recent = (traces[run.id] ?? []).slice(-3).reverse();
          return (
            <div
              key={run.id}
              className="rounded-xl border border-amber-200 bg-gradient-to-b from-amber-50/80 to-amber-50/30 px-4 py-3.5 dark:border-amber-500/20 dark:from-amber-500/5 dark:to-transparent"
            >
              <div className="flex items-center gap-2.5">
                {/* 黄色转圈 = 正在思考/处理（用户定的状态语义） */}
                <Loader2 size={14} className="shrink-0 animate-spin text-amber-500" />
                <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                  消化中
                </span>
                <span className="text-xs font-medium">{run.sourceLabel}</span>
                <span className="ml-auto text-[10px] tabular-nums text-ink-muted/60">
                  已跑 {elapsedSec}s
                </span>
              </div>
              {/* 不确定进度条——流动感 */}
              <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-amber-200/50 dark:bg-amber-500/10">
                <div
                  className="h-full w-1/3 animate-pulse rounded-full bg-amber-400"
                  style={{ animationDuration: "1.5s" }}
                />
              </div>
              {/* 实时轨迹：最新一条最亮，越旧越淡（残影） */}
              {recent.length > 0 && (
                <div className="mt-2 space-y-1">
                  {recent.map((e, i) => (
                    <p
                      key={e.id}
                      className="truncate text-[11px] text-amber-800 dark:text-amber-300"
                      style={{ opacity: i === 0 ? 1 : i === 1 ? 0.45 : 0.25 }}
                    >
                      {e.detail}
                    </p>
                  ))}
                </div>
              )}
              {pendingCount > 0 && (
                <p className="mt-1.5 text-[10px] text-amber-700/70 dark:text-amber-400/60">
                  另有 {pendingCount} 个批次排队中
                </p>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  const idle = idleCard(latest);
  return (
    <div className="mb-5">
      <div className="rounded-xl border border-line/60 bg-surface px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          {idle.icon}
          <span className="text-xs font-semibold">{idle.title}</span>
          {latest !== undefined && (
            <span className="text-xs font-medium">{latest.sourceLabel}</span>
          )}
          <span className="ml-auto text-[10px] tabular-nums text-ink-muted/60">
            {latest !== undefined ? fmtTime(latest.receivedAt) : ""}
          </span>
        </div>
        <p className={cn("mt-1.5 truncate text-[11px]", idle.tone)}>{idle.sub}</p>
      </div>
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

  const load = useCallback(() => {
    api
      .pipelineRuns(50)
      .then((r) => {
        setRuns(r.runs);
        setError(null);
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
      {runs !== null && <StatusCard runs={runs} traces={traces} now={now} />}

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
                className="flex w-full items-center gap-2.5 px-1 py-2.5 text-left transition-colors hover:bg-surface"
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
