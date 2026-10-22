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
import { parseModelJsonDetailed, type ModelJsonParse } from "../shared/modelJson";

// 行为围栏（01§4.10④）：只查「行为」，不查「观点」。
// 硬拒收 = ID 不存在 / 动作不在白名单(zod schema) / 格式不完整(zod schema) / 引文非原文逐字（空白归一后比对）。
// 元素格式校验走 shared 的 ElementSchema（类型即校验，D-64 随 schema 收紧）——不再手写正则。

/** 围栏结果：接受/拒收两组（拒收项带原因，供修正轮回喂与留痕）。 */
export interface FenceResult {
  accepted: ChangeItem[];
  rejected: { item: ChangeItem; reason: string }[];
}

/** 批内投影状态：同一批里对同一条的多次改动，后续项必须按**前面已接受项应用后**的状态校验。
 *  （只按批前 DB 快照校验会被绕过：先 update kind=notice、再 update 加 dueDate → 通知带 ddl。） */
interface ProjectedState {
  kind: Item["kind"];
  hasDueDate: boolean;
  status: Item["status"];
}

/** 取某条的批内投影（没有则从 DB 派生一份**并记入 map**）；不存在返回 null。 */
function projectedOf(
  db: Db,
  id: string,
  projected: Map<string, ProjectedState>,
): ProjectedState | null {
  const p = projected.get(id);
  if (p !== undefined) return p;
  const current = repo.deriveItem(db, id);
  if (!current) return null;
  const state: ProjectedState = {
    kind: current.kind,
    hasDueDate: current.elements.some((e) => e.label === "dueDate"),
    status: current.status,
  };
  // 记入 map：后续 applyProjection 在同一对象上折叠已接受项的效果
  projected.set(id, state);
  return state;
}

/** 围栏主入口：逐项校验变更清单，产出「接受/拒收」两组（拒收带原因，01§4.10④）。 */
export function runFence(db: Db, raw: RawInput, list: ChangeList): FenceResult {
  const accepted: ChangeItem[] = [];
  const rejected: FenceResult["rejected"] = [];
  // 批内投影：与执行器同序应用，保证「同批多次改动」看到彼此的效果
  const projected = new Map<string, ProjectedState>();

  for (const item of list.changes) {
    const reason = checkItem(db, raw, item, projected);
    if (reason === null) {
      accepted.push(item);
      applyProjection(item, projected);
    } else {
      rejected.push({ item, reason });
    }
  }
  return { accepted, rejected };
}

/** 把一条已接受的变更折叠进投影（与执行器的落笔语义保持一致）。 */
function applyProjection(item: ChangeItem, projected: Map<string, ProjectedState>): void {
  switch (item.action) {
    case "update_item": {
      const p = projected.get(item.itemId);
      if (!p) return;
      const kind = item.kind ?? p.kind;
      projected.set(item.itemId, {
        kind,
        hasDueDate: p.hasDueDate || item.elements.some((e) => e.label === "dueDate"),
        // 与执行器一致：转 notice 时状态归一为 todo
        status: kind === "notice" ? "todo" : p.status,
      });
      return;
    }
    case "complete_item": {
      const p = projected.get(item.itemId);
      if (p) projected.set(item.itemId, { ...p, status: "done" });
      return;
    }
    // 其余动作不改 kind/元素/status，无需折叠进投影：
    // create_item 由执行器生成新 id（同批后续项无从引用）；resolve_doubt/record_note 只改留存字段；
    // park_uncertain/resolve_uncertain 不碰事项版本链。
    case "create_item":
    case "resolve_doubt":
    case "record_note":
    case "park_uncertain":
    case "resolve_uncertain":
      return;
  }
}

/** 同上，但失败时带回**具体原因**——digest 的纠正提示要告诉模型究竟哪里不合规
 *  （只说「不是合法 JSON」会让它原地重写同样的东西，实测连败六轮）。 */
export function parseChangeListDetailed(text: string): ModelJsonParse<ChangeList> {
  return parseModelJsonDetailed(text, ChangeListSchema);
}

/** 分类轴的 ddl 形状约束（007 FR-003/FR-014）：通知（notice）必无 dueDate 元素。
 *  `patchElements` = 本次变更带的元素（create 时即全部元素；update 时是被改的那几个 label）；
 *  `currentElements` = 该条当前已有元素（create 时为 null——没有"既有"可言）。
 *  判据落在**改动应用后的元素集**上——元素只增改不删，故 task 已带 dueDate 时转 notice 无从删掉它 → 拒。 */
function checkKindDdl(
  kind: Item["kind"],
  patchElements: { label: string }[],
  existingHasDueDate: boolean,
): string | null {
  // task 侧无额外形状要求：dueDate 元素可缺席（= 日期未知）。"可留空"在结构上就是「没有这个元素」
  //（schema 里 dueDate 元素的 text 只能是墙钟串或 null，不会出现"空字符串元素"）。
  if (kind !== "notice") return null;
  const hasDue = patchElements.some((e) => e.label === "dueDate") || existingHasDueDate;
  if (hasDue) {
    return "通知（kind=notice）不得含 dueDate 元素——通知无 ddl 是结构红线（整条拒收）";
  }
  return null;
}

/** 单项行为校验：ID 存在性 / 元素格式（ElementSchema）/ 语义名恰好一个 / 引文逐字；通过返回 null。
 *  `projected` = 批内投影（同批前面已接受项的效果），后续项按它校验而非只看 DB。 */
function checkItem(
  db: Db,
  raw: RawInput,
  item: ChangeItem,
  projected: Map<string, ProjectedState>,
): string | null {
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
      const kindErr = checkKindDdl(item.kind ?? "task", item.elements, false);
      if (kindErr !== null) return kindErr;
      return checkMultimodalTag(item.elements, item.tags);
    }
    case "update_item": {
      const current = repo.deriveItem(db, item.itemId);
      const state = projectedOf(db, item.itemId, projected);
      if (!current || !state) {
        return `itemId 不存在: ${item.itemId}`;
      }
      // 回收站条目只读（007 OQ-12）：trashed 视为不可写——要改先恢复
      // （防 digest 竞态把已删条目悄悄改活/改内容）；按批内投影判（同批前面可把它删了？不会——
      // 变更词表没有删除动作，这里用投影只为状态/种类一致性）
      if (state.status === "trashed") {
        return `itemId 在回收站（trashed）：${item.itemId}——不可写，要改先从回收站恢复`;
      }
      // 语义名**可以改**（用户 2026-10-22：「有些时候必须要改标题」——比如当初看错了对象、
      // 或者事情本身变了）。唯一的结构约束：一次只能给一个 name（upsert 按 label 覆盖，
      // 所以改完仍然恰好一个；给两个就是自相矛盾，拒收）。
      const names = item.elements.filter((e) => e.label === "name");
      if (names.length > 1) {
        return `update_item 的 elements 里 name 只能有一个（当前 ${names.length} 个）`;
      }
      for (const el of item.elements) {
        const err = checkElement(el);
        if (err !== null) return `元素 ${el.label} 不合法：${err}`;
        const quoteErr = checkQuotes(el, raw.content);
        if (quoteErr !== null) return quoteErr;
      }
      // 分类轴切换的 ddl 形状（007 FR-014）：按「改动应用后的元素集」判——
      // 元素只增改不删，故 task 已带 dueDate 时转 notice 无法满足「通知无 ddl」→ 整条拒。
      // ⚠️ 按**批内投影**判：同批先切 notice、再加 dueDate 的第二条必须被拒（否则绕过红线）。
      const kindErr = checkKindDdl(item.kind ?? state.kind, item.elements, state.hasDueDate);
      if (kindErr !== null) return kindErr;
      // 多模态强制按「改动应用后的标签集」判（读图内容并进已有事项时，改动 map 里带上「多模态/图片」即可）
      return checkMultimodalTag(item.elements, applyTagChanges(current.tags, item.tags));
    }
    case "resolve_doubt":
    case "complete_item": {
      const target = repo.deriveItem(db, item.itemId);
      const state = projectedOf(db, item.itemId, projected);
      if (!target || !state) {
        return `itemId 不存在: ${item.itemId}`;
      }
      // 回收站条目只读（007 OQ-12）：trashed 视为不可写——要改先恢复
      if (state.status === "trashed") {
        return `itemId 在回收站（trashed）：${item.itemId}——不可写，要改先从回收站恢复`;
      }
      // 通知不参与完成演化（007 US2-2）：按 kind 判，不靠 status 白名单（通知 status 恒 todo）；
      // 按批内投影判——同批先切成 notice、再 complete 的形态必须被拒。
      if (item.action === "complete_item" && state.kind === "notice") {
        return "通知（kind=notice）不参与完成演化——不得 complete_item";
      }
      return null;
    }
    case "record_note": {
      if (item.targetType === "raw_input") {
        if (!repo.getRawInput(db, item.targetId)) {
          return `targetId 不存在: ${item.targetId}（当前批次的 id 见【原始信息】的「批次 id」一行，逐字复制）`;
        }
        // 批次级留痕只属于正在消化的这一批（防把备注写到别的批次上——曾出现模型拿接收时间当 id）
        if (item.targetId !== raw.id) {
          return `record_note 的 raw_input 目标必须是本批（批次 id：${raw.id}）`;
        }
        return null;
      }
      const target = repo.deriveItem(db, item.targetId);
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
