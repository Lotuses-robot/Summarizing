import { TrashViewSchema, type TrashView } from "@summarizing/shared";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";

// 回收站装配（007）：status=trashed 的信息（事项与通知两类混合，行标 kind）。
// 按进入 trashed 的时刻倒序（最新删的在上）；trashedAt 从版本链派生（不另存表——Replay 精神）。
// 回收站是「独立区域」而非类型：它只是 status 的一个取值在 UI 上的投影（存储与视图分离）。

/** 装配回收站列表：全部 trashed 信息，按 trashedAt 倒序。
 *  trashedAt 恒可派生（status=trashed 即由一条 trashed 版本顶链而来），取不到说明数据坏了——
 *  该条**不进列表**（不拿 updatedAt 冒充进入时刻：那是编造，红线「结构容错≠语义兜底」）。 */
export function deriveTrashed(db: Db): TrashView {
  const rows = repo
    .deriveItemsWithVersion(db)
    .filter((r) => r.item.status === "trashed")
    .flatMap((r) => {
      const trashedAt = repo.trashedAtOf(db, r.item.id);
      return trashedAt === null ? [] : [{ item: r.item, trashedAt }];
    })
    // 最近删除在上（定宽北京墙钟字典序 = 时间序，D-64）；破平用 itemId 保稳定
    .sort((a, b) => b.trashedAt.localeCompare(a.trashedAt) || b.item.id.localeCompare(a.item.id));
  return TrashViewSchema.parse({ rows });
}
