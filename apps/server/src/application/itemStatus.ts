import type { Item } from "@summarizing/shared";
import { itemName } from "@summarizing/shared";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";

// 事项状态的手动写口（D-139）：浏览器端点（routes/items.ts）与对外 v1（routes/v1.ts）
// 共用同一份守卫与落笔逻辑。
//
// 为什么必须收敛到一处：两处各写一遍时**已经漂移过**——`trash` 有幂等守卫、`complete` 没有，
// 于是并发/重试会往版本链里堆重复的「标完成」。守卫不是路由的职责，是领域规则。

/** 手动状态动作（三个：标完成 / 恢复待办 / 进回收站）。 */
export type ManualAction = "complete_item" | "reopen_item" | "trash_item";

/** 失败原因（路由层按它映射 HTTP：404 / 409）。 */
export type ManualActionError = "not_found" | "trashed" | "notice" | "unrecoverable";

/** 动作 → 已处于目标状态时的判定（幂等：命中即不追加版本）。
 *
 *  `trash`/`complete`/`reopen` 都要幂等：网络超时后客户端重试是常规行为，
 *  非幂等就会在版本史里留下多条一模一样的记录（实测并发 5 次 complete 追加 5 个版本）。 */
function alreadyAt(item: Item, action: ManualAction): boolean {
  if (action === "complete_item") return item.status === "done";
  if (action === "reopen_item") return item.status === "todo";
  return item.status === "trashed";
}

/** 动作 → 版本链里的 detail 文案（用户在处理记录里看到的那行字）。 */
function detailOf(action: ManualAction, name: string): string {
  if (action === "complete_item") return `标完成「${name}」`;
  if (action === "reopen_item") return `恢复待办「${name}」`;
  return `删除「${name}」`;
}

/** 执行一次手动状态动作：守卫 → 追加版本节点 → 返回派生结果。
 *
 *  幂等语义：已处于目标状态时**原样返回、不写版本**（`trash` 一直是这么做的；
 *  `complete`/`reopen` 此前缺这道守卫，重试会堆重复版本）。
 *
 *  @param db 账户库
 *  @param id 事项 id
 *  @param action 三个动作之一
 *  @param by 署名（界面上区分「谁改的」：用户 / 外部接口）
 *  @param by.actor 谁（「用户」/「外部接口」）
 *  @param by.model 模型标识（手动操作为 null）
 */
export function manualSetStatus(
  db: Db,
  id: string,
  action: ManualAction,
  by: { actor: string; model: string | null },
): { ok: true; item: Item } | { ok: false; error: ManualActionError } {
  const item = repo.deriveItem(db, id);
  if (item === null) return { ok: false, error: "not_found" };
  // 回收站条目不可写（OQ-12）：要改先恢复
  if (item.status === "trashed" && action !== "trash_item") {
    return { ok: false, error: "trashed" };
  }
  // 通知恒待办，不参与完成演化（007 / US2-2）
  if (item.kind === "notice" && action !== "trash_item") {
    return { ok: false, error: "notice" };
  }
  // 幂等：已在目标状态 → 原样返回，不追加无意义版本
  if (alreadyAt(item, action)) return { ok: true, item };

  const status: Item["status"] =
    action === "complete_item" ? "done" : action === "reopen_item" ? "todo" : "trashed";
  repo.appendItemVersion(db, {
    itemId: id,
    action,
    detail: detailOf(action, itemName(item.elements)),
    snapshot: { ...item, status },
    by,
  });
  return { ok: true, item: repo.deriveItem(db, id) ?? item };
}

/** 从回收站恢复：status 回到删前的值（版本链取）。
 *
 *  与 `manualSetStatus` 分开：恢复的目标状态是从历史里查出来的，不是固定值。
 *  删前状态不可考（整条链全 trashed/异常）时**如实拒绝**，不编造 `todo`。
 *
 *  @param db 账户库
 *  @param id 事项 id
 *  @param by 署名
 *  @param by.actor 谁（「用户」/「外部接口」）
 *  @param by.model 模型标识（手动操作为 null）
 */
export function restoreFromTrash(
  db: Db,
  id: string,
  by: { actor: string; model: string | null },
): { ok: true; item: Item } | { ok: false; error: ManualActionError } {
  const item = repo.deriveItem(db, id);
  if (item === null) return { ok: false, error: "not_found" };
  // 幂等：不在回收站 → 原样返回
  if (item.status !== "trashed") return { ok: true, item };
  const restoring = repo.preTrashStatus(db, id);
  if (restoring === null) return { ok: false, error: "unrecoverable" };
  repo.appendItemVersion(db, {
    itemId: id,
    action: "restore_item",
    detail: `从回收站恢复「${itemName(item.elements)}」`,
    snapshot: { ...item, status: restoring },
    by,
  });
  return { ok: true, item: repo.deriveItem(db, id) ?? item };
}

/** 手动状态动作的错误 → HTTP 码与人话（两个路由组共用同一套文案）。
 *
 *  @param error 领域层给出的失败原因
 *  @returns 状态码与错误消息
 */
export function manualActionHttp(error: ManualActionError): { code: number; error: string } {
  if (error === "not_found") return { code: 404, error: "事项不存在" };
  if (error === "trashed") return { code: 409, error: "这条在回收站里——请先恢复再操作" };
  if (error === "notice") return { code: 409, error: "通知不参与完成——它没有完成状态" };
  return { code: 409, error: "删前状态不可考，无法恢复（数据异常）" };
}
