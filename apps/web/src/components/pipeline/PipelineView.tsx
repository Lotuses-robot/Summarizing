import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { PipelineRun, PipelineRunDetail } from "@summarizing/shared";
import { api } from "../../api";
import { cn } from "../../lib/cn";

/** 消化状态徽章的展示文案与配色。 */
function stateBadge(state: PipelineRun["digestState"]): { text: string; cls: string } {
  switch (state) {
    case "digesting":
      return { text: "消化中", cls: "text-amber-600" };
    case "digested":
      return { text: "已消化", cls: "text-emerald-600" };
    case "failed":
      return { text: "未处理", cls: "text-red-500" };
    case "pending":
      return { text: "排队中", cls: "text-zinc-400" };
  }
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
    return <p className="px-3 py-2 text-xs text-danger">详情加载失败：{error}</p>;
  }
  if (detail === null) {
    return <p className="px-3 py-2 text-xs text-ink-muted">详情加载中…</p>;
  }

  return (
    <div className="space-y-3 border-t border-line px-3 py-3">
      <section>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted/60">
          原文
        </p>
        <p className="whitespace-pre-wrap rounded-md bg-canvas px-2.5 py-2 text-xs leading-relaxed">
          {detail.raw.content}
        </p>
      </section>
      <section>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-ink-muted/60">
          流水
        </p>
        <div className="space-y-0">
          {detail.events.map((e, i) => (
            <div key={e.id} className="flex gap-3">
              {/* 时间轴节点列：色点 + 连接线 */}
              <div className="flex flex-col items-center pt-1">
                <span
                  className={cn("h-2 w-2 shrink-0 rounded-full", eventDotCls(e.action))}
                  title={e.action}
                />
                {i < detail.events.length - 1 && (
                  <span className="w-px flex-1 bg-line" data-testid="timeline-spine" />
                )}
              </div>
              {/* 事件内容 */}
              <div className="min-w-0 flex-1 pb-3">
                <p className="text-xs leading-relaxed">{e.detail}</p>
                <p className="mt-0.5 text-[10px] text-ink-muted/60">{e.at}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** 流水事件节点色——按 action 大类映射。 */
function eventDotCls(action: string): string {
  if (action === "digest_done" || action === "complete_item") return "bg-emerald-500";
  if (action === "digest_failed") return "bg-red-500";
  if (action === "fence_reject") return "bg-amber-500";
  if (action === "digest_trace" || action === "repair_round") return "bg-sky-500";
  return "bg-zinc-400";
}

/** 流水视图（specs/005）：进站台账 + 单批详情时间线——「一条信息从进站到成事项」全程可查。
 *  打开期间 10s 轮询：消化是异步的，进度自己浮出来（无需手动刷新）。 */
export function PipelineView() {
  const [runs, setRuns] = useState<PipelineRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

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

  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">流水</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            一条信息从进站到成事项的全程——消化中会自动浮出进度
          </p>
        </div>
        <button
          title="刷新"
          onClick={load}
          className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent"
        >
          <RefreshCw size={15} />
        </button>
      </div>

      {error !== null && (
        <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
          流水加载失败：{error}
        </p>
      )}
      {runs !== null && runs.length === 0 && (
        <div className="flex flex-col items-center gap-1 py-8 text-center">
          <p className="text-sm text-ink-muted">还没有批次</p>
          <p className="text-xs text-ink-muted/60">去对话或群里丢点信息，这里就会出现它的一生。</p>
        </div>
      )}

      <div className="space-y-3">
        {runs?.map((run) => {
          const badge = stateBadge(run.digestState);
          const open = openId === run.id;
          return (
            <div
              key={run.id}
              className={cn(
                "rounded-xl border bg-surface shadow-sm transition-colors",
                open ? "border-accent/30" : "border-line hover:border-line/80",
              )}
            >
              {/* 台账行：可点击展开 */}
              <button
                onClick={() => setOpenId(open ? null : run.id)}
                className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left"
              >
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-medium leading-4",
                    badge.cls,
                    run.digestState === "digesting" && "animate-pulse bg-amber-50",
                    run.digestState === "digested" && "bg-emerald-50",
                    run.digestState === "failed" && "bg-red-50",
                    run.digestState === "pending" && "bg-zinc-100",
                  )}
                >
                  {badge.text}
                </span>
                <span className="text-xs font-medium">{run.sourceLabel}</span>
                <span className="ml-auto shrink-0 text-[10px] text-ink-muted/70">
                  {run.receivedAt.slice(5, 16).replace("T", " ")}
                </span>
                <span className="shrink-0 text-[10px] text-ink-muted/50">{run.eventCount} 条</span>
              </button>
              {/* 摘要行 */}
              {run.summary !== null && (
                <p className="px-3.5 pb-2 text-xs leading-relaxed text-ink-muted">{run.summary}</p>
              )}
              {/* 展开详情 */}
              {open && <RunDetail id={run.id} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
