import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { itemName, type TrashRow } from "@summarizing/shared";
import { api } from "../api";
import { cn } from "../lib/cn";
import { ItemBody } from "./board/ItemBody";
import { fmtFullTime, fmtShortTime } from "../lib/time";

/** 回收站页（007）：删掉的信息在这，可恢复；唯一批量操作 = 「一键清理 >15d」。
 *  两类信息混合、行标 kind（事项/通知）；按进入回收站的时刻倒序。
 *  **没有单条彻底删、没有「清空全部」**——彻底删只发生在清理环节，且只清 >15d 的（FR-008/FR-017）。
 *  「一键清理」不可逆 → 二次确认；文案说明原文档案不受影响。 */
export function TrashPanel({ rows, onRefresh }: { rows: TrashRow[]; onRefresh: () => void }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [purging, setPurging] = useState(false);

  /** 执行一键清理：服务端只删 >15d 的；失败不换本地态（刷新让列表如实呈现）。 */
  const purge = () => {
    setPurging(true);
    void api
      .purgeTrash()
      .catch(() => {
        // 失败不换本地态——刷新让列表如实呈现（服务端没删的就是没删）
      })
      .finally(() => {
        setPurging(false);
        setConfirming(false);
        onRefresh();
      });
  };

  if (rows.length === 0) {
    return (
      <p className="px-4 py-8 text-sm text-ink-muted">回收站是空的——删掉的信息会先落到这，可恢复</p>
    );
  }

  return (
    <div className="px-4 py-3">
      <div className="mb-3 flex items-center gap-3">
        <span className="text-sm text-ink-muted">
          共 {rows.length} 条——删除超过 15 天的会被「一键清理」彻底清掉，原文档案不受影响
        </span>
        <button
          className={cn(
            "btn ml-auto shrink-0",
            confirming && "border-danger/60 bg-danger-soft text-danger",
          )}
          disabled={purging}
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            purge();
          }}
        >
          {purging ? "清理中…" : confirming ? "确认清理 >15d 的？" : "一键清理 >15d"}
        </button>
        {confirming && !purging && (
          <button className="btn shrink-0" onClick={() => setConfirming(false)}>
            取消
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((r) => {
          const { item } = r;
          return (
            <li
              key={item.id}
              className={cn(
                "group relative cursor-pointer overflow-hidden rounded-md border border-transparent py-2 pl-5 pr-3 hover:bg-canvas",
                expandedId === item.id && "bg-canvas ring-1 ring-accent",
              )}
              onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="min-w-0 truncate text-ink-muted">{itemName(item.elements)}</span>
                <span className="chip shrink-0 text-ink-muted">
                  {item.kind === "notice" ? "通知" : "事项"}
                </span>
                {item.tags.map((t) => (
                  <span key={t} className="chip shrink-0 text-ink-muted">
                    {t}
                  </span>
                ))}
                <span className="ml-auto flex shrink-0 items-center gap-1 text-xs font-normal text-ink-muted">
                  <span title={`删于 ${fmtFullTime(r.trashedAt)}`}>
                    删于 {fmtShortTime(r.trashedAt)}
                  </span>
                  <button
                    className="row-act"
                    title="从回收站恢复（回到删前的状态）"
                    onClick={(e) => {
                      e.stopPropagation();
                      void api.restore(item.id).then(onRefresh).catch(onRefresh);
                    }}
                  >
                    <RotateCcw size={13} />
                  </button>
                </span>
              </div>
              {expandedId === item.id && (
                <div
                  className="mt-2 max-h-[70vh] overflow-y-auto rounded-md border border-line bg-surface"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="bg-canvas/40">
                    <ItemBody id={item.id} />
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
