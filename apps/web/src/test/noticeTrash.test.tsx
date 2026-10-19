// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoticeRow, TrashRow } from "@summarizing/shared";
import { NoticePanel } from "../components/NoticePanel";
import { TrashPanel } from "../components/TrashPanel";
import { api } from "../api";
import { jsonResponse } from "./helpers/http";
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

/** 主卡内的 ItemBody 会拉详情：给 /api/items/:id 一个最小合法 GetItemResult（不走网络）。 */
function stubItemFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const id = /\/api\/items\/([^/?]+)/.exec(url)?.[1] ?? "n1";
      return Promise.resolve(
        jsonResponse({
          item: {
            id,
            elements: [{ label: "name", text: "条目" }],
            tags: [],
            status: "todo",
            kind: "notice",
            doubtNote: null,
          },
          evidence: [],
          fragments: [],
          versions: [],
          rawInputs: {},
        }),
      );
    }),
  );
}

describe("NoticePanel（D-108 主卡阅读器）", () => {
  beforeEach(stubItemFetch);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("主卡默认选中第一条；下方列表列出全部；进度 1/N", () => {
    render(
      <NoticePanel
        notices={[
          notice(),
          notice({
            item: {
              ...notice().item,
              id: "n2",
              elements: [{ label: "name", text: "线性代数调课" }],
            },
          }),
        ]}
        filter={ALL}
        onRefresh={() => {}}
      />,
    );
    // 语义名在卡片标题与列表行各出现一次
    expect(screen.getAllByText("数据结构课改到明理楼3楼").length).toBeGreaterThan(0);
    expect(screen.getByText("线性代数调课")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("已读的通知不显示「新」", () => {
    render(<NoticePanel notices={[notice({ viewed: true })]} filter={ALL} onRefresh={() => {}} />);
    expect(screen.queryByText("新")).not.toBeInTheDocument();
  });

  it("自动选中第一条即报已读；点列表另一条也报已读", async () => {
    const spy = vi.spyOn(api, "viewed").mockResolvedValue(undefined);
    const second = notice({
      item: { ...notice().item, id: "n2", elements: [{ label: "name", text: "线性代数调课" }] },
    });
    render(<NoticePanel notices={[notice(), second]} filter={ALL} onRefresh={() => {}} />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("n1"));
    fireEvent.click(screen.getByText("线性代数调课"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("n2"));
  });

  it("空态与筛选无结果给不同文案", () => {
    const { unmount } = render(<NoticePanel notices={[]} filter={ALL} onRefresh={() => {}} />);
    expect(screen.getByText(/还没有通知/)).toBeInTheDocument();
    unmount();
    render(<NoticePanel notices={[notice()]} filter={() => false} onRefresh={() => {}} />);
    expect(screen.getByText("没有匹配的通知")).toBeInTheDocument();
  });

  it("清除：点右缘提示 → 模糊倒计时 → 3 秒后才写库", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api, "trash").mockResolvedValue(itemFixture("n1", "trashed", "notice"));
    render(<NoticePanel notices={[notice()]} filter={ALL} onRefresh={() => {}} />);
    fireEvent.click(screen.getByTitle(/清除（进回收站/));
    expect(screen.getByText("已清除")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled(); // 还没到点
    await vi.advanceTimersByTimeAsync(3100);
    expect(spy).toHaveBeenCalledWith("n1");
  });

  it("撤回：倒计时内点「撤回」→ 什么都不发生", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api, "trash").mockResolvedValue(itemFixture("n1", "trashed", "notice"));
    render(<NoticePanel notices={[notice()]} filter={ALL} onRefresh={() => {}} />);
    fireEvent.click(screen.getByTitle(/清除（进回收站/));
    fireEvent.click(screen.getByText("撤 回"));
    await vi.advanceTimersByTimeAsync(3100);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByText("已清除")).not.toBeInTheDocument();
  });

  it("稍后：点左缘提示 → 标记「稍后」并跳到下一条，不写库", async () => {
    const second = notice({
      item: { ...notice().item, id: "n2", elements: [{ label: "name", text: "线性代数调课" }] },
    });
    render(<NoticePanel notices={[notice(), second]} filter={ALL} onRefresh={() => {}} />);
    fireEvent.click(screen.getByTitle(/稍后（本次跳过/));
    await waitFor(() => expect(screen.getByText("稍后")).toBeInTheDocument()); // 列表行标记
    // 主卡切到第二条（1/2 → 2/2）
    expect(screen.getByText("2/2")).toBeInTheDocument();
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
  beforeEach(stubItemFetch);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("有来源时显示徽标；无来源（null）不显示也不编造", () => {
    const { unmount } = render(
      <NoticePanel
        notices={[notice({ sourceLabel: "数据结构课群" })]}
        filter={ALL}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getAllByText("数据结构课群").length).toBeGreaterThan(0);
    unmount();
    render(
      <NoticePanel notices={[notice({ sourceLabel: null })]} filter={ALL} onRefresh={() => {}} />,
    );
    expect(screen.queryByText("数据结构课群")).not.toBeInTheDocument();
    expect(screen.queryByText("未知来源")).not.toBeInTheDocument(); // 不编造
  });
});

describe("NoticePanel：更新后重新标未读（OQ-11 前端半侧）", () => {
  beforeEach(stubItemFetch);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("同一次更新内选中过 → 不再亮「新」；updatedAt 变了 → 重新亮", () => {
    const r1 = notice({ updatedAt: "2026-10-17 10:00" });
    const { rerender } = render(<NoticePanel notices={[r1]} filter={ALL} onRefresh={() => {}} />);
    expect(screen.queryByText("新")).not.toBeInTheDocument(); // 自动选中即已读
    const r2 = notice({ updatedAt: "2026-10-18 09:00" });
    rerender(<NoticePanel notices={[r2]} filter={ALL} onRefresh={() => {}} />);
    expect(screen.getByText("新")).toBeInTheDocument();
  });
});

describe("NoticePanel：深链选中也报已读（FR-016）", () => {
  beforeEach(stubItemFetch);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("focus 指向第二条 → 选中它并调 api.viewed", async () => {
    const spy = vi.spyOn(api, "viewed").mockResolvedValue(undefined);
    const second = notice({
      item: { ...notice().item, id: "n2", elements: [{ label: "name", text: "线性代数调课" }] },
    });
    render(
      <NoticePanel
        notices={[notice(), second]}
        filter={ALL}
        onRefresh={() => {}}
        focus={{ id: "n2", token: 1 }}
      />,
    );
    await waitFor(() => expect(spy).toHaveBeenCalledWith("n2"));
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });
});
