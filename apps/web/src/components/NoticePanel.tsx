import { useState } from "react";
import { Trash2 } from "lucide-react";
import { itemName, type NoticeRow } from "@summarizing/shared";
import { api } from "../api";
import { cn } from "../lib/cn";
import { ItemBody } from "./board/ItemBody";
import { fmtFullTime, fmtShortTime } from "../lib/time";

/** 通知页（007）：kind=notice 的独立查看入口——不用翻群就知道发生了什么。
 *  行 = 语义名 + 最近更新时间 + tags + 未读微标；点开 = 展开详情（复用 ItemBody：
 *  元素 + 证据链 + 来源信息一整套都在里面），点开即报已读。
 *  行右缘删除（一步进回收站、可恢复，OQ-8）；通知没有 ddl，故无任何时间追讨语义。 */
export function NoticePanel({
  notices,
  filter,
  onRefresh,
}: {
  notices: NoticeRow[];
  /** 与看板同款筛选谓词（tag + 文本——FilterBar 复用，不另造机制）。 */
  filter: (r: NoticeRow) => boolean;
  onRefresh: () => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [viewedLocally, setViewedLocally] = useState<ReadonlySet<string>>(new Set());
  /** 删除失败必须可见（红线「不许静默」）：失败时行还在，不给提示等于"点了没反应"。 */
  const [actionError, setActionError] = useState<string | null>(null);
  const visible = notices.filter(filter);

  /** 点开：单开互斥 + 首次展开即报已读（「新」微标点开即消，与看板同一节奏）。 */
  const toggle = (id: string) => {
    const next = expandedId === id ? null : id;
    setExpandedId(next);
    if (next !== null && !viewedLocally.has(id)) {
      setViewedLocally((cur) => new Set(cur).add(id));
      void api.viewed(id).catch(() => {
        // 报已读失败不阻塞阅读——下一轮轮询会带服务端状态回来（微标最坏多亮一轮）
      });
    }
  };

  if (visible.length === 0) {
    return (
      <p className="px-4 py-8 text-sm text-ink-muted">
        {notices.length === 0
          ? "还没有通知——群里发来的、不用你去做但值得知道的事会落到这"
          : "没有匹配的通知"}
      </p>
    );
  }

  return (
    <>
      {actionError !== null && (
        <p className="mx-4 mt-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
          {actionError}
        </p>
      )}
      <ul className="flex flex-col gap-2 px-4 py-3">
        {visible.map((r) => {
          const { item } = r;
          const isNew = !r.viewed && !viewedLocally.has(item.id);
          return (
            <li
              key={item.id}
              id={`row-${item.id}`}
              className={cn(
                // 默认 = 卡片底（surface：亮色近白、暗色浅灰），点开压深到 canvas（亮色转灰、暗色转深黑）
                // ——「抬起→按下」的触感，两套主题各自成立；常态细框、悬停略提
                "group relative cursor-pointer overflow-hidden rounded-md border border-line bg-surface py-2 pl-5 pr-3 hover:bg-canvas",
                expandedId === item.id && "bg-canvas",
              )}
              onClick={() => toggle(item.id)}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="min-w-0 truncate">{itemName(item.elements)}</span>
                {isNew && <span className="chip shrink-0 border-accent/50 text-accent">新</span>}
                {/* 来源徽标（FR-004 / US1-2）：一眼看出是哪个群/谁说的；无证据时不显示（不编造来源） */}
                {r.sourceLabel !== null && (
                  <span className="chip shrink-0 text-ink-muted">{r.sourceLabel}</span>
                )}
                {item.tags.map((t) => (
                  <span key={t} className="chip shrink-0 text-ink-muted">
                    {t}
                  </span>
                ))}
                <span className="ml-auto flex shrink-0 items-center gap-1 text-xs font-normal text-ink-muted">
                  {/* 列表行统一短格式（D-95 ③；完整时刻进 tooltip——与回收站同款） */}
                  <span title={`更新于 ${fmtFullTime(r.updatedAt)}`}>
                    {fmtShortTime(r.updatedAt)}
                  </span>
                  <button
                    className="row-act"
                    title="删除（进回收站，可恢复）"
                    onClick={(e) => {
                      e.stopPropagation();
                      void api
                        .trash(item.id)
                        .then(() => {
                          setActionError(null);
                          onRefresh();
                        })
                        .catch(() => {
                          setActionError("删除失败——这条还在，请稍后重试");
                          onRefresh();
                        });
                    }}
                  >
                    <Trash2 size={13} />
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
    </>
  );
}
