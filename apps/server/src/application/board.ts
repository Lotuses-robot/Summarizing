import {
  BoardViewSchema,
  dueDateElement,
  itemDueDate,
  itemName,
  MENTIONABLE_LIMIT,
  type BoardView,
  type Item,
  type ItemRow,
} from "@summarizing/shared";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import { parseWallClock } from "../shared/time";
import { foldedMeta, paginate } from "./paging";

// 看板装配（01§4.3 状态制三段；D-80 段序 = 确定程度递增 → D-89 四段化 → 007 取消归档后三段）。
// 过期在这里派生（渲染时算，不落库，01§4.15）。
// 通知（kind=notice）不进看板——它走独立入口（application/notice.ts，007）。

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

/** 装配看板三段（01§4.3 / D-89 / 007 取消归档）：done 归其段；
 *  todo 再按 有无日期 两分（日期未知 / 已排期，已排期只按 ddl 升序）。
 *  通知（kind=notice）不进看板任一段——分类轴（kind）与演化轴（status）正交，007。
 *
 *  **分页只上「已完成」段**（2026-10-27）：日期未知与已排期会随事项完成而收缩，本来就短；
 *  已完成只增不减，全量下发会随使用时间线性增长。
 *
 *  @param db 账户库
 *  @param opts 已完成段的分页选项
 *  @param opts.page 页码（1 起；越界夹到有效范围）
 *  @param opts.folded 该段折叠时**一个 done 行都不查**（连排序都不做），只给计数
 *
 *  缺省 = 第 1 页、不折叠（调用方只有 HTTP 路由与前台 `get_board`；缺省让「不关心分页的读者」
 *  读到完整的三段）。 */
export function buildBoard(
  db: Db,
  opts: { page: number; folded: boolean } = { page: 1, folded: false },
): BoardView {
  const now = new Date();
  // trashed 不进看板任一段——把它在这里滤掉，**下游（尤其 tags）就不会再看见它**。
  // 否则「只留在已删除条目上的标签」会永久挂在标签栏里（点它三段全「无匹配」，且要等到
  // 「一键清理 >15d」物理删版本链才消失）。
  const rows = repo
    .deriveItemsWithVersion(db)
    .filter((r) => r.item.kind === "task" && r.item.status !== "trashed");
  const viewedIds = repo.listViewedItemIds(db);
  const todo = rows.filter((r) => r.item.status === "todo");

  // 已完成按完成时刻倒序（最新在上，用户 2026-09-27）——配合完成淡出梯度自上而下读。
  // 折叠时只数行数：排序要取每条链的完成时刻，省掉它才是这个分页的主要收益。
  const doneRows = rows.filter((r) => r.item.status === "done");
  const donePage = opts.folded
    ? { rows: [] as ItemRow[], meta: foldedMeta(doneRows.length) }
    : (() => {
        // 一次查询取全批完成时刻（不是逐条查链）：排序需要全部 done 行的时刻，分页切不了这步，
        // 但查询次数可以从 N 降到 1（repo.completedAtMany）。
        const completedAt = repo.completedAtMany(
          db,
          doneRows.map((r) => r.item.id),
        );
        const sorted = doneRows
          .map((r) => toRow(r, now, completedAt.get(r.item.id) ?? null, viewedIds.has(r.item.id)))
          .sort(
            (a, b) =>
              (b.completedAt ?? "").localeCompare(a.completedAt ?? "") ||
              b.updatedAt.localeCompare(a.updatedAt),
          );
        return paginate(sorted, opts.page);
      })();

  // D-89：存疑段退场——拿不准的信息进存疑信息库（不挂事项），故 todo 行只需按「有无日期」两分。
  const undated = todo.filter((r) => itemDueDate(r.item) === null);
  const scheduled = todo
    .filter((r) => itemDueDate(r.item) !== null)
    // 定宽北京墙钟（D-64）→ 字典序 = 时间序；非法串（NaN）排最后而非错位
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
    done: donePage.rows,
    doneMeta: donePage.meta,
    // 标签全集**由服务端算**：done 只下发了一页，客户端从行里收集会凭空少掉一大半。
    // 口径 = 看板里**看得见的**三类（trashed 已在上面滤掉）——只存在于已删除条目的标签不该留在标签栏。
    tags: [...new Set(rows.flatMap((r) => r.item.tags))].sort(),
    // @ 提及候选同样与分页无关：从行里收集的话，折叠时一条已完成都 @ 不到（D-135 review 逮出）。
    mentionables: rows
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.item.id.localeCompare(a.item.id))
      .slice(0, MENTIONABLE_LIMIT)
      .map((r) => ({ id: r.item.id, title: itemName(r.item.elements) })),
    failedRawInputs: repo.listRawInputsByState(db, "failed"),
  });
}
