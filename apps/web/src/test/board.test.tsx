// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wallClockToEpoch } from "@summarizing/shared";
import { Board } from "../components/Board";
import { doneFadeStrength } from "../lib/urgency";
import { makeRow, view } from "./helpers/board-fixtures";
import "@testing-library/jest-dom/vitest";

describe("Board（三段看板，007）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(wallClockToEpoch("2026-09-26T12:00:00"));
    // 展开体挂载会拉详情——测试环境直接给失败应答，落在「加载中…」占位（不试真网络）
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("测试环境无后端"))),
    );
    // 折叠记忆键会跨用例残留（happy-dom localStorage 同文件共享），统一清空
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    cleanup();
  });

  it("三段渲染：行进对应段；已完成默认折叠、点段头展开", () => {
    render(
      <Board
        board={view({
          undated: [makeRow({ id: "u1", name: "日期未定事项" })],
          scheduled: [
            makeRow({ id: "s1", name: "英语作业", tags: ["英语课"], due: "2026-09-30 18:00" }),
          ],
          done: [makeRow({ id: "x1", name: "已交表", status: "done" })],
        })}
        onRefresh={() => {}}
        focus={null}
        filter={{ query: "", tags: [] }}
        onTagClick={() => {}}
      />,
    );
    expect(screen.getByText("日期未知")).toBeInTheDocument();
    expect(screen.getByText("已排期")).toBeInTheDocument();
    expect(screen.getByText("日期未定事项")).toBeInTheDocument();
    expect(screen.getByText("英语作业")).toBeInTheDocument();
    // 已完成默认折叠（D-80）：行不可见，点段头展开后可见
    expect(screen.queryByText("已交表")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("已完成"));
    expect(screen.getByText("已交表")).toBeInTheDocument();
  });

  it("到期时间独立成一位：桌面端那份在可压缩的标签区之外（空间不够也不会被挤掉）", () => {
    render(
      <Board
        board={view({
          scheduled: [
            makeRow({ id: "s1", name: "英语作业", tags: ["英语课"], due: "2026-09-30 18:00" }),
          ],
        })}
        onRefresh={() => {}}
        focus={null}
        filter={{ query: "", tags: [] }}
        onTagClick={() => {}}
      />,
    );
    // 同一来源两处渲染（桌面独立位 + 窄屏可滑动行），title 相同
    const dues = screen.getAllByTitle(/^到期 /);
    expect(dues).toHaveLength(2);
    // 桌面那份：不在 .row-meta 里、且 shrink-0（永不压缩）
    const desktop = dues.filter((el) => el.closest(".row-meta") === null);
    expect(desktop).toHaveLength(1);
    expect(desktop[0]?.className).toContain("shrink-0");
    expect(desktop[0]?.className).toContain("sm:inline");
    // 窄屏那份：留在可横向滑动的第二行里
    const narrow = dues.filter((el) => el.closest(".row-meta") !== null);
    expect(narrow).toHaveLength(1);
    expect(narrow[0]?.className).toContain("sm:hidden");
    // 标签才是可被挤掉的：它们都在 .row-meta 那个可压缩盒子里
    expect(screen.getByText("英语课").closest(".row-meta")).not.toBeNull();
  });

  it("段头计数随筛选变：过滤后计数 = 显示条数（曾固定显示段内总数）", () => {
    const { rerender } = render(
      <Board
        board={view({
          scheduled: [
            makeRow({ id: "s1", name: "英语作业", tags: ["英语课"], due: "2026-09-30 18:00" }),
            makeRow({ id: "s2", name: "数学作业", tags: ["数学课"], due: "2026-09-29 18:00" }),
          ],
        })}
        onRefresh={() => {}}
        focus={null}
        filter={{ query: "", tags: [] }}
        onTagClick={() => {}}
      />,
    );
    // 无筛选：段头计数 = 2；两行都可见
    expect(screen.getByText("已排期").parentElement).toHaveTextContent("2");
    expect(screen.getByText("英语作业")).toBeInTheDocument();
    expect(screen.getByText("数学作业")).toBeInTheDocument();
    // 按「数学课」筛选 → 段头计数变 1；只剩数学作业
    rerender(
      <Board
        board={view({
          scheduled: [
            makeRow({ id: "s1", name: "英语作业", tags: ["英语课"], due: "2026-09-30 18:00" }),
            makeRow({ id: "s2", name: "数学作业", tags: ["数学课"], due: "2026-09-29 18:00" }),
          ],
        })}
        onRefresh={() => {}}
        focus={null}
        filter={{ query: "", tags: ["数学课"] }}
        onTagClick={() => {}}
      />,
    );
    expect(screen.getByText("已排期").parentElement).toHaveTextContent("1");
    expect(screen.queryByText("英语作业")).not.toBeInTheDocument();
    expect(screen.getByText("数学作业")).toBeInTheDocument();
  });

  it("三段渲染：已完成段默认折叠、点段头展开；带 doubtNote 的行按日期正常渲染（007 取消归档后三段）", () => {
    render(
      <Board
        board={view({
          undated: [makeRow({ id: "u1", name: "带存疑字段的行", doubtNote: "来源用词『听说』" })],
          done: [makeRow({ id: "a1", name: "已了结的事", status: "done" })],
        })}
        onRefresh={() => {}}
        focus={null}
        filter={{ query: "", tags: [] }}
        onTagClick={() => {}}
      />,
    );
    // 存疑字段不再影响渲染：行照常出现；「存疑」段头不存在（只有存疑库审核页有它）
    expect(screen.getByText("带存疑字段的行")).toBeInTheDocument();
    expect(screen.queryByText("存疑")).not.toBeInTheDocument();
    // 已完成默认折叠 → 点开可见
    expect(screen.queryByText("已了结的事")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("已完成"));
    expect(screen.getByText("已了结的事")).toBeInTheDocument();
  });

  it("完成淡出数值口径（U3 走查修订）：刚完成满格 ×40%；12 小时前 ≈29%（低于 40 封顶）", () => {
    const now = wallClockToEpoch("2026-09-30T12:00:00");
    // 刚完成 → 强度 1 → 40%（= 待办渐强同档最大；「刚完成最亮」由此成立）
    expect(Math.round(doneFadeStrength("2026-09-30 12:00:00", now) * 40)).toBe(40);
    // 12 小时前：p = 1−12/120 = 0.9 → 0.729 → 29%
    expect(Math.round(doneFadeStrength("2026-09-30 00:00:00", now) * 40)).toBe(29);
    // 超窗（5 天以上）归零
    expect(doneFadeStrength("2026-09-20 12:00:00", now)).toBe(0);
  });

  it("标签 token 筛选：filter.tags AND 收窄；行上点 tag → onTagClick", () => {
    const onTagClick = vi.fn();
    render(
      <Board
        board={view({
          scheduled: [
            makeRow({
              id: "a",
              name: "英语作业",
              tags: ["英语课", "作业"],
              due: "2026-09-30 18:00",
            }),
            makeRow({ id: "b", name: "社团通知", tags: ["社团"], due: "2026-10-01 09:00" }),
          ],
        })}
        onRefresh={() => {}}
        focus={null}
        filter={{ query: "", tags: ["英语课"] }}
        onTagClick={onTagClick}
      />,
    );
    expect(screen.queryByText("社团通知")).not.toBeInTheDocument();
    expect(screen.getByText("英语作业")).toBeInTheDocument();
    // 行上的 tag 点击 = 加/删 token（从内容发现标签的路径）
    fireEvent.click(screen.getByText("英语课"));
    expect(onTagClick).toHaveBeenCalledWith("英语课");
  });

  it("键盘流：↓ 选中行、Enter 展开（05§六）", () => {
    render(
      <Board
        board={view({
          scheduled: [
            makeRow({ id: "a", name: "事项甲", due: "2026-09-30 18:00" }),
            makeRow({ id: "b", name: "事项乙", due: "2026-10-01 09:00" }),
          ],
        })}
        onRefresh={() => {}}
        focus={null}
        filter={{ query: "", tags: [] }}
        onTagClick={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getAllByText("加载中…")).toHaveLength(1);
  });

  it("文本过滤：标题含查询串才显示", () => {
    render(
      <Board
        board={view({
          scheduled: [
            makeRow({ id: "a", name: "英语作业", due: "2026-09-30 18:00" }),
            makeRow({ id: "b", name: "社团例会", due: "2026-10-01 09:00" }),
          ],
        })}
        onRefresh={() => {}}
        focus={null}
        filter={{ query: "英语", tags: [] }}
        onTagClick={() => {}}
      />,
    );
    expect(screen.queryByText("社团例会")).not.toBeInTheDocument();
    expect(screen.getByText("英语作业")).toBeInTheDocument();
  });

  it("推断点悬停给依据（原生 title）；存疑点已随 D-89 退场", () => {
    render(
      <Board
        board={view({
          scheduled: [
            makeRow({
              id: "a",
              name: "推断作业",
              due: "2026-09-30 18:00",
              dueNote: "按往年惯例推算",
            }),
            makeRow({
              id: "b",
              name: "带存疑字段的事项",
              due: "2026-10-01 09:00",
              doubtNote: "来源用词『听说』",
            }),
          ],
        })}
        onRefresh={() => {}}
        focus={null}
        filter={{ query: "", tags: [] }}
        onTagClick={() => {}}
      />,
    );
    expect(screen.getByTitle("推断：2026-09-30 18:00 · 依据：按往年惯例推算")).toBeInTheDocument();
    // D-89：存疑琥珀条已删——doubtNote 不再渲染任何行内标记
    expect(screen.queryByTitle("来源用词『听说』")).not.toBeInTheDocument();
  });

  it("「新」微标：未打开的待办显示、点开即消；已完成永不亮（用户 2026-09-27）", () => {
    const { rerender } = render(
      <Board
        board={view({
          scheduled: [
            makeRow({
              id: "a",
              name: "新到事项",
              due: "2026-09-30 18:00",
              viewed: false,
            }),
          ],
          done: [makeRow({ id: "x", name: "完成的旧事项", status: "done", viewed: false })],
        })}
        onRefresh={() => {}}
        focus={null}
        filter={{ query: "", tags: [] }}
        onTagClick={() => {}}
      />,
    );
    expect(screen.getByText("新")).toBeInTheDocument();
    // 已完成（未读）也不亮「新」：先展开默认折叠的段（否则行没渲染，断言空转）
    fireEvent.click(screen.getByText("已完成"));
    expect(screen.getByText("完成的旧事项")).toBeInTheDocument();
    // 全板只有 新到事项 一颗「新」
    expect(screen.getAllByText("新")).toHaveLength(1);

    // 点开行 → 「新」即消（本地立即消；上报失败不阻塞）
    fireEvent.click(screen.getByText("新到事项"));
    expect(screen.queryByText("新")).not.toBeInTheDocument();

    // 数据侧 viewed 翻转后重渲染不复活
    rerender(
      <Board
        board={view({
          scheduled: [
            makeRow({
              id: "a",
              name: "新到事项",
              due: "2026-09-30 18:00",
              viewed: true,
            }),
          ],
        })}
        onRefresh={() => {}}
        focus={null}
        filter={{ query: "", tags: [] }}
        onTagClick={() => {}}
      />,
    );
    expect(screen.queryByText("新")).not.toBeInTheDocument();
  });

  it("行点击展开详情（单开互斥：展开 B 自动收起 A）", () => {
    render(
      <Board
        board={view({
          scheduled: [
            makeRow({ id: "a", name: "事项甲", due: "2026-09-30 18:00" }),
            makeRow({ id: "b", name: "事项乙", due: "2026-10-01 09:00" }),
          ],
        })}
        onRefresh={() => {}}
        focus={null}
        filter={{ query: "", tags: [] }}
        onTagClick={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("事项甲"));
    // 详情走 api 拉取（测试环境请求失败 → 停在加载占位），展开数 = 1
    expect(screen.getAllByText("加载中…")).toHaveLength(1);
    fireEvent.click(screen.getByText("事项乙"));
    expect(screen.getByText("事项甲")).toBeInTheDocument(); // 行还在
    expect(screen.getAllByText("加载中…")).toHaveLength(1); // 仍只有一个展开体
  });

  it("空板：一句话空态，不出现筛选栏", () => {
    render(
      <Board
        board={view()}
        onRefresh={() => {}}
        focus={null}
        filter={{ query: "", tags: [] }}
        onTagClick={() => {}}
      />,
    );
    expect(screen.getByText(/还没有任何事项/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("过滤：标题，或 #标签")).not.toBeInTheDocument();
  });
});
