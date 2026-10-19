import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  relativeDueText,
  sourceIdentityLabel,
  sourceLabelOf,
  FIXED_LABELS,
  type GetItemResult,
  type RawInput,
  dueDateElement,
  elementSubject,
} from "@summarizing/shared";

/** 推断披露的哨兵键（与自由元素 label 共用 openQuotes 键空间——带 @ 前缀避撞）。 */
const DDL_NOTE_KEY = "@ddl-note";

/** 版本史的动作名 → 人话（后端存内部枚举，此处面向用户翻译；未收录的原样显示）。 */
const ACTION_LABELS: Record<string, string> = {
  create_item: "新建",
  update_item: "修改",
  resolve_doubt: "解除存疑",
  complete_item: "标完成",
  reopen_item: "恢复待办",
  trash_item: "删除",
  restore_item: "从回收站恢复",
  digest_note: "留痕",
  // archive_item：007 前的归档动作——存量版本链里有，历史如实显示（无本条则回落原始 action 串）
  archive_item: "归档",
};
import { api } from "../../api";
import { cn } from "../../lib/cn";
import { fmtFullTime } from "../../lib/time";
import { QuoteOverlay } from "./QuoteOverlay";

/** 事项展开体（D-80 手风琴内容）：基本信息开 / 信息元素平铺引文收 / 版本史收只显计数。
 *  滚动四铁规（内滚隔离/sticky/70vh）由父级的展开容器承担，这里只管内容。 */
export function ItemBody({
  id,
  variant = "default",
}: {
  id: string;
  /** default = 看板展开体（小节标题 + 分界线齐全）；reader = 通知主卡（无分界线与小节标题，
   *  空的基本信息不渲染，统一 16px 间距的扁平流——用户 2026-10-19）。 */
  variant?: "default" | "reader";
}) {
  const [detail, setDetail] = useState<GetItemResult | null>(null);
  const [openQuotes, setOpenQuotes] = useState<readonly string[]>([]);
  const [openSources, setOpenSources] = useState<readonly string[]>([]);
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

  /** 切换某来源的展开（与元素行同款手势：默认收起、点行开/合——用户 2026-10-14）。 */
  const toggleSource = (key: string) => {
    setOpenSources((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
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
  // 元素区只放自由元素——固定元素（name/dueDate/summary）各有专门位置：name 是标题、summary 与
  // dueDate 在基本信息区（[ddl]）。filter 用 FIXED_LABELS 单一出处（手写字面量会漏改——D-64 警告的脆弱点）。
  const freeElements = item.elements.filter((e) => !FIXED_LABELS.some((l) => l === e.label));
  const summaryElement = item.elements.find((e) => e.label === "summary");
  const summaryEvidence = summaryElement === undefined ? [] : evidenceFor("summary");
  // 来源信息：逐批次铺开（一行 = 一个进站批次，**不按身份串去重/合并**——见 collectSources，用户 2026-10-14）；
  // 一个事项的证据可跨多批次/多来源，全部如实列出
  const sources = collectSources(detail);
  /** 阅读器形态：通知主卡里少几层标题——只留内容本身（用户 2026-10-19：聚焦内容太多）。 */
  const isReader = variant === "reader";
  /** 基本信息块只在有内容时渲染：事项（ddl 行）或有 summary；通知没 summary 时整块不出现。 */
  const showBasic = item.kind === "task" || summaryElement !== undefined;

  return (
    // fit-text：元素/来源/引文里的长 URL 在框内断行（不溢出框线）——单点挂容器，内部全生效
    <div className={cn("fit-text", isReader ? "text-[13px]" : "text-sm")}>
      {showBasic && (
        <div className={isReader ? "mt-4 px-6" : "p-3"}>
          {!isReader && <h3 className="text-sm font-semibold">基本信息</h3>}
          {/* 通知无 ddl（结构上就没有 dueDate）——不渲染 [ddl] 行（同 executor 摘要口径：
            对通知说「未知/日期未知」是噪声，D-106） */}
          {item.kind === "task" && (
            <>
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
            </>
          )}
          {summaryElement !== undefined && (
            <div className="mt-2">
              <p
                className={cn(
                  isReader ? "text-[13px]" : "text-sm",
                  summaryEvidence.length > 0 && "cursor-pointer",
                )}
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
      )}

      {(freeElements.length > 0 || !isReader) && (
        <div className={isReader ? "mt-4 px-6" : "border-t border-line p-3"}>
          {!isReader && (
            <h3 className="text-sm font-semibold">
              信息元素{" "}
              <span className="ml-1 text-xs font-normal text-ink-muted">{freeElements.length}</span>
            </h3>
          )}
          {freeElements.length === 0 && (
            <p className="mt-2 text-xs text-ink-muted">
              暂无——对前台说话即可补充（agent0 自主归类，无需表单）
            </p>
          )}
          {freeElements.map((el) => {
            const evidence = evidenceFor(el.label);
            const open = openQuotes.includes(el.label);
            return (
              <div key={el.label} className={isReader ? "mt-4 first:mt-0" : "mt-3"}>
                {/* 点元素行 = 展开/收起该元素的引文（引文是唯一折叠层，D-80） */}
                <p
                  className={cn(
                    isReader ? "text-[13px]" : "text-sm",
                    evidence.length > 0 && "cursor-pointer",
                  )}
                  onClick={() => {
                    if (evidence.length > 0) toggleQuotes(el.label);
                  }}
                >
                  <b className="text-ink-muted">[{el.label}]</b> {el.text}
                  {(evidence.length > 0 || !isReader) && (
                    <span
                      className={
                        evidence.length > 0 ? "text-xs text-accent" : "text-xs text-ink-muted"
                      }
                    >
                      {" "}
                      · 证据({evidence.length})
                    </span>
                  )}
                </p>
                {open && <Quotes detail={detail} evidence={evidence} onOpenQuote={setQuote} />}
              </div>
            );
          })}
        </div>
      )}

      {sources.length > 0 && (
        <div className={isReader ? "mt-4 px-6" : "border-t border-line p-3"}>
          {/* 阅读器不标「来源信息」小节——扁平流里 [信源类型] 行自解释（用户 2026-10-19） */}
          {!isReader && (
            <h3 className="text-sm font-semibold">
              来源信息{" "}
              <span className="ml-1 text-xs font-normal text-ink-muted">{sources.length}</span>
            </h3>
          )}
          {sources.map((src) => {
            const open = openSources.includes(src.raw.id);
            return (
              <div key={src.raw.id} className={isReader ? "mt-4 first:mt-0" : "mt-3"}>
                {/* 收起态行 = [信源类型] sourceLabel（用户 2026-10-14 定：nc 放最前、不放别的）。
                    点行展开/收起——手势与元素行同款；行与批次一一对应，同标签多批次 = 多行 */}
                <p
                  className={cn("cursor-pointer", isReader ? "text-[13px]" : "text-sm")}
                  onClick={() => toggleSource(src.raw.id)}
                >
                  <b className="text-ink-muted">[{src.raw.sourceType}]</b>{" "}
                  {sourceLabelOf(src.raw.sourceIdentity)}
                </p>
                {/* 展开区（引文同款左缘缩进线）：① 除保留键外的其余自由键逐条成行；
                    ② 本批次自身一行，行内「看原文」直达该批次原文浮窗 */}
                {open && (
                  <>
                    {src.entries.map(([k, v]) => (
                      <blockquote
                        key={k}
                        className="mt-1 border-l-2 border-line pl-2 text-xs text-ink-muted"
                      >
                        <b>[{k}]</b> {v}
                      </blockquote>
                    ))}
                    <blockquote className="mt-1 border-l-2 border-line pl-2 text-xs text-ink-muted">
                      <b>[批次]</b> {src.raw.id.slice(0, 6)} · {fmtFullTime(src.raw.receivedAt)}
                      {" · "}
                      <button
                        className="text-accent hover:underline"
                        onClick={() => setQuote({ raw: src.raw, text: "" })}
                      >
                        看原文
                      </button>
                    </blockquote>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className={isReader ? "mt-4 px-6 pb-4" : "border-t border-line p-3"}>
        <button
          className={cn(
            "flex w-full items-center gap-2 text-left",
            isReader ? "text-[11px] text-ink-muted" : "font-semibold",
          )}
          onClick={() => setVersionsOpen(!versionsOpen)}
        >
          {versionsOpen ? (
            <ChevronDown size={14} className="text-ink-muted" />
          ) : (
            <ChevronRight size={14} className="text-ink-muted" />
          )}
          编辑列表（版本史）
          <span className={cn("font-normal text-ink-muted", isReader ? "text-[11px]" : "text-xs")}>
            {detail.versions.length}
          </span>
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

/** 来源信息行：**一个进站批次 = 一行**（用户 2026-10-14 定）——raw 即行本体（行键 = raw.id），entries 是它的派生展示。 */
interface SourceRow {
  raw: RawInput; // 本行对应的批次（展开区自由键与「看原文」都由它派生）
  entries: [string, string][]; // 除 sourceLabel 外的自由键值对（键按字典序稳定）
}

/** 从事项详情的证据批次逐批次铺开来源行（用户 2026-10-14 加「来源信息」栏）。
 *  **不按身份串合并**——哪些键逐批变化（如 sender 时有时无）是适配器的形状知识，前端不假设；
 *  同一来源进来了几个批次就几行（新批次在前），各自展开各见各的自由键与原文。 */
function collectSources(detail: GetItemResult): SourceRow[] {
  return Object.values(detail.rawInputs)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .map((raw) => {
      // 自由键值对（除保留键 sourceLabel）——值转字符串展示，键按字典序稳定排序（同一批次每次渲染一致）
      const entries = Object.entries(raw.sourceIdentity)
        .filter(([k]) => k !== "sourceLabel")
        .map(([k, v]): [string, string] => [
          k,
          typeof v === "string" || typeof v === "number" || typeof v === "boolean"
            ? String(v)
            : JSON.stringify(v),
        ])
        .sort(([a], [b]) => a.localeCompare(b));
      return { raw, entries };
    });
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
