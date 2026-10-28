// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    displayName: null,
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

/** 在通知主卡上模拟一次触屏横滑（正 = 向右/清除，负 = 向左/稍后）。
 *  happy-dom 没有布局，clientWidth 恒为 0——先临时给一个宽度，35% 阈值才有意义。 */
function swipeCard(dx: number): void {
  const heading = screen.getByRole("heading", { level: 2 });
  const card = heading.closest(".touch-pan-y");
  if (!(card instanceof HTMLElement)) throw new Error("找不到通知主卡");
  Object.defineProperty(card, "clientWidth", { configurable: true, value: 400 });
  /** 某个横坐标上的「手指」——touch 事件只用到 clientX/clientY。 */
  const at = (x: number) => ({ clientX: x, clientY: 120 });
  /** 派发带 touches 的原生事件（组件用原生 touch 监听，不走 TouchEvent 构造器）。 */
  const fire = (type: string, touches: { clientX: number; clientY: number }[]) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "touches", { value: touches });
    fireEvent(card, ev);
  };
  fire("touchstart", [at(200)]);
  fire("touchmove", [at(200 + dx)]);
  fire("touchend", []);
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

/** 测试用包装：NoticePanel 现在要分页 props（D-136）。
 *  多数用例不关心分页 → 按行数推一份「单页」meta；要测分页的用例直接用 NoticePanel。 */
function Panel({
  notices,
  filter,
  onRefresh,
  focus,
}: {
  notices: NoticeRow[];
  filter: (r: NoticeRow) => boolean;
  onRefresh: () => void;
  focus?: { id: string; token: number } | null;
}) {
  return (
    <NoticePanel
      notices={notices}
      filter={filter}
      onRefresh={onRefresh}
      meta={{ folded: false, page: 1, pageCount: 1, total: notices.length }}
      onPage={() => {}}
      focus={focus ?? null}
    />
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
      <Panel
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

  it("未读点：选中即已读；列表里其它未读条仍亮（title 未读/已读）", () => {
    const second = notice({
      item: { ...notice().item, id: "n2", elements: [{ label: "name", text: "线性代数调课" }] },
    });
    const { unmount } = render(
      <Panel notices={[notice(), second]} filter={ALL} onRefresh={() => {}} />,
    );
    // 第一条被自动选中→标已读；第二条仍是未读
    expect(screen.getAllByTitle("已读").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("未读").length).toBeGreaterThan(0);
    unmount();
    render(
      <Panel
        notices={[notice({ viewed: true }), notice({ ...second, viewed: true })]}
        filter={ALL}
        onRefresh={() => {}}
      />,
    );
    expect(screen.queryAllByTitle("未读")).toHaveLength(0);
  });

  it("自动选中第一条即报已读；点列表另一条也报已读", async () => {
    const spy = vi.spyOn(api, "viewed").mockResolvedValue(undefined);
    const second = notice({
      item: { ...notice().item, id: "n2", elements: [{ label: "name", text: "线性代数调课" }] },
    });
    render(<Panel notices={[notice(), second]} filter={ALL} onRefresh={() => {}} />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("n1"));
    fireEvent.click(screen.getByText("线性代数调课"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("n2"));
  });

  it("空态与筛选无结果给不同文案", () => {
    const { unmount } = render(<Panel notices={[]} filter={ALL} onRefresh={() => {}} />);
    expect(screen.getByText(/还没有通知/)).toBeInTheDocument();
    unmount();
    render(<Panel notices={[notice()]} filter={() => false} onRefresh={() => {}} />);
    expect(screen.getByText("没有匹配的通知")).toBeInTheDocument();
  });

  it("清除：右滑 → 模糊倒计时 → 2 秒后才写库", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api, "trash").mockResolvedValue(itemFixture("n1", "trashed", "notice"));
    render(<Panel notices={[notice()]} filter={ALL} onRefresh={() => {}} />);
    swipeCard(200);
    expect(screen.getByText("已清除")).toBeInTheDocument();
    // 卡片必须弹回原位：手势钩子过阈值时刻意不清位移（留给看板行做飞出动效），
    // 通知卡用模糊遮罩、不做位移动画，得自己复位——否则会停在拖开的位置（实测「清除乱掉了」）
    const card = screen.getByRole("heading", { level: 2 }).closest(".touch-pan-y");
    if (!(card instanceof HTMLElement)) throw new Error("找不到通知主卡");
    expect(card.style.transform).toBe("");
    expect(spy).not.toHaveBeenCalled(); // 还没到点
    await vi.advanceTimersByTimeAsync(2100);
    expect(spy).toHaveBeenCalledWith("n1");
  });

  it("锁：关锁后横滑不再生效；开锁恢复（2026-10-23 卡内可交互）", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api, "trash").mockResolvedValue(itemFixture("n1", "trashed", "notice"));
    render(<Panel notices={[notice()]} filter={ALL} onRefresh={() => {}} />);

    // 默认开锁：能滑（这条断言的是「锁没误伤默认路径」）
    fireEvent.click(screen.getByRole("button", { name: "锁定（固定卡片、可操作内容）" }));
    swipeCard(200);
    expect(screen.queryByText("已清除")).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();

    // 开锁后恢复
    fireEvent.click(screen.getByRole("button", { name: "解锁（恢复横滑）" }));
    swipeCard(200);
    expect(screen.getByText("已清除")).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(2100);
    expect(spy).toHaveBeenCalledWith("n1");
  });

  it("切换通知时自动回到开锁（每条默认可滑）", async () => {
    vi.useFakeTimers();
    const a = notice();
    const b = notice({ item: { ...a.item, id: "n2" } });
    render(<Panel notices={[a, b]} filter={ALL} onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "锁定（固定卡片、可操作内容）" }));
    expect(screen.getByRole("button", { name: "解锁（恢复横滑）" })).toBeInTheDocument();
    // 切到第二条（列表行按钮）→ 锁自动复位
    const listButtons = within(screen.getByRole("list")).getAllByRole("button");
    const second = listButtons[1];
    if (second === undefined) throw new Error("列表里没有第二条");
    fireEvent.click(second);
    expect(
      screen.getByRole("button", { name: "锁定（固定卡片、可操作内容）" }),
    ).toBeInTheDocument();
  });

  it("撤回：倒计时内点撤销钮 → 什么都不发生", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api, "trash").mockResolvedValue(itemFixture("n1", "trashed", "notice"));
    render(<Panel notices={[notice()]} filter={ALL} onRefresh={() => {}} />);
    swipeCard(200);
    // 撤销是圆形图标钮（2026-10-22：文字「撤回」改成图标）
    fireEvent.click(screen.getByTitle("撤回清除"));
    await vi.advanceTimersByTimeAsync(2100);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByText("已清除")).not.toBeInTheDocument();
  });

  it("稍后：左滑 → 跳到下一条，不写库；列表行上不出现「稍后」标记", async () => {
    const second = notice({
      item: { ...notice().item, id: "n2", elements: [{ label: "name", text: "线性代数调课" }] },
    });
    render(<Panel notices={[notice(), second]} filter={ALL} onRefresh={() => {}} />);
    swipeCard(-200);
    // 主卡切到第二条（1/2 → 2/2）
    await waitFor(() => expect(screen.getByText("2/2")).toBeInTheDocument());
    // 列表行上不再有「稍后」标签（用户 2026-10-19：只要已读/未读）。
    // 卡片底层的滑动提示（aria-hidden 装饰）不算列表标记——它只在拖动时可见。
    const list = screen.getByRole("list");
    expect(within(list).queryByText("稍后")).not.toBeInTheDocument();
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
        meta={{ folded: false, page: 1, pageCount: 1, total: 2 }}
        onRefresh={() => {}}
        onPage={() => {}}
      />,
    );
    expect(screen.getByText("删掉的事项")).toBeInTheDocument();
    expect(screen.getByText("删掉的通知")).toBeInTheDocument();
    expect(screen.getByText("事项")).toBeInTheDocument();
    expect(screen.getByText("通知")).toBeInTheDocument();
    expect(screen.getByText(/共 2 条/)).toBeInTheDocument();
  });

  it("无单条彻底删、无「清空全部」——页级只有「一键清理 >15d」", () => {
    render(
      <TrashPanel
        rows={[trashRow()]}
        meta={{ folded: false, page: 1, pageCount: 1, total: 1 }}
        onRefresh={() => {}}
        onPage={() => {}}
      />,
    );
    expect(screen.getByText("一键清理 >15d")).toBeInTheDocument();
    expect(screen.queryByTitle(/彻底删|清空/)).not.toBeInTheDocument();
  });

  it("一键清理二次确认：第一次点只进确认态，第二次才发出请求", async () => {
    const spy = vi.spyOn(api, "purgeTrash").mockResolvedValue({ purged: 1 });
    render(
      <TrashPanel
        rows={[trashRow()]}
        meta={{ folded: false, page: 1, pageCount: 1, total: 1 }}
        onRefresh={() => {}}
        onPage={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("一键清理 >15d"));
    expect(screen.getByText("确认清理 >15d 的？")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled(); // 还没真清理
    fireEvent.click(screen.getByText("确认清理 >15d 的？"));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    spy.mockRestore();
  });

  it("恢复按钮 → 调 api.restore", async () => {
    const spy = vi.spyOn(api, "restore").mockResolvedValue(itemFixture("n1", "trashed", "notice"));
    render(
      <TrashPanel
        rows={[trashRow()]}
        meta={{ folded: false, page: 1, pageCount: 1, total: 1 }}
        onRefresh={() => {}}
        onPage={() => {}}
      />,
    );
    fireEvent.click(screen.getByTitle("从回收站恢复（回到删前的状态）"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("i1"));
    spy.mockRestore();
  });

  it("空态一句话（禁愧疚/鸡血措辞）", () => {
    render(
      <TrashPanel
        rows={[]}
        meta={{ folded: false, page: 1, pageCount: 0, total: 0 }}
        onRefresh={() => {}}
        onPage={() => {}}
      />,
    );
    expect(screen.getByText(/回收站是空的/)).toBeInTheDocument();
  });
});

describe("NoticePanel：列表分页（D-136）", () => {
  beforeEach(stubItemFetch);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("多页时列表尾部有翻页控件；只有一页时不渲染", () => {
    const page: number[] = [];
    const { rerender } = render(
      <NoticePanel
        notices={[notice()]}
        filter={ALL}
        onRefresh={() => {}}
        meta={{ folded: false, page: 1, pageCount: 3, total: 45 }}
        onPage={(p) => page.push(p)}
      />,
    );
    expect(screen.getByText(/第 1 \/ 3 页 · 共 45 条/)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("下一页"));
    expect(page).toEqual([2]);

    rerender(
      <NoticePanel
        notices={[notice()]}
        filter={ALL}
        onRefresh={() => {}}
        meta={{ folded: false, page: 1, pageCount: 1, total: 1 }}
        onPage={(p) => page.push(p)}
      />,
    );
    expect(screen.queryByTitle("下一页")).not.toBeInTheDocument();
  });

  it("翻页后主卡跟着换成本页第一条（卡片与列表不脱节）", () => {
    const first = notice(); // id=n1
    const otherPage = notice({
      item: { ...notice().item, id: "n9", elements: [{ label: "name", text: "另一页的通知" }] },
    });
    const { rerender } = render(
      <NoticePanel
        notices={[first]}
        filter={ALL}
        onRefresh={() => {}}
        meta={{ folded: false, page: 1, pageCount: 2, total: 2 }}
        onPage={() => {}}
      />,
    );
    expect(screen.getAllByText("数据结构课改到明理楼3楼").length).toBeGreaterThan(0);

    // 翻到第 2 页：第 2 页第一条自动选中——屏幕上「卡片里的东西」始终在下面的列表里
    rerender(
      <NoticePanel
        notices={[otherPage]}
        filter={ALL}
        onRefresh={() => {}}
        meta={{ folded: false, page: 2, pageCount: 2, total: 2 }}
        onPage={() => {}}
      />,
    );
    expect(screen.queryByText("数据结构课改到明理楼3楼")).not.toBeInTheDocument();
    expect(screen.getAllByText("另一页的通知").length).toBeGreaterThan(1); // 卡片 + 列表各一次
  });

  it("空态分三种：没拉到 / 真的没有 / 本页空了", () => {
    const { rerender } = render(
      <NoticePanel notices={[]} filter={ALL} onRefresh={() => {}} meta={null} onPage={() => {}} />,
    );
    expect(screen.getByText(/正在载入通知/)).toBeInTheDocument();

    rerender(
      <NoticePanel
        notices={[]}
        filter={ALL}
        onRefresh={() => {}}
        meta={{ folded: false, page: 1, pageCount: 0, total: 0 }}
        onPage={() => {}}
      />,
    );
    expect(screen.getByText(/还没有通知/)).toBeInTheDocument();

    rerender(
      <NoticePanel
        notices={[]}
        filter={ALL}
        onRefresh={() => {}}
        meta={{ folded: false, page: 2, pageCount: 2, total: 25 }}
        onPage={() => {}}
      />,
    );
    expect(screen.getByText(/这一页没有通知了/)).toBeInTheDocument();
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
      <Panel
        notices={[notice({ displayName: "数据结构课群" })]}
        filter={ALL}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getAllByText("数据结构课群").length).toBeGreaterThan(0);
    unmount();
    render(<Panel notices={[notice({ displayName: null })]} filter={ALL} onRefresh={() => {}} />);
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

  it("同一次更新内选中过 → 已读；updatedAt 变了 → 重新变未读", () => {
    const r1 = notice({ updatedAt: "2026-10-17 10:00" });
    const { rerender } = render(<Panel notices={[r1]} filter={ALL} onRefresh={() => {}} />);
    expect(screen.queryAllByTitle("未读")).toHaveLength(0); // 自动选中即已读
    const r2 = notice({ updatedAt: "2026-10-18 09:00" });
    rerender(<Panel notices={[r2]} filter={ALL} onRefresh={() => {}} />);
    expect(screen.getAllByTitle("未读").length).toBeGreaterThan(0);
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
      <Panel
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
