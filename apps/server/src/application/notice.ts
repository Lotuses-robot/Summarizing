import { NoticeViewSchema, type NoticeView } from "@summarizing/shared";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";

// 通知页装配（007）：通知（kind=notice）的统一查看入口——看板（board.ts）只收 kind=task，
// 分类轴（kind）与演化轴（status）正交，通知因此不占看板任一段。
// 按「最近更新」倒序（有更新即上浮，用户 2026-10-16 定）；行带 viewed（复用 item_views，
// 通知的「已读」与事项同一张表——点开即消）。

/** 装配通知列表：全部 kind=notice 的信息，按 updatedAt 倒序，附已读状态。 */
export function deriveNotices(db: Db): NoticeView {
  const rows = repo.deriveItemsWithVersion(db).filter((r) => r.item.kind === "notice");
  const viewedIds = repo.listViewedItemIds(db);
  return NoticeViewSchema.parse({
    notices: rows
      .map((r) => ({ item: r.item, updatedAt: r.updatedAt, viewed: viewedIds.has(r.item.id) }))
      // 最近更新在上（定宽北京墙钟字典序 = 时间序，D-64）；破平用 itemId 保排序稳定
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.item.id.localeCompare(a.item.id)),
  });
}
