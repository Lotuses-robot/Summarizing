import { PAGE_SIZE, type PageMeta } from "@summarizing/shared";

// 分页（2026-10-27）：**只有只增不减的段才分页**——看板「已完成」与回收站。
//
// 日期未知 / 已排期两段会随事项完成而收缩，本来就短，全量下发没有积累问题；
// 已完成与回收站只增不减，用久了全量下发就是「越用越慢、越用越费流量」。
//
// 为什么不给另外两段也上分页：分页的代价是「你看到的不再是全部」，
// 这个代价只该花在真的会长大的地方（纪律 #3：宁可功能少，不可结构乱）。

/** 把一组已排好序的行切出一页（**页码越界就夹到有效范围内**，meta.page 如实回报实际页码）。
 *
 *  为什么夹而不是报错或给空页：页码越界几乎总是「数据变少了」（刚完成一条、刚恢复一条），
 *  不是用户填错了什么。给空页会让用户对着一片空白以为数据没了；夹到末页并如实回报页码，
 *  界面据此把页码拨正——用户看到的永远是「确实有内容的某一页」。
 *
 * @param rows 已排序的全量行
 * @param page 请求的页码（1 起）
 */
export function paginate<T>(rows: T[], page: number): { rows: T[]; meta: PageMeta } {
  const total = rows.length;
  const pageCount = Math.ceil(total / PAGE_SIZE);
  const clamped = Math.min(Math.max(Math.trunc(page), 1), Math.max(pageCount, 1));
  const start = (clamped - 1) * PAGE_SIZE;
  return {
    rows: rows.slice(start, start + PAGE_SIZE),
    meta: { folded: false, page: clamped, pageCount, total },
  };
}

/** 折叠态的段头信息：**只给计数、不给行**（本次调用根本没取行）。
 *
 *  与「这段是空的」严格区分：`folded: true` + `total: 0` 才是空；`folded: true` + `total: 137`
 *  是「有 137 条，但这次没查」。前端据 folded 决定要不要显示「展开」。
 *
 * @param total 本段总条数
 */
export function foldedMeta(total: number): PageMeta {
  return { folded: true, page: 1, pageCount: Math.ceil(total / PAGE_SIZE), total };
}
