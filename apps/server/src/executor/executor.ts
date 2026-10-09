import crypto from "node:crypto";
import {
  ElementSchema,
  elementSubject,
  itemName,
  provenanceLabel,
  type ChangeItem,
  type Element,
  type ElementInput,
  type Provenance,
  type RawInput,
} from "@summarizing/shared";
import type { Db, DbOrTx } from "../storage/db";
import { runInTransaction } from "../storage/db";
import * as repo from "../storage/repo";
import { normalizeWallClock, nowLocalWallClock } from "../shared/time";

/** 独占执行器（01§4.10⑤）：合格项逐条落库+Replay；返回每项的人话说明供消化留痕。
 *  整批包在一个事务里——任一项抛错则全部回滚，避免「部分落笔 + 状态谎报失败」（原文仍在，可重跑）。
 *  「置已消化」也在同一事务内（S2 评审）：否则提交后、置状态前崩溃会让批次留 pending，
 *  被 L11 清扫标 failed 后重试 → create_item 重复建事项。
 *  ⚠️ markDigested=false 用于「清扫存疑库」等非消化场景：那时 raw 是**历史来源批次**，
 *  把它改写成 digested 会吞掉它的 failed/「未处理」告警（D-85 评审 H4）。 */
export function executeChanges(
  db: Db,
  raw: RawInput,
  items: ChangeItem[],
  by: Provenance,
  opts: { markDigested?: boolean } = {},
): { details: string[] } {
  const markDigested = opts.markDigested ?? true;
  // 必须用事务句柄 tx（不是外层 db），否则写入不走事务、回滚失效
  return runInTransaction(db, (tx) => {
    const result = applyChanges(tx, raw, items, by);
    if (markDigested) repo.setDigestState(tx, raw.id, "digested");
    return result;
  });
}

/** 事务内的逐项落笔（由 executeChanges 包事务调用；传入的是事务句柄）。 */
function applyChanges(
  tx: DbOrTx,
  raw: RawInput,
  items: ChangeItem[],
  by: Provenance,
): {
  details: string[];
} {
  const details: string[] = [];
  for (const item of items) {
    switch (item.action) {
      case "create_item": {
        const elements = buildElements(item.elements);
        const itemId = newItemId();
        repo.appendItemVersion(tx, {
          itemId,
          action: "create_item",
          detail: describe(elements, item.tags, item.doubtNote),
          snapshot: {
            elements,
            tags: item.tags,
            status: "todo",
            doubtNote: item.doubtNote,
          },
          by,
        });
        attachElementEvidence(tx, raw, itemId, item.elements, by);
        details.push(describe(elements, item.tags, item.doubtNote));
        break;
      }
      case "update_item": {
        const current = repo.deriveItem(tx, item.itemId);
        if (!current) throw new Error(`item not found: ${item.itemId}`); // 围栏已验，双保险
        // 空 setElements 且不解除存疑 → 无任何变化，不落无意义版本（版本链只增，噪声要控）
        if (item.setElements.length === 0 && !item.resolveDoubt) {
          break;
        }
        const elements = upsertElements(current.elements, item.setElements);
        repo.appendItemVersion(tx, {
          itemId: current.id,
          action: "update_item",
          detail: `更新事项「${itemName(elements)}」：${item.setElements
            .map((e) => e.label)
            .join("、")}`,
          snapshot: {
            elements,
            tags: current.tags,
            status: current.status,
            doubtNote: item.resolveDoubt ? null : current.doubtNote,
          },
          by,
        });
        attachElementEvidence(tx, raw, current.id, item.setElements, by);
        details.push(`更新事项「${itemName(elements)}」`);
        break;
      }
      case "add_element": {
        const current = repo.deriveItem(tx, item.itemId);
        if (!current) throw new Error(`item not found: ${item.itemId}`); // 围栏已验，双保险
        const element = buildElement(item.element);
        repo.appendItemVersion(tx, {
          itemId: current.id,
          action: "add_element",
          detail: `补充元素「${element.label}」：${element.text}`,
          snapshot: {
            elements: [...current.elements, element],
            tags: current.tags,
            status: current.status,
            doubtNote: current.doubtNote,
          },
          by,
        });
        attachElementEvidence(tx, raw, current.id, [item.element], by);
        details.push(`「${itemName(current.elements)}」补充元素「${element.label}」`);
        break;
      }
      case "resolve_doubt": {
        const current = repo.deriveItem(tx, item.itemId);
        if (!current) throw new Error(`item not found: ${item.itemId}`);
        repo.appendItemVersion(tx, {
          itemId: current.id,
          action: "resolve_doubt",
          detail: `解除存疑：${item.note}`,
          snapshot: {
            elements: current.elements,
            tags: current.tags,
            status: current.status,
            doubtNote: null,
          },
          by,
        });
        details.push(`「${itemName(current.elements)}」解除存疑`);
        break;
      }
      case "complete_item": {
        const current = repo.deriveItem(tx, item.itemId);
        if (!current) throw new Error(`item not found: ${item.itemId}`);
        repo.appendItemVersion(tx, {
          itemId: current.id,
          action: "complete_item",
          detail: `标完成「${itemName(current.elements)}」`,
          snapshot: {
            elements: current.elements,
            tags: current.tags,
            status: "done",
            doubtNote: current.doubtNote,
          },
          by,
        });
        details.push(`「${itemName(current.elements)}」标完成`);
        break;
      }
      case "record_note": {
        // item 级留痕 = 该事项历史上的一条记录；raw_input 级 = 批次审计
        if (item.targetType === "item") {
          const current = repo.deriveItem(tx, item.targetId);
          if (!current) {
            // 围栏已拦；双保险：降级为批次审计留痕，不因一条坏 target 回滚整批
            repo.appendRawAudit(tx, {
              rawInputId: raw.id,
              action: "digest_note",
              detail: `${item.note}（目标事项 ${item.targetId} 不存在，降级为批次留痕）`,
              by,
            });
            details.push(`留痕（目标缺失）：${item.note}`);
            break;
          }
          repo.appendItemVersion(tx, {
            itemId: current.id,
            action: "digest_note",
            detail: item.note,
            snapshot: {
              elements: current.elements,
              tags: current.tags,
              status: current.status,
              doubtNote: current.doubtNote,
            },
            by,
          });
        } else {
          repo.appendRawAudit(tx, {
            rawInputId: item.targetId,
            action: "digest_note",
            detail: item.note,
            payload: { sourceBatchId: raw.id },
            by,
          });
        }
        details.push(`留痕：${item.note}`);
        break;
      }
      case "park_uncertain": {
        // 拿不准的信息入存疑信息库（D-85）：信源快照从当批自动带；批次引用可回溯原文。
        repo.insertUncertainInput(tx, {
          content: item.content,
          sourceType: raw.sourceType,
          sourceIdentity: raw.sourceIdentity,
          eventTime: raw.eventTime,
          receivedAt: raw.receivedAt,
          originRawInputId: raw.id,
          needsHuman: item.needsHuman,
          reason: item.reason,
          createdAt: nowLocalWallClock(),
        });
        details.push(`入存疑库（需人工 ${item.needsHuman}）：${item.content}`);
        break;
      }
      case "resolve_uncertain": {
        // 库条目处置（D-85）：merged = 已合并进事项/批次；discarded = 已丢弃。两者都记审计。
        // 仅 open 可处置（repo 原子前置）。命中 0 行有两种可能，要分开处理：
        //   ① 条目已被并发处置（清扫与消化撞上）→ 跳过（幂等，不炸整批——否则同批合法变更陪葬）
        //   ② 条目根本不存在 → 围栏本该拦，是双保险漏洞 → 抛错
        const existed = repo.getUncertainInput(tx, item.id) !== null;
        const ok = repo.resolveUncertainInput(tx, {
          id: item.id,
          status: item.outcome,
          resolvedRef: item.resolvedRef ?? null,
          resolvedAt: nowLocalWallClock(),
        });
        if (!ok) {
          if (existed) {
            details.push(`存疑条目已由别处处置，跳过：${item.note}`); // 并发/重复处置，幂等跳过
            break;
          }
          throw new Error(`uncertain not found: ${item.id}`); // 围栏已验，双保险
        }
        repo.appendRawAudit(tx, {
          rawInputId: raw.id,
          action: "uncertain_resolved",
          detail: `${item.outcome === "merged" ? "合并" : "丢弃"}存疑条目：${item.note}`,
          payload: { uncertainId: item.id, outcome: item.outcome },
          by,
        });
        details.push(`存疑条目已${item.outcome === "merged" ? "合并" : "丢弃"}：${item.note}`);
        break;
      }
    }
  }
  return { details };
}

/** 把变更清单的元素输入落成 Element（校验+规范化：dueDate 补本地午夜等）。 */
function buildElements(inputs: ElementInput[]): Element[] {
  return inputs.map(buildElement);
}

/** 单元素构造+校验（抛错版，供 upsert/单个场景复用）。 */
function buildElement(e: ElementInput): Element {
  const parsed = ElementSchema.safeParse({
    label: e.label,
    text: e.label === "dueDate" ? normalizeWallClock(e.text) : e.text,
    note: e.note ?? null,
  });
  if (!parsed.success) {
    throw new Error(`元素不合法（${e.label}）：${parsed.error.issues[0]?.message ?? "未知"}`);
  }
  return parsed.data;
}

/** 按 label 覆盖/新增元素（update_item 的 setElements 语义）。 */
function upsertElements(current: Element[], sets: ElementInput[]): Element[] {
  const next = current.map((el) => ({ ...el }));
  for (const set of sets) {
    const built = buildElement(set);
    const idx = next.findIndex((el) => el.label === set.label);
    if (idx >= 0) next[idx] = built;
    else next.push(built);
  }
  return next;
}

/** create/update 事项的证据落地：每个元素的引文入片段池（去重），subject=元素:<label>（D-62）。 */
function attachElementEvidence(
  db: Parameters<typeof repo.getOrCreateFragment>[0],
  raw: RawInput,
  itemId: string,
  inputs: { label: string; quotes: string[] }[],
  by: Provenance,
): void {
  for (const input of inputs) {
    for (const quote of input.quotes) {
      const fragment = repo.getOrCreateFragment(db, quote, raw.id);
      // 来源指针指向批次（RawInput）——粘贴源的原文就在批次里
      repo.addEvidence(db, {
        itemId,
        subject: elementSubject(input.label),
        fragmentId: fragment.id,
        pointer: `raw_input:${raw.id}`,
        by: provenanceLabel(by), // 证据署名仍以字符串承载（captured_by TEXT）；版本署名为结构化
      });
    }
  }
}

/** 生成 create_item 的人话描述：ddl（含推断标注）+ 标签 + 存疑。 */
function describe(elements: Element[], tags: string[], doubtNote: string | null): string {
  const due = elements.find((e) => e.label === "dueDate"); // 与 shared 的 dueDateElement 同义（此处为局部元素数组，保持直查）
  const dateText =
    !due || due.text === ""
      ? "日期未知"
      : `ddl ${due.text}${due.note ? `（推断：${due.note}）` : ""}`;
  const tagText = tags.length > 0 ? `；标签：${tags.join("、")}` : "";
  const doubtText = doubtNote !== null ? `；⚠ 存疑：${doubtNote}` : "";
  return `新建事项「${itemName(elements)}」${dateText}${tagText}${doubtText}`;
}

/** 新事项 id（版本链按 item_id 串起来）。 */
function newItemId(): string {
  return crypto.randomUUID();
}
