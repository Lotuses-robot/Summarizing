import {
  BoardViewSchema,
  dueDateElement,
  itemDueDate,
  type BoardView,
  type Item,
  type ItemRow,
} from "@summarizing/shared";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import { parseWallClock } from "../shared/time";

// 看板装配（01§4.3 状态制四段；D-80 段序 = 确定程度递增 → D-89 四段化）。
// 过期在这里派生（渲染时算，不落库，01§4.15）。

/** 用已建好的事项列表派生看板行（避免每事件全表重扫——Efficiency 审查项）。 */
function toRow(
  row: { item: Item; updatedAt: string },
  now: Date,
  completedAt: string | null,
  viewed: boolean,
): ItemRow {
  const dueElement = dueDateElement(row.item);
  const dueDate = dueElement?.text ?? null;
  const ts = dueDate === null ? Number.NaN : parseWallClock(dueDate);
  return {
    item: row.item,
    // 只对能解析的日期判过期（脏数据 NaN → 不误报过期，D-34 诚实展示原则）
    overdue: !Number.isNaN(ts) && row.item.status === "todo" && ts < now.getTime(),
    dueDateInferred: (dueElement?.note ?? null) !== null,
    updatedAt: row.updatedAt,
    completedAt,
    viewed,
  };
}

/** 装配看板四段（01§4.3 / D-89；D-83 归档启用）：done/archived 各归其段；
 *  todo 再按 有无日期 两分（日期未知 / 已排期，已排期只按 ddl 升序）。 */
export function buildBoard(db: Db): BoardView {
  const now = new Date();
  const rows = repo.deriveItemsWithVersion(db);
  const viewedIds = repo.listViewedItemIds(db);
  // 已完成按完成时刻倒序（最新在上，用户 2026-09-27）——配合完成淡出梯度自上而下读
  const done = rows
    .filter((r) => r.item.status === "done")
    .map((r) => toRow(r, now, repo.completedAtOf(db, r.item.id), viewedIds.has(r.item.id)))
    .sort(
      (a, b) =>
        (b.completedAt ?? "").localeCompare(a.completedAt ?? "") ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  const archived = rows
    .filter((r) => r.item.status === "archived")
    .map((r) => toRow(r, now, null, viewedIds.has(r.item.id)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.item.id.localeCompare(a.item.id));
  const todo = rows.filter((r) => r.item.status === "todo");
  // D-89：存疑段退场——拿不准的信息进存疑信息库（不挂事项），故 todo 行只需按「有无日期」两分。
  const undated = todo.filter((r) => itemDueDate(r.item) === null);
  const scheduled = todo
    .filter((r) => itemDueDate(r.item) !== null)
    // 定宽本地墙钟（D-64）→ 字典序 = 时间序；非法串（NaN）排最后而非错位
    .sort((a, b) => {
      const av = itemDueDate(a.item) ?? "";
      const bv = itemDueDate(b.item) ?? "";
      const aOk = !Number.isNaN(parseWallClock(av));
      const bOk = !Number.isNaN(parseWallClock(bv));
      if (aOk !== bOk) return aOk ? -1 : 1;
      return av.localeCompare(bv);
    });

  return BoardViewSchema.parse({
    undated: undated.map((r) => toRow(r, now, null, viewedIds.has(r.item.id))),
    scheduled: scheduled.map((r) => toRow(r, now, null, viewedIds.has(r.item.id))),
    done,
    archived, // D-83：最小归档启用，段接收 archived 项（viewed 如实——归档行也可能未被打开过）
    failedRawInputs: repo.listRawInputsByState(db, "failed"),
  });
}
