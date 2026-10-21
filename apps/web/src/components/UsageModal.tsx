import { useEffect, useRef, useState } from "react";
import { ChartColumn } from "lucide-react";
import { errText, type UsageRange, type UsageSummary } from "@summarizing/shared";
import { api } from "../api";
import { pushEscLayer } from "../lib/escLayer";
import { cn } from "../lib/cn";
import { fmtCompact, fmtExact } from "../lib/format";

// 用量仪表盘（010）：活动栏左下角独立入口打开——**不进设置**（用户 2026-10-20 定：
// 设置 = 声明式偏好，这里只是看数字）。三个大号数字：未命中输入 / 输出 / 缓存命中，互不重叠
// （用户明确要求「缓存和输入输出都分开统计」）。缓存为 null = 服务商未提供，照实说，不以 0 冒充。

/** 范围选项（顺序即展示顺序）。 */
const RANGES: { id: UsageRange; label: string }[] = [
  { id: "today", label: "今日" },
  { id: "7d", label: "近 7 天" },
  { id: "30d", label: "近 30 天" },
];

/** 一枚大号数字卡；value=null 时显示「—」+ note（如「服务商未提供」）。
 *  数字按 K/M/B 压缩（最多 3 位有效数字），悬浮显示精确值——与公开面板同一套记法。 */
function Stat({ label, value, note }: { label: string; value: number | null; note?: string }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-line bg-canvas px-4 py-5">
      <div className="text-xs text-ink-muted">{label}</div>
      <div
        className={cn(
          "mt-1.5 font-semibold tabular-nums tracking-tight",
          value === null ? "text-xl text-ink-muted" : "text-3xl",
        )}
        title={value === null ? undefined : `${fmtExact(value)} token`}
      >
        {value === null ? "—" : fmtCompact(value)}
      </div>
      <div className="mt-1 min-h-4 text-[11px] text-ink-muted">{note ?? ""}</div>
    </div>
  );
}

/** 用量弹层：三个大号数字的简单仪表盘 + 范围切换。
 *  v1 按 spec FR-005 不做图表/表格/拆分列表。 */
export function UsageModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [range, setRange] = useState<UsageRange>("7d");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  // Esc 分层退出（与设置/用户/关于弹层同款）
  useEffect(() => {
    if (!open) return;
    return pushEscLayer(() => onCloseRef.current());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    api
      .usage(range)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, range]);

  if (!open) return null;

  // 只渲染与当前 range 匹配的数据——否则切范围的瞬间会把上一档的数字当新档显示（数秒钟的错数）
  const shown = data !== null && data.range === range ? data : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-[12vh_1rem_1rem]"
      onClick={onClose}
    >
      <div
        className="flex w-[min(520px,94vw)] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-line px-5 py-3">
          <ChartColumn size={16} className="text-ink-muted" />
          <span className="font-semibold">用量</span>
          <span className="text-sm text-ink-muted">· token</span>
        </header>

        <div className="px-5 py-5">
          <div className="mb-4 flex gap-1.5" role="tablist" aria-label="统计范围">
            {RANGES.map((r) => (
              <button
                key={r.id}
                role="tab"
                aria-selected={range === r.id}
                className={cn(
                  "btn",
                  range === r.id && "border-accent/60 bg-accent-soft text-accent",
                )}
                onClick={() => setRange(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>

          {error !== null ? (
            <p role="alert" className="text-sm text-danger">
              用量加载失败：{error}
            </p>
          ) : shown === null ? (
            <p className="text-sm text-ink-muted">加载中…</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="未命中输入" value={shown.inputTokens} />
                <Stat label="输出" value={shown.completionTokens} />
                <Stat
                  label="缓存命中"
                  value={shown.cachedTokens}
                  note={shown.cachedTokens === null ? "服务商未提供" : undefined}
                />
              </div>
              <p className="mt-3 text-xs text-ink-muted">
                {shown.callCount === 0
                  ? "这段时间还没有调用"
                  : `共 ${fmtExact(shown.callCount)} 次调用`}
              </p>
            </>
          )}
        </div>

        <footer className="flex justify-end border-t border-line px-5 py-3">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
