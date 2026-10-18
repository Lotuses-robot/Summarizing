// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NoticeRow, TrashRow } from "@summarizing/shared";
import { NoticePanel } from "../components/NoticePanel";
import { TrashPanel } from "../components/TrashPanel";
import { api } from "../api";
import "@testing-library/jest-dom/vitest";

afterEach(cleanup);

/** 造一行通知（测试关心的字段外给合法默认）。 */
function notice(overrides: Partial<NoticeRow> = {}): NoticeRow {
  return {
    item: {
      id: "n1",
      elements: [{ label: "name", text: "数据结构课改到明理楼3楼" }],
      tags: [],
      status: "todo",
      kind: "notice",
      doubtNote: null,
    },
    updatedAt: "2026-10-17 10:00",
    viewed: false,
    sourceLabel: null,
    ...overrides,
  };
}

/** 造一行回收站数据（测试关心的字段外给合法默认）。 */
function trashRow(overrides: Partial<TrashRow> = {}): TrashRow {
  return {
    item: {
      id: "i1",
      elements: [{ label: "name", text: "删掉的事项" }],
      tags: [],
      status: "trashed",
      kind: "task",
      doubtNote: null,
    },
    trashedAt: "2026-10-16 10:00",
    ...overrides,
  };
}

/** 一份合法的条目（`api.trash/restore` 的返回类型 Item——不用 as 绕类型）。 */
function itemFixture(id: string, status: "todo" | "trashed", kind: "task" | "notice" = "task") {
  return {
    id,
    elements: [{ label: "name", text: "条目" }],
    tags: [],
    status,
    kind,
    doubtNote: null,
  };
}

/** 全部通过的筛选谓词——筛选语义本身由 filter.test.ts 覆盖（单一出处 matchesFilter）。 */
const ALL = (_r: NoticeRow) => true;

describe("NoticePanel（007 通知页）", () => {
  it("列出通知：语义名 + 未读微标", () => {
    render(<NoticePanel notices={[notice()]} filter={ALL} onRefresh={() => {}} />);
    expect(screen.getByText("数据结构课改到明理楼3楼")).toBeInTheDocument();
    expect(screen.getByText("新")).toBeInTheDocument();
  });

  it("已读的通知不显示「新」微标", () => {
    render(<NoticePanel notices={[notice({ viewed: true })]} filter={ALL} onRefresh={() => {}} />);
    expect(screen.queryByText("新")).not.toBeInTheDocument();
  });

  it("点开即报已读（viewed 请求发出）", async () => {
    const spy = vi.spyOn(api, "viewed").mockResolvedValue(undefined);
    render(<NoticePanel notices={[notice()]} filter={ALL} onRefresh={() => {}} />);
    fireEvent.click(screen.getByText("数据结构课改到明理楼3楼"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("n1"));
    spy.mockRestore();
  });

  it("空态与筛选无结果给不同文案（不许拿假空态说事）", () => {
    const { unmount } = render(<NoticePanel notices={[]} filter={ALL} onRefresh={() => {}} />);
    expect(screen.getByText(/还没有通知/)).toBeInTheDocument();
    unmount();
    render(<NoticePanel notices={[notice()]} filter={() => false} onRefresh={() => {}} />);
    expect(screen.getByText("没有匹配的通知")).toBeInTheDocument();
  });

  it("行右缘删除 → 调 api.trash（一步进回收站）", async () => {
    const spy = vi.spyOn(api, "trash").mockResolvedValue(itemFixture("n1", "trashed", "notice"));
    render(<NoticePanel notices={[notice()]} filter={ALL} onRefresh={() => {}} />);
    fireEvent.click(screen.getByTitle("删除（进回收站，可恢复）"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("n1"));
    spy.mockRestore();
  });
});

describe("TrashPanel（007 回收站）", () => {
  it("混合列表：行标 kind（事项/通知）+ 总数", () => {
    render(
      <TrashPanel
        rows={[
          trashRow(),
          trashRow({
            item: {
              id: "n1",
              elements: [{ label: "name", text: "删掉的通知" }],
              tags: [],
              status: "trashed",
              kind: "notice",
              doubtNote: null,
            },
            trashedAt: "2026-10-15 10:00",
          }),
        ]}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText("删掉的事项")).toBeInTheDocument();
    expect(screen.getByText("删掉的通知")).toBeInTheDocument();
    expect(screen.getByText("事项")).toBeInTheDocument();
    expect(screen.getByText("通知")).toBeInTheDocument();
    expect(screen.getByText(/共 2 条/)).toBeInTheDocument();
  });

  it("无单条彻底删、无「清空全部」——页级只有「一键清理 >15d」", () => {
    render(<TrashPanel rows={[trashRow()]} onRefresh={() => {}} />);
    expect(screen.getByText("一键清理 >15d")).toBeInTheDocument();
    expect(screen.queryByTitle(/彻底删|清空/)).not.toBeInTheDocument();
  });

  it("一键清理二次确认：第一次点只进确认态，第二次才发出请求", async () => {
    const spy = vi.spyOn(api, "purgeTrash").mockResolvedValue({ purged: 1 });
    render(<TrashPanel rows={[trashRow()]} onRefresh={() => {}} />);
    fireEvent.click(screen.getByText("一键清理 >15d"));
    expect(screen.getByText("确认清理 >15d 的？")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled(); // 还没真清理
    fireEvent.click(screen.getByText("确认清理 >15d 的？"));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    spy.mockRestore();
  });

  it("恢复按钮 → 调 api.restore", async () => {
    const spy = vi.spyOn(api, "restore").mockResolvedValue(itemFixture("n1", "trashed", "notice"));
    render(<TrashPanel rows={[trashRow()]} onRefresh={() => {}} />);
    fireEvent.click(screen.getByTitle("从回收站恢复（回到删前的状态）"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("i1"));
    spy.mockRestore();
  });

  it("空态一句话（禁愧疚/鸡血措辞）", () => {
    render(<TrashPanel rows={[]} onRefresh={() => {}} />);
    expect(screen.getByText(/回收站是空的/)).toBeInTheDocument();
  });
});

describe("NoticePanel：来源徽标（FR-004 / US1-2）", () => {
  it("有来源时显示徽标；无来源（null）不显示也不编造", () => {
    const { unmount } = render(
      <NoticePanel
        notices={[notice({ sourceLabel: "数据结构课群" })]}
        filter={ALL}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText("数据结构课群")).toBeInTheDocument();
    unmount();
    render(
      <NoticePanel notices={[notice({ sourceLabel: null })]} filter={ALL} onRefresh={() => {}} />,
    );
    expect(screen.queryByText("数据结构课群")).not.toBeInTheDocument();
    expect(screen.queryByText("未知来源")).not.toBeInTheDocument(); // 不编造
  });
});
