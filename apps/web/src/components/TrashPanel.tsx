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
  /** 清理/恢复的结果与失败必须可见（红线「不许静默」）：否则「0 条可清」与「失败」无法分辨。 */
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  /** 执行一键清理：服务端只删 >15d 的；结果如实回报（清了几条 / 失败原因）。 */
  const purge = () => {
    setPurging(true);
    void api
      .purgeTrash()
      .then(({ purged }) => {
        setFeedback({
          tone: "ok",
          text: purged > 0 ? `已彻底清除 ${purged} 条（超过 15 天）` : "没有超过 15 天的条目可清理",
        });
      })
      .catch(() => {
        setFeedback({ tone: "error", text: "清理失败——没有删除任何内容，请稍后重试" });
      })
      .finally(() => {
        setPurging(false);
        setConfirming(false);
        onRefresh();
      });
  };

  if (rows.length === 0) {
    return (
      <div className="px-4 py-8">
        {/* 清理结果可能在列表清空的同时产生（全清光/全失败）——先于空态渲染，不能被吞 */}
        {feedback !== null && (
          <p
            className={cn(
              "mb-3 rounded-md border px-3 py-2 text-sm",
              feedback.tone === "error"
                ? "border-danger/40 bg-danger-soft text-danger"
                : "border-line bg-canvas text-ink-muted",
            )}
          >
            {feedback.text}
          </p>
        )}
        <p className="text-sm text-ink-muted">回收站是空的——删掉的信息会先落到这，可恢复</p>
      </div>
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
      {feedback !== null && (
        <p
          className={cn(
            "mb-3 rounded-md border px-3 py-2 text-sm",
            feedback.tone === "error"
              ? "border-danger/40 bg-danger-soft text-danger"
              : "border-line bg-canvas text-ink-muted",
          )}
        >
          {feedback.text}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {rows.map((r) => {
          const { item } = r;
          return (
            <li
              key={item.id}
              className={cn(
                // 同通知页：默认卡片底（surface），点开压深到 canvas（暗色下转深黑）
                "group relative cursor-pointer overflow-hidden rounded-md border border-line bg-surface py-2 pl-5 pr-3 hover:bg-canvas",
                expandedId === item.id && "bg-canvas",
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
                      void api
                        .restore(item.id)
                        .then(() => {
                          setFeedback(null);
                          onRefresh();
                        })
                        .catch(() => {
                          setFeedback({
                            tone: "error",
                            text: "恢复失败——这条仍在回收站，请稍后重试",
                          });
                          onRefresh();
                        });
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
