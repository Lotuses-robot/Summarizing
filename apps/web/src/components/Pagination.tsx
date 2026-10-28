import { ChevronLeft, ChevronRight } from "lucide-react";
import type { PageMeta } from "@summarizing/shared";
import { cn } from "../lib/cn";

/** 分页控件（2026-10-27）：看板「已完成」段与回收站共用。
 *
 *  只做「上一页 / 下一页 + 第几页 / 共几页」——不做页码列表（一页 20 条，页数不会多到需要跳页），
 *  也不做触底自动加载（用户 2026-10-27：滚动加载与轮询刷新会打架——正在看第 3 条，
 *  刷新把列表重排，手指下的内容就换了）。
 *
 *  只有一页时**整块不渲染**：一页的东西给「第 1/1 页」是噪音。 */
export function Pagination({
  meta,
  onPage,
  busy = false,
}: {
  meta: PageMeta;
  onPage: (page: number) => void;
  /** 在飞时禁用（防连点翻出两页的结果）——由调用方给。 */
  busy?: boolean;
}) {
  if (meta.pageCount <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-center gap-3 text-xs text-ink-muted">
      <button
        className={cn("btn px-2 py-1", meta.page <= 1 && "invisible")}
        disabled={busy || meta.page <= 1}
        title="上一页"
        onClick={() => onPage(meta.page - 1)}
      >
        <ChevronLeft size={14} />
      </button>
      <span>
        第 {meta.page} / {meta.pageCount} 页 · 共 {meta.total} 条
      </span>
      <button
        className={cn("btn px-2 py-1", meta.page >= meta.pageCount && "invisible")}
        disabled={busy || meta.page >= meta.pageCount}
        title="下一页"
        onClick={() => onPage(meta.page + 1)}
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
