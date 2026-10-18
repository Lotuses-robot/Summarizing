import {
  applyTagChanges,
  ElementSchema,
  ChangeListSchema,
  quoteHasLinkPlaceholder,
  MULTIMODAL_IMAGE_TAG,
  type ChangeItem,
  type ChangeList,
  type Item,
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

/** 分类轴的 ddl 形状约束（007 FR-003/FR-014）：通知（notice）必无 dueDate 元素。
 *  `patchElements` = 本次变更带的元素（create 时即全部元素；update 时是被改的那几个 label）；
 *  `currentElements` = 该条当前已有元素（create 时为 null——没有"既有"可言）。
 *  判据落在**改动应用后的元素集**上——元素只增改不删，故 task 已带 dueDate 时转 notice 无从删掉它 → 拒。 */
function checkKindDdl(
  kind: Item["kind"],
  patchElements: { label: string }[],
  currentElements: { label: string }[] | null,
): string | null {
  // task 侧无额外形状要求：dueDate 元素可缺席（= 日期未知）。"可留空"在结构上就是「没有这个元素」
  //（schema 里 dueDate 元素的 text 只能是墙钟串或 null，不会出现"空字符串元素"）。
  if (kind !== "notice") return null;
  const hasDue =
    patchElements.some((e) => e.label === "dueDate") ||
    (currentElements?.some((e) => e.label === "dueDate") ?? false);
  if (hasDue) {
    return "通知（kind=notice）不得含 dueDate 元素——通知无 ddl 是结构红线（整条拒收）";
  }
  return null;
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
      const kindErr = checkKindDdl(item.kind ?? "task", item.elements, null);
      if (kindErr !== null) return kindErr;
      return checkMultimodalTag(item.elements, item.tags);
    }
    case "update_item": {
      const current = repo.deriveItem(db, item.itemId);
      if (!current) {
        return `itemId 不存在: ${item.itemId}`;
      }
      // 回收站条目只读（007 OQ-12）：trashed 视为不可写——要改先恢复
      // （防 digest 竞态把已删条目悄悄改活/改内容）
      if (current.status === "trashed") {
        return `itemId 在回收站（trashed）：${item.itemId}——不可写，要改先从回收站恢复`;
      }
      // elements 不得动固定元素 name（改语义名走 create_item；防双 name 投毒）
      if (item.elements.some((e) => e.label === "name")) {
        return "update_item 不得修改 name 元素（语义名由创建时确定）";
      }
      for (const el of item.elements) {
        const err = checkElement(el);
        if (err !== null) return `元素 ${el.label} 不合法：${err}`;
        const quoteErr = checkQuotes(el, raw.content);
        if (quoteErr !== null) return quoteErr;
      }
      // 分类轴切换的 ddl 形状（007 FR-014）：按「改动应用后的元素集」判——
      // 元素只增改不删，故 task 已带 dueDate 时转 notice 无法满足「通知无 ddl」→ 整条拒。
      const kindErr = checkKindDdl(item.kind ?? current.kind, item.elements, current.elements);
      if (kindErr !== null) return kindErr;
      // 多模态强制按「改动应用后的标签集」判（读图内容并进已有事项时，改动 map 里带上「多模态/图片」即可）
      return checkMultimodalTag(item.elements, applyTagChanges(current.tags, item.tags));
    }
    case "resolve_doubt":
    case "complete_item": {
      const target = repo.deriveItem(db, item.itemId);
      if (!target) {
        return `itemId 不存在: ${item.itemId}`;
      }
      // 回收站条目只读（007 OQ-12）：trashed 视为不可写——要改先恢复
      if (target.status === "trashed") {
        return `itemId 在回收站（trashed）：${item.itemId}——不可写，要改先从回收站恢复`;
      }
      // 通知不参与完成演化（007 US2-2）：按 kind 判，不靠 status 白名单（通知 status 恒 todo）
      if (item.action === "complete_item" && target.kind === "notice") {
        return "通知（kind=notice）不参与完成演化——不得 complete_item";
      }
      return null;
    }
    case "record_note": {
      const target =
        item.targetType === "raw_input" ? undefined : repo.deriveItem(db, item.targetId);
      if (item.targetType === "raw_input") {
        if (!repo.getRawInput(db, item.targetId)) {
          return `targetId 不存在: ${item.targetId}`;
        }
        return null;
      }
      if (!target) {
        return `targetId 不存在: ${item.targetId}`;
      }
      // 回收站条目只读（007 OQ-12）
      if (target.status === "trashed") {
        return `targetId 在回收站（trashed）：${item.targetId}——不可写，要改先从回收站恢复`;
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

/** 多模态标签强制（D-104）：任一元素的引文含 `[]()` 占位（引自图片等非文本内容）→ 事项标签必须含
 *  「多模态/图片」，否则拒收。防「读了图却不标记」——保证读图内容在界面上可辨识（前端据此高亮）。 */
function checkMultimodalTag(elements: { quotes: string[] }[], tags: string[]): string | null {
  const citesPlaceholder = elements.some((el) => el.quotes.some(quoteHasLinkPlaceholder));
  if (citesPlaceholder && !tags.includes(MULTIMODAL_IMAGE_TAG)) {
    return `元素引文引用了图片/链接占位（[]()），事项标签必须含「${MULTIMODAL_IMAGE_TAG}」`;
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
