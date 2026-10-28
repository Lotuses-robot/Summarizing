// 看板行/看板视图的测试夹具工厂（board.test 与 app.test 共用，避免两处各抄一份形状）。
import { PAGE_SIZE, type BoardView, type Element, type ItemRow } from "@summarizing/shared";

/** 造一行看板数据（测试关心的字段外给合法默认）。 */
export function makeRow(opts: {
  id: string;
  name: string;
  tags?: string[];
  status?: "todo" | "done" | "trashed";
  kind?: "task" | "notice";
  doubtNote?: string | null;
  due?: string | null;
  dueNote?: string | null;
  overdue?: boolean;
  updatedAt?: string;
  completedAt?: string | null;
  viewed?: boolean;
}): ItemRow {
  const elements: Element[] = [{ label: "name", text: opts.name }];
  if (opts.due !== undefined && opts.due !== null) {
    elements.push({ label: "dueDate", text: opts.due, note: opts.dueNote ?? null });
  }
  return {
    item: {
      id: opts.id,
      elements,
      tags: opts.tags ?? [],
      status: opts.status ?? "todo",
      kind: opts.kind ?? "task",
      doubtNote: opts.doubtNote ?? null,
    },
    overdue: opts.overdue ?? false,
    dueDateInferred: (opts.dueNote ?? null) !== null,
    updatedAt: opts.updatedAt ?? "2026-09-26 10:00",
    completedAt: opts.completedAt ?? null,
    viewed: opts.viewed ?? false,
  };
}

/** 造一块板（未给段恒空）。
 *
 *  `doneMeta` 默认按 `done` 的行数推出来（页大小取 PAGE_SIZE）——夹具只关心「有哪些行」时
 *  不必再手写一份分页信息；要测分页行为时显式传。 */
export function view(partial: Partial<BoardView> = {}): BoardView {
  const done = partial.done ?? [];
  const undated = partial.undated ?? [];
  const scheduled = partial.scheduled ?? [];
  return {
    undated: [],
    scheduled: [],
    done,
    doneMeta: {
      folded: false,
      page: 1,
      pageCount: Math.ceil(done.length / PAGE_SIZE),
      total: done.length,
    },
    tags: [...new Set([...done, ...undated, ...scheduled].flatMap((r) => r.item.tags))].sort(),
    // @ 提及候选：夹具默认按「看板里有的行」推——服务端是全量口径，测试多数不关心这个差别
    mentionables: [...done, ...undated, ...scheduled].map((r) => ({
      id: r.item.id,
      title: r.item.elements.find((e) => e.label === "name")?.text ?? "",
    })),
    failedRawInputs: [],
    ...partial,
  };
}
