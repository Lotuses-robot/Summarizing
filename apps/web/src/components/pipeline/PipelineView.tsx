import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { PipelineEvent, PipelineRun, PipelineRunDetail } from "@summarizing/shared";
import { api } from "../../api";
import { cn } from "../../lib/cn";

/** action → 展示频道。未知 action 归「其他」——防御未知类型不丢内容（specs/005）。 */
function channelOf(action: string): string {
  if (
    action === "digest_done" ||
    action === "digest_failed" ||
    action === "startup_sweep" ||
    action === "repair_round"
  ) {
    return "处理结果";
  }
  if (
    action === "create_item" ||
    action === "update_item" ||
    action === "add_element" ||
    action === "complete_item" ||
    action === "resolve_doubt" ||
    action === "digest_note"
  ) {
    return "落笔动作";
  }
  if (action === "digest_trace") return "agent0 轨迹";
  if (action === "fence_reject" || action === "uncertain_resolved" || action === "sweep_done") {
    return "拒收与存疑";
  }
  return "其他";
}

const CHANNEL_ORDER = ["处理结果", "落笔动作", "agent0 轨迹", "拒收与存疑", "其他"];

/** 消化状态徽章的展示文案与配色。 */
function stateBadge(state: PipelineRun["digestState"]): { text: string; cls: string } {
  switch (state) {
    case "digesting":
      return { text: "消化中", cls: "text-warn" };
    case "digested":
      return { text: "已消化", cls: "text-accent" };
    case "failed":
      return { text: "未处理", cls: "text-danger" };
    case "pending":
      return { text: "排队中", cls: "text-ink-muted" };
  }
}

/** 单批详情：原文 + 按频道分组的流水事件（懒加载——点开行才取）。 */
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

  const groups = new Map<string, PipelineEvent[]>();
  for (const e of detail.events) {
    const ch = channelOf(e.action);
    const list = groups.get(ch) ?? [];
    list.push(e);
    groups.set(ch, list);
  }
  const channels = CHANNEL_ORDER.filter((ch) => groups.has(ch));

  return (
    <div className="space-y-3 border-t border-line px-3 py-3">
      <section>
        <h4 className="mb-1 text-xs font-semibold text-ink-muted">原文</h4>
        <p className="whitespace-pre-wrap rounded-md bg-canvas px-2 py-1.5 text-xs">
          {detail.raw.content}
        </p>
      </section>
      {channels.map((ch) => (
        <section key={ch}>
          <h4 className="mb-1 text-xs font-semibold text-ink-muted">{ch}</h4>
          <ul className="space-y-1">
            {groups.get(ch)?.map((e) => (
              <li key={e.id} className="rounded-md bg-canvas px-2 py-1.5 text-xs">
                <span className="text-ink-muted">{e.at}</span> {e.detail}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** 流水视图（specs/005）：进站台账 + 单批详情——「一条信息从进站到成事项」全程可查。
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
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">流水</h2>
          <p className="text-xs text-ink-muted">
            一条信息从进站到成事项的全程——消化中会自动浮出进度
          </p>
        </div>
        <button
          title="刷新"
          onClick={load}
          className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-accent-soft hover:text-accent"
        >
          <RefreshCw size={15} />
        </button>
      </div>

      {error !== null && <p className="mb-3 text-xs text-danger">流水加载失败：{error}</p>}
      {runs !== null && runs.length === 0 && (
        <p className="text-xs text-ink-muted">
          还没有批次——去对话或群里丢点信息，这里就会出现它的一生。
        </p>
      )}

      <div className="space-y-2">
        {runs?.map((run) => {
          const badge = stateBadge(run.digestState);
          const open = openId === run.id;
          return (
            <div key={run.id} className="rounded-lg border border-line bg-surface">
              <button
                onClick={() => setOpenId(open ? null : run.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-canvas"
              >
                <span className={cn("font-medium", badge.cls)}>{badge.text}</span>
                <span className="font-medium">{run.sourceLabel}</span>
                <span className="text-ink-muted">
                  {run.receivedAt.slice(0, 16).replace("T", " ")}
                </span>
                {run.summary !== null && <span className="text-ink-muted">{run.summary}</span>}
                <span className="ml-auto text-ink-muted">{run.eventCount} 条</span>
              </button>
              {open && <RunDetail id={run.id} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
