import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
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
    <div className="space-y-3 px-4 pb-3 pt-2">
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

/** 流水视图：置顶实时消化状态卡（渐隐轨迹 + 思考动画）+ 极简批次列表。 */
export function PipelineView() {
  const [runs, setRuns] = useState<PipelineRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    api
      .pipelineRuns(50)
      .then((r) => {
        setRuns(r.runs);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  // 耗时计时器：有 digesting 批次时每秒跳一次（纯前端视觉，不触发刷新）
  useEffect(() => {
    if (!runs?.some((r) => r.digestState === "digesting")) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [runs]);

  const digestingRuns = runs?.filter((r) => r.digestState === "digesting") ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      {/* ── 置顶实时消化状态卡（有 digesting 批次时出现）── */}
      {digestingRuns.length > 0 && (
        <div className="mb-5 space-y-3">
          {digestingRuns.map((run) => {
            const elapsedSec = Math.max(
              0,
              Math.floor((now - new Date(run.receivedAt).getTime()) / 1000),
            );
            return (
              <div
                key={run.id}
                className="rounded-xl border border-amber-200 bg-gradient-to-b from-amber-50/80 to-amber-50/30 px-4 py-3.5 dark:border-amber-500/20 dark:from-amber-500/5 dark:to-transparent"
              >
                <div className="flex items-center gap-2.5">
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-amber-500" />
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
              </div>
            );
          })}
        </div>
      )}

      {/* ── 标题 + 刷新 ── */}
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">流水</h2>
        <button
          title="刷新"
          onClick={load}
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {error !== null && <p className="mb-2 text-xs text-danger">流水加载失败：{error}</p>}
      {runs !== null && runs.length === 0 && (
        <p className="py-6 text-center text-xs text-ink-muted">
          还没有批次——去对话或群里丢点信息。
        </p>
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
                className="flex w-full items-center gap-2.5 px-1 py-2.5 text-left transition-colors hover:bg-canvas"
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
                  {run.receivedAt.slice(5, 16).replace("T", " ")}
                </span>
              </button>
              {open && <RunDetail id={run.id} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
