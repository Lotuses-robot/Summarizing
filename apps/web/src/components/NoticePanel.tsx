import { useEffect, useRef, useState } from "react";
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
  focus = null,
}: {
  notices: NoticeRow[];
  /** 与看板同款筛选谓词（tag + 文本——FilterBar 复用，不另造机制）。 */
  filter: (r: NoticeRow) => boolean;
  onRefresh: () => void;
  /** 对话 chips 深链（05§三）：展开并滚到该条；token 防轮询重放。 */
  focus?: { id: string; token: number } | null;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 本地已读：id → **标记时的 updatedAt**。只在同一次更新内抑制「新」与重复上报——
   *  内容被 agent0 更新后 updatedAt 变了，应重新亮「新」并允许再次报已读（OQ-11）。 */
  const [viewedLocally, setViewedLocally] = useState<ReadonlyMap<string, string>>(new Map());
  /** 删除失败必须可见（红线「不许静默」）：失败时行还在，不给提示等于"点了没反应"。 */
  const [actionError, setActionError] = useState<string | null>(null);
  const visible = notices.filter(filter);

  /** 点开：单开互斥 + 首次展开即报已读（「新」微标点开即消，与看板同一节奏）。
   *  以 updatedAt 判定"本地已读"——内容更新后要重新报（OQ-11）。 */
  const toggle = (r: NoticeRow) => {
    const next = expandedId === r.item.id ? null : r.item.id;
    setExpandedId(next);
    if (next !== null && viewedLocally.get(r.item.id) !== r.updatedAt) {
      setViewedLocally((cur) => new Map(cur).set(r.item.id, r.updatedAt));
      void api.viewed(r.item.id).catch(() => {
        // 上报失败：**撤掉本地已读**——否则本地去重会抑制重试，未读徽标永久卡住；
        // 撤掉后再次展开即重报（阅读本身不受影响）
        setViewedLocally((cur) => {
          const copy = new Map(cur);
          copy.delete(r.item.id);
          return copy;
        });
      });
    }
  };

  /** 深链（05§三）：展开目标行 + **点开即报已读**（与手动点开同一语义，FR-016）并滚到位；
   *  token 防同一深链被轮询重放。行的 DOM id 与看板同款（row-<id>）。 */
  const handledToken = useRef(0);
  useEffect(() => {
    if (focus === null || focus.token === handledToken.current) return;
    handledToken.current = focus.token;
    setExpandedId(focus.id);
    const row = notices.find((r) => r.item.id === focus.id);
    if (row && viewedLocally.get(row.item.id) !== row.updatedAt) {
      setViewedLocally((cur) => new Map(cur).set(row.item.id, row.updatedAt));
      void api.viewed(row.item.id).catch(() => {
        setViewedLocally((cur) => {
          const copy = new Map(cur);
          copy.delete(row.item.id);
          return copy;
        });
      });
    }
    window.setTimeout(() => {
      document.getElementById(`row-${focus.id}`)?.scrollIntoView({ block: "center" });
    }, 60);
  }, [focus, notices, viewedLocally]);

  /** 错误条在空态之上渲染：删除失败常伴随列表变空，不能被「还没有通知」吞掉。 */
  const errorBanner =
    actionError === null ? null : (
      <p className="mx-4 mt-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
        {actionError}
      </p>
    );

  if (visible.length === 0) {
    return (
      <>
        {errorBanner}
        <p className="px-4 py-8 text-sm text-ink-muted">
          {notices.length === 0
            ? "还没有通知——群里发来的、不用你去做但值得知道的事会落到这"
            : "没有匹配的通知"}
        </p>
      </>
    );
  }

  return (
    <>
      {errorBanner}
      <ul className="flex flex-col gap-2 px-4 py-3">
        {visible.map((r) => {
          const { item } = r;
          const isNew = !r.viewed && viewedLocally.get(item.id) !== r.updatedAt;
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
              onClick={() => toggle(r)}
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
