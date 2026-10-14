import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  relativeDueText,
  sourceIdentityLabel,
  sourceLabelOf,
  type GetItemResult,
  type RawInput,
  type SourceIdentity,
  dueDateElement,
  elementSubject,
} from "@summarizing/shared";

/** 推断披露的哨兵键（与自由元素 label 共用 openQuotes 键空间——带 @ 前缀避撞）。 */
const DDL_NOTE_KEY = "@ddl-note";

/** 版本史的动作名 → 人话（后端存内部枚举，此处面向用户翻译；未收录的原样显示）。 */
const ACTION_LABELS: Record<string, string> = {
  create_item: "新建",
  update_item: "修改",
  add_element: "补充元素",
  resolve_doubt: "解除存疑",
  complete_item: "标完成",
  reopen_item: "恢复待办",
  archive_item: "归档",
  unarchive_item: "撤回归档",
  record_note: "留痕",
  digest_note: "留痕",
};
import { api } from "../../api";
import { cn } from "../../lib/cn";
import { fmtFullTime } from "../../lib/time";
import { QuoteOverlay } from "./QuoteOverlay";

/** 事项展开体（D-80 手风琴内容）：基本信息开 / 信息元素平铺引文收 / 版本史收只显计数。
 *  滚动四铁规（内滚隔离/sticky/70vh）由父级的展开容器承担，这里只管内容。 */
export function ItemBody({ id }: { id: string }) {
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
  // 来源信息：从证据批次收集来源身份，按「来源类型 + 身份串」去重（弹性字典自由键，用户 2026-10-14）；
  // 一个事项的证据可跨多批次/多来源，全部如实列出
  const sources = collectSources(detail);

  return (
    <div className="text-sm">
      <div className="p-3">
        <h3 className="text-sm font-semibold">基本信息</h3>
        <p className="mt-2">
          <b className="text-ink-muted">[ddl]</b>{" "}
          {dueText !== null ? (
            <>
              {fmtFullTime(dueText)}
              {dueRelative !== null && (
                <span className="ml-1.5 text-xs text-ink-muted">（{dueRelative}）</span>
              )}
              {/* 「推断」= 行内后缀开关（与「· 证据(n)」同款，用户 2026-09-30 走查定）：
                  点开/收起说明文字（样式同引文块）。哨兵键带 @ 前缀——不与自由元素 label 撞键 */}
              {dueNote !== null && (
                <button
                  className="cursor-pointer text-xs text-accent hover:underline"
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
              <b className="text-ink-muted">[sum]</b> {summaryElement.text}
              {summaryEvidence.length > 0 && (
                <span className="text-xs text-accent"> · 证据({summaryEvidence.length})</span>
              )}
            </p>
            {openQuotes.includes("summary") && (
              <Quotes detail={detail} evidence={summaryEvidence} onOpenQuote={setQuote} />
            )}
          </div>
        )}
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

      {sources.length > 0 && (
        <div className="border-t border-line p-3">
          <h3 className="text-sm font-semibold">
            来源信息{" "}
            <span className="ml-1 text-xs font-normal text-ink-muted">{sources.length}</span>
          </h3>
          {sources.map((src, i) => (
            <div key={i} className="mt-2">
              {/* 与基本信息/信息元素统一为「[键] 值」行式（用户 2026-10-14）：
                  来源标签 → [信息来源]、类型 → [类型]，自由键值对按各自键名逐条成行 */}
              <p className="text-sm">
                <b className="text-ink-muted">[信息来源]</b> {sourceLabelOf(src.identity)}
              </p>
              <p className="mt-1 text-sm">
                <b className="text-ink-muted">[类型]</b> {src.sourceType}
              </p>
              {src.entries.map(([k, v]) => (
                <p key={k} className="mt-1 text-sm">
                  <b className="text-ink-muted">[{k}]</b> {v}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}

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
                  {v.id.slice(0, 6)} · {fmtFullTime(v.at)} · {v.by.actor}
                  {v.by.model ? ` · ${v.by.model}` : ""} · {ACTION_LABELS[v.action] ?? v.action}
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

/** 来源信息行：一个来源 = 类型 + 身份 + 铺开的自由键值对（sourceLabel 之外，键按字典序稳定）。 */
interface SourceRow {
  sourceType: string;
  identity: SourceIdentity;
  entries: [string, string][];
}

/** 从事项详情的证据批次收集去重来源（用户 2026-10-14 加「来源信息」栏）。
 *  一个事项的证据可来自多批次/多来源——全部如实列出（不合并成一条，不同来源=不同出处）。
 *  去重键 = 来源类型 + 完整身份串；`sourceLabel` 单列在行首，其余键铺成 entries（弹性字典自由键）。 */
function collectSources(detail: GetItemResult): SourceRow[] {
  const rows: SourceRow[] = [];
  const seen = new Set<string>();
  for (const raw of Object.values(detail.rawInputs)) {
    const key = `${raw.sourceType}::${sourceIdentityLabel(raw.sourceIdentity)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 自由键值对（除保留键 sourceLabel）——值转字符串展示，键按字典序稳定排序（同一来源每次渲染一致）
    const entries = Object.entries(raw.sourceIdentity)
      .filter(([k]) => k !== "sourceLabel")
      .map(([k, v]): [string, string] => [
        k,
        typeof v === "string" || typeof v === "number" || typeof v === "boolean"
          ? String(v)
          : JSON.stringify(v),
      ])
      .sort(([a], [b]) => a.localeCompare(b));
    rows.push({ sourceType: raw.sourceType, identity: raw.sourceIdentity, entries });
  }
  return rows;
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
