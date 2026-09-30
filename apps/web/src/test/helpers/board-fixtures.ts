// 看板行/看板视图的测试夹具工厂（board.test 与 app.test 共用，避免两处各抄一份形状）。
import type { BoardView, Element, ItemRow } from "@summarizing/shared";

/** 造一行看板数据（测试关心的字段外给合法默认）。 */
export function makeRow(opts: {
  id: string;
  name: string;
  tags?: string[];
  status?: "todo" | "done" | "archived";
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
      doubtNote: opts.doubtNote ?? null,
    },
    overdue: opts.overdue ?? false,
    dueDateInferred: (opts.dueNote ?? null) !== null,
    updatedAt: opts.updatedAt ?? "2026-09-26 10:00",
    completedAt: opts.completedAt ?? null,
    viewed: opts.viewed ?? false,
  };
}

/** 造一块板（未给段恒空）。 */
export function view(partial: Partial<BoardView> = {}): BoardView {
  return {
    undated: [],
    scheduled: [],
    done: [],
    archived: [],
    failedRawInputs: [],
    ...partial,
  };
}
