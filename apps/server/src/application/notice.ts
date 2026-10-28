import { NoticeViewSchema, displayNameOf, type NoticeView } from "@summarizing/shared";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import { paginate } from "./paging";

// 通知页装配（007）：通知（kind=notice）的统一查看入口——看板（board.ts）只收 kind=task，
// 分类轴（kind）与演化轴（status）正交，通知因此不占看板任一段。
// 按「最近更新」倒序（有更新即上浮，用户 2026-10-16 定）；行带 viewed（复用 item_views，
// 通知的「已读」与事项同一张表——点开即消）。

/** 该条最近一条证据所属批次的来源显示名（FR-004 来源徽标）；无证据返回 null（不编造来源）。 */
function latestSourceLabel(db: Db, itemId: string): string | null {
  const evidence = repo.listEvidenceByItem(db, itemId);
  // 取最后一条证据（最近落笔的那次引用）所指批次的来源
  for (let i = evidence.length - 1; i >= 0; i--) {
    const ev = evidence[i];
    if (!ev) continue;
    const frag = repo.getFragment(db, ev.fragmentId);
    if (!frag) continue;
    const raw = repo.getRawInput(db, frag.rawInputId);
    if (raw) return displayNameOf(raw.identity);
  }
  return null;
}

/** 装配通知列表：一页活跃通知（kind=notice 且非 trashed），按 updatedAt 倒序，附已读与来源。
 *  trashed（回收站）的通知不在这——删除即离开通知页，只在回收站可见（D-106）。
 *
 *  **分页**（D-136，2026-10-27 用户定）：通知与回收站同类——只增不减，且每 10 秒轮询一次。
 *  用户原话：「通知落在列表上，通知读完一圈就不读了，可以在下方翻页」——所以分页在**列表**，
 *  主卡只展示「当前选中的那条」（选中项可能不在本页：翻页不夺走正在读的那张卡）。
 *
 *  @param db 账户库
 *  @param page 页码（1 起；越界夹到有效范围）。缺省 = 第 1 页。 */
export function deriveNotices(db: Db, page = 1): NoticeView {
  const rows = repo
    .deriveItemsWithVersion(db)
    .filter((r) => r.item.kind === "notice" && r.item.status !== "trashed")
    // 最近更新在上（定宽北京墙钟字典序 = 时间序，D-64）；破平用 itemId 保排序稳定
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.item.id.localeCompare(a.item.id));
  const viewedIds = repo.listViewedItemIds(db);
  // 未读数按**全量**算：分页之后本页之外还有未读，徽标不能只数这一页（否则翻页时数字会跳）。
  const unreadTotal = rows.filter((r) => !viewedIds.has(r.item.id)).length;
  const paged = paginate(rows, page);
  return NoticeViewSchema.parse({
    notices: paged.rows.map((r) => ({
      item: r.item,
      updatedAt: r.updatedAt,
      viewed: viewedIds.has(r.item.id),
      displayName: latestSourceLabel(db, r.item.id),
    })),
    meta: paged.meta,
    unreadTotal,
    // 标签全集由服务端算（与看板 `board.tags` 同一口径）：本页收集会漏掉别页的标签
    tags: [...new Set(rows.flatMap((r) => r.item.tags))].sort(),
  });
}
