import {
  ElementSchema,
  FIXED_LABELS,
  ChangeListSchema,
  type ChangeItem,
  type ChangeList,
  type RawInput,
} from "@summarizing/shared";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import { parseModelJson } from "../shared/modelJson";

// 行为围栏（01§4.10④）：只查「行为」，不查「观点」。
// 硬拒收 = ID 不存在 / 动作不在白名单(zod schema) / 格式不完整(zod schema) / 引文非原文逐字（空白归一后比对）。
// 元素格式校验走 shared 的 ElementSchema（类型即校验，D-64 随 schema 收紧）——不再手写正则。

/** 围栏结果：接受/拒收两组（拒收项带原因，供修正轮回喂与留痕）。 */
export interface FenceResult {
  accepted: ChangeItem[];
  rejected: { item: ChangeItem; reason: string }[];
}

/** 围栏主入口：逐项校验变更清单，产出「接受/拒收」两组（拒收带原因，01§4.10④）。 */
export function runFence(db: Db, raw: RawInput, list: ChangeList): FenceResult {
  const accepted: ChangeItem[] = [];
  const rejected: FenceResult["rejected"] = [];

  for (const item of list.changes) {
    const reason = checkItem(db, raw, item);
    if (reason === null) {
      accepted.push(item);
    } else {
      rejected.push({ item, reason });
    }
  }
  return { accepted, rejected };
}

/** 模型输出文本 → ChangeList；不合规返回 null（由调用方决定重试）。容错解析与 chat 共用 parseModelJson。 */
export function parseChangeList(text: string): ChangeList | null {
  return parseModelJson(text, ChangeListSchema);
}

/** 单项行为校验：ID 存在性 / 元素格式（ElementSchema）/ 语义名恰好一个 / 引文逐字；通过返回 null。 */
function checkItem(db: Db, raw: RawInput, item: ChangeItem): string | null {
  switch (item.action) {
    case "create_item": {
      const names = item.elements.filter((e) => e.label === "name");
      if (names.length !== 1) {
        return `create_item 必须恰好有一个 name 元素（当前 ${names.length} 个）`;
      }
      for (const el of item.elements) {
        const err = checkElement(el);
        if (err !== null) return `元素 ${el.label} 不合法：${err}`;
        const quoteErr = checkQuotes(el, raw.content);
        if (quoteErr !== null) return quoteErr;
      }
      return null;
    }
    case "update_item": {
      if (!repo.itemExists(db, item.itemId)) {
        return `itemId 不存在: ${item.itemId}`;
      }
      // setElements 不得动固定元素 name（改语义名走 create_item；防双 name 投毒）
      if (item.setElements.some((e) => e.label === "name")) {
        return "update_item 不得修改 name 元素（语义名由创建时确定）";
      }
      for (const el of item.setElements) {
        const err = checkElement(el);
        if (err !== null) return `元素 ${el.label} 不合法：${err}`;
        const quoteErr = checkQuotes(el, raw.content);
        if (quoteErr !== null) return quoteErr;
      }
      return null;
    }
    case "add_element": {
      if (!repo.itemExists(db, item.itemId)) {
        return `itemId 不存在: ${item.itemId}`;
      }
      // 不得补固定元素（name/dueDate/summary 走 update_item 的 setElements；防重复与冒名）
      const isFixed = FIXED_LABELS.some((l) => l === item.element.label);
      if (!isFixed) {
        const err = checkElement(item.element);
        if (err !== null) return err;
        return checkQuotes(item.element, raw.content);
      }
      return `add_element 不得补固定元素「${item.element.label}」（请用 update_item）`;
    }
    case "resolve_doubt":
    case "complete_item": {
      if (!repo.itemExists(db, item.itemId)) {
        return `itemId 不存在: ${item.itemId}`;
      }
      return null;
    }
    case "record_note": {
      const exists =
        item.targetType === "raw_input"
          ? repo.getRawInput(db, item.targetId)
          : repo.itemExists(db, item.targetId);
      if (!exists) {
        return `targetId 不存在: ${item.targetId}`;
      }
      return null;
    }
    case "park_uncertain": {
      // 无目标 id 可验；content/reason 非空与 needsHuman 范围由 zod schema 保证（D-85）
      return null;
    }
    case "resolve_uncertain": {
      if (repo.getUncertainInput(db, item.id) === null) {
        return `存疑条目不存在: ${item.id}`;
      }
      // merged 必须给去向（否则「合并到哪」无从回溯）——谓词与清扫围栏共用（单一出处）
      if (!resolveUncertainWellFormed(item)) {
        return "resolve_uncertain outcome=merged 时必须给 resolvedRef（合并去向）";
      }
      return null;
    }
  }
}

/** resolve_uncertain 的形状规则（与目标存在性无关的部分）：merged 必须给去向。
 *  digest 围栏与清扫围栏共用——规则一处定义，两侧不得漂移。 */
export function resolveUncertainWellFormed(item: {
  outcome: "merged" | "discarded";
  resolvedRef?: string;
}): boolean {
  return !(item.outcome === "merged" && (item.resolvedRef ?? "") === "");
}

/** 单个元素的格式校验（ElementSchema：dueDate 墙钟格式、name 非空等）。 */
function checkElement(el: { label: string; text: string; note?: string | null }): string | null {
  const parsed = ElementSchema.safeParse({
    label: el.label,
    text: el.text,
    note: el.note ?? null,
  });
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "元素格式不合法");
}

/** 引文逐字校验（空白归一后子串比对）：改写/幻觉的引文不得作为「原文快照」混入证据链。 */
function checkQuotes(el: { quotes: string[] }, rawContent: string): string | null {
  for (const quote of el.quotes) {
    if (!squeeze(rawContent).includes(squeeze(quote))) {
      const preview = quote.length > 20 ? `${quote.slice(0, 20)}…` : quote;
      return `引文不是原文逐字（空白归一后未命中）：「${preview}」——quotes 必须逐字摘自原文`;
    }
  }
  return null;
}

/** 空白归一：引文跨行、多空格等排版差异不构成改写。 */
function squeeze(text: string): string {
  return text.replace(/\s+/g, "");
}

/** 把拒收清单翻成可回喂给模型的文本（修正轮的输入）。 */
export function describeRejections(rejected: FenceResult["rejected"]): string {
  return rejected
    .map((r, i) => `${i + 1}. ${JSON.stringify(r.item)} —— 原因：${r.reason}`)
    .join("\n");
}
