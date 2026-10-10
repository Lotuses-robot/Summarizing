import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { PipelineRun, PipelineRunDetail } from "@summarizing/shared";
import { api } from "../../api";
import { cn } from "../../lib/cn";

/** 消化状态徽章的展示文案与配色（dot 与时间线节点色同源）。 */
function stateBadge(state: PipelineRun["digestState"]): { text: string; dot: string; cls: string } {
  switch (state) {
    case "digesting":
      return { text: "消化中", dot: "bg-amber-500 animate-pulse", cls: "text-amber-600" };
    case "digested":
      return { text: "已消化", dot: "bg-emerald-500", cls: "text-emerald-600" };
    case "failed":
      return { text: "未处理", dot: "bg-red-500", cls: "text-red-500" };
    case "pending":
      return { text: "排队中", dot: "bg-zinc-400", cls: "text-zinc-400" };
  }
}

/** 流水事件节点色——一眼分清类型（查询/拒收/修复/完成）。 */
function eventDot(action: string): string {
  if (action === "digest_done" || action === "complete_item") return "bg-emerald-500";
  if (action === "digest_failed") return "bg-red-500";
  if (action === "fence_reject") return "bg-amber-500";
  if (action === "digest_trace" || action === "repair_round") return "bg-sky-500";
  return "bg-zinc-400";
}

/** 单批展开详情：原文 + 该批的流水事件（缩进在状态点下方，延续同一根线）。 */
function RunEvents({ id }: { id: string }) {
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
    return <p className="py-1 text-xs text-danger">详情加载失败：{error}</p>;
  }
  if (detail === null) {
    return <p className="py-1 text-xs text-ink-muted">详情加载中…</p>;
  }

  return (
    <div className="space-y-2 pt-1">
      <p className="whitespace-pre-wrap rounded-md bg-canvas px-2.5 py-2 text-xs leading-relaxed">
        {detail.raw.content}
      </p>
      {detail.events.map((e) => (
        <div key={e.id} className="flex items-baseline gap-2 text-xs">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", eventDot(e.action))} />
          <span className="text-ink-muted">{e.at.slice(11, 16)}</span>
          <span>{e.detail}</span>
        </div>
      ))}
    </div>
  );
}

/** 流水视图（specs/005）：共享竖向时间轴——外层状态色点与内层事件自然串联。
 *  打开期间 10s 轮询：消化是异步的，进度自己浮出来。 */
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
      <div className="mb-5 flex items-center justify-between">
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

      {/* 共享竖向时间轴：左侧线贯穿所有批次的状态点与事件点 */}
      <div className="relative">
        {/* 脊柱线 */}
        <div className="absolute bottom-3 left-[7px] top-3 w-px bg-line" aria-hidden />
        <div className="space-y-5">
          {runs?.map((run) => {
            const badge = stateBadge(run.digestState);
            const open = openId === run.id;
            return (
              <div key={run.id} className="relative">
                {/* 状态色点钉在脊柱线上 */}
                <span
                  className={cn(
                    "absolute -left-[22px] top-1 h-3.5 w-3.5 rounded-full border-2 border-surface",
                    badge.dot,
                  )}
                  title={badge.text}
                />
                {/* 批次内容 */}
                <div>
                  <button
                    onClick={() => setOpenId(open ? null : run.id)}
                    className="flex w-full items-baseline gap-2 text-left"
                  >
                    <span className={cn("text-xs font-medium", badge.cls)}>{badge.text}</span>
                    <span className="text-xs font-medium">{run.sourceLabel}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-ink-muted/70">
                      {run.receivedAt.slice(5, 16).replace("T", " ")}
                    </span>
                  </button>
                  {run.summary !== null && (
                    <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{run.summary}</p>
                  )}
                  {/* 展开详情：事件延续同一根脊柱线 */}
                  {open && <RunEvents id={run.id} />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
