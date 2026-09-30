import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  relativeDueText,
  sourceIdentityLabel,
  sourceLabelOf,
  type GetItemResult,
  type RawInput,
  dueDateElement,
  elementSubject,
} from "@summarizing/shared";

/** 推断披露的哨兵键（与自由元素 label 共用 openQuotes 键空间——带 @ 前缀避撞）。 */
const DDL_NOTE_KEY = "@ddl-note";
import { api } from "../../api";
import { cn } from "../../lib/cn";
import { QuoteOverlay } from "./QuoteOverlay";

/** 事项展开体（D-80 手风琴内容）：基本信息开 / 信息元素平铺引文收 / 版本史收只显计数。
 *  滚动四铁规（内滚隔离/sticky/70vh）由父级的展开容器承担，这里只管内容。 */
export function ItemBody({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<GetItemResult | null>(null);
  const [openQuotes, setOpenQuotes] = useState<readonly string[]>([]);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [quote, setQuote] = useState<{ raw: RawInput; text: string } | null>(null);
  const [failed, setFailed] = useState(false);

  /** 重新拉取当前事项（手动操作后调用，立即反映新状态）。 */
  const reload = useCallback(() => {
    api
      .item(id)
      .then((d) => {
        setDetail(d);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [id]);

  useEffect(() => {
    reload();
  }, [reload]);

  /** 包一层手动操作：完成后刷新详情 + 通知外层刷看板；失败也重拉详情（让页面如实呈现现状）。 */
  const act = (p: Promise<unknown>) => {
    void p
      .then(() => {
        reload();
        onChanged();
      })
      .catch(() => reload());
  };

  /** 切换某元素的引文展开（引文是唯一的折叠层，D-80）。 */
  const toggleQuotes = (label: string) => {
    setOpenQuotes((cur) =>
      cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
    );
  };

  if (failed) {
    return (
      <p className="p-3 text-sm text-ink-muted">
        详情没拉下来（后端在跑吗？）
        <button className="btn ml-2" onClick={reload}>
          重试
        </button>
      </p>
    );
  }
  if (detail === null) {
    return <p className="p-3 text-sm text-ink-muted">加载中…</p>;
  }

  const { item } = detail;
  const dueElement = dueDateElement(item);
  const dueText = dueElement?.text ?? null;
  const dueNote = dueElement?.note ?? null;
  // 相对时间随本次渲染算（打开详情的一瞬是「现在」）
  const dueRelative = dueText === null ? null : relativeDueText(dueText, new Date());
  /** 某元素名下的证据（subject 由 shared 的 elementSubject 收敛，D-62）。 */
  const evidenceFor = (label: string) =>
    detail.evidence.filter((e) => e.subject === elementSubject(label));
  // 摘要在基本信息区展示（用户 2026-09-26：与元素区重复）；ddl 同理。元素区只放自由元素
  const freeElements = item.elements.filter((e) => e.label !== "name" && e.label !== "summary");
  const summaryElement = item.elements.find((e) => e.label === "summary");
  const summaryEvidence = summaryElement === undefined ? [] : evidenceFor("summary");

  return (
    <div className="text-sm">
      <div className="p-3">
        <h3 className="text-sm font-semibold">基本信息</h3>
        <p className="mt-2">
          ddl：
          {dueText !== null ? (
            <>
              {new Date(dueText).toLocaleString()}
              {dueRelative !== null && (
                <span className="ml-1.5 text-xs text-ink-muted">（{dueRelative}）</span>
              )}
              {/* 「推断」= 行内后缀开关（与「· 证据(n)」同款，用户 2026-09-30 走查定）：
                  点开/收起说明文字（样式同引文块）。哨兵键带 @ 前缀——不与自由元素 label 撞键 */}
              {dueNote !== null && (
                <button
                  className="cursor-pointer text-xs text-info hover:underline"
                  onClick={() => toggleQuotes(DDL_NOTE_KEY)}
                >
                  {" "}
                  · 推断
                </button>
              )}
            </>
          ) : (
            <span className="text-ink-muted">未知</span>
          )}
        </p>
        {dueNote !== null && openQuotes.includes(DDL_NOTE_KEY) && (
          <blockquote className="mt-1 border-l-2 border-line pl-2 text-xs text-ink-muted">
            {dueNote}
          </blockquote>
        )}
        {summaryElement !== undefined && (
          <div className="mt-2">
            <p
              className={cn("text-sm", summaryEvidence.length > 0 && "cursor-pointer")}
              onClick={() => {
                if (summaryEvidence.length > 0) toggleQuotes("summary");
              }}
            >
              {summaryElement.text}
              {summaryEvidence.length > 0 && (
                <span className="text-xs text-accent"> · 证据({summaryEvidence.length})</span>
              )}
            </p>
            {openQuotes.includes("summary") && (
              <Quotes detail={detail} evidence={summaryEvidence} onOpenQuote={setQuote} />
            )}
          </div>
        )}
        <div className="mt-3 flex gap-2">
          {item.status === "todo" && (
            <button className="btn btn-accent" onClick={() => act(api.complete(item.id))}>
              标完成
            </button>
          )}
          {item.status !== "archived" && (
            <button className="btn" onClick={() => act(api.archive(item.id))}>
              归档
            </button>
          )}
          {item.status !== "todo" && (
            <button className="btn" onClick={() => act(api.reopen(item.id))}>
              {item.status === "archived" ? "撤回归档" : "恢复待办"}
            </button>
          )}
        </div>
      </div>

      <div className="border-t border-line p-3">
        <h3 className="text-sm font-semibold">
          信息元素{" "}
          <span className="ml-1 text-xs font-normal text-ink-muted">{freeElements.length}</span>
        </h3>
        {freeElements.length === 0 && (
          <p className="mt-2 text-xs text-ink-muted">
            暂无——对前台说话即可补充（agent0 自主归类，无需表单）
          </p>
        )}
        {freeElements.map((el) => {
          const evidence = evidenceFor(el.label);
          const open = openQuotes.includes(el.label);
          return (
            <div key={el.label} className="mt-3">
              {/* 点元素行 = 展开/收起该元素的引文（引文是唯一折叠层，D-80） */}
              <p
                className={cn("text-sm", evidence.length > 0 && "cursor-pointer")}
                onClick={() => {
                  if (evidence.length > 0) toggleQuotes(el.label);
                }}
              >
                <b className="text-ink-muted">[{el.label}]</b> {el.text}
                <span
                  className={evidence.length > 0 ? "text-xs text-accent" : "text-xs text-ink-muted"}
                >
                  {" "}
                  · 证据({evidence.length})
                </span>
              </p>
              {open && <Quotes detail={detail} evidence={evidence} onOpenQuote={setQuote} />}
            </div>
          );
        })}
      </div>

      <div className="border-t border-line p-3">
        <button
          className="flex w-full items-center gap-2 text-left font-semibold"
          onClick={() => setVersionsOpen(!versionsOpen)}
        >
          {versionsOpen ? (
            <ChevronDown size={14} className="text-ink-muted" />
          ) : (
            <ChevronRight size={14} className="text-ink-muted" />
          )}
          编辑列表（版本史）
          <span className="text-xs font-normal text-ink-muted">{detail.versions.length}</span>
        </button>
        {versionsOpen && (
          <ul className="mt-2 space-y-2">
            {detail.versions.map((v) => (
              <li key={v.id}>
                <span className="text-xs text-ink-muted">
                  {v.id.slice(0, 6)} · {new Date(v.at).toLocaleString()} · {v.by.actor}
                  {v.by.model ? ` · ${v.by.model}` : ""} · {v.action}
                </span>
                <br />
                {v.detail}
              </li>
            ))}
          </ul>
        )}
      </div>

      {quote !== null && (
        <QuoteOverlay rawInput={quote.raw} quote={quote.text} onClose={() => setQuote(null)} />
      )}
    </div>
  );
}

/** 某元素的引文块：片段 + 批次短 id + 「看原文」悬浮窗入口（基本信息与元素区共用）。 */
function Quotes({
  evidence,
  detail,
  onOpenQuote,
}: {
  evidence: GetItemResult["evidence"];
  detail: GetItemResult;
  onOpenQuote: (q: { raw: RawInput; text: string }) => void;
}) {
  return (
    <>
      {evidence.map((ev) => {
        const frag = detail.fragments.find((f) => f.id === ev.fragmentId);
        const raw = frag === undefined ? null : (detail.rawInputs[frag.rawInputId] ?? null);
        return (
          <blockquote
            key={ev.id}
            className="mt-1 border-l-2 border-line pl-2 text-xs text-ink-muted"
          >
            {frag?.content ?? "（片段缺失）"}
            {frag !== undefined && (
              <span>
                （批次 {frag.rawInputId.slice(0, 6)}
                {raw !== null && (
                  <>
                    {" · "}
                    {/* 引文旁标来源（D-89 选 B）：显示裸 sourceLabel；hover 给完整身份串 */}
                    <span className="cursor-help" title={sourceIdentityLabel(raw.sourceIdentity)}>
                      {sourceLabelOf(raw.sourceIdentity)}
                    </span>
                    {" · "}
                    <button
                      className="text-accent hover:underline"
                      onClick={() => onOpenQuote({ raw, text: frag.content })}
                    >
                      看原文
                    </button>
                  </>
                )}
                ）
              </span>
            )}
          </blockquote>
        );
      })}
    </>
  );
}
