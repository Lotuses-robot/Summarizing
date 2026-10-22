// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileNav } from "../components/MobileNav";
import "@testing-library/jest-dom/vitest";

// 窄屏底部导航（D-117 二次走查，2026-10-22 用户定）：
// **左「更多」独立悬浮 · 中「事项/通知/处理」连成一组胶囊 · 右「对话」独立悬浮**；
// 「更多」「处理」点开在正上方冒气泡。断言的是**分组与交互**（哪个动作接到哪个回调、气泡开合），
// 像素级对齐由样式常量保证。

/** 造一套全 mock 的回调。 */
function mkProps() {
  return {
    view: "board" as const,
    uncertainCount: 0,
    unreadNoticeCount: 0,
    onShowBoard: vi.fn(),
    onShowNotice: vi.fn(),
    onShowUncertain: vi.fn(),
    onShowPipeline: vi.fn(),
    onShowTrash: vi.fn(),
    onOpenUsage: vi.fn(),
    onOpenAccount: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenAbout: vi.fn(),
    onToggleChat: vi.fn(),
  };
}

afterEach(cleanup);

describe("窄屏底部导航：五个入口", () => {
  it("五颗钮都在：更多 / 事项 / 通知 / 处理 / 对话", () => {
    render(<MobileNav {...mkProps()} />);
    for (const label of ["更多", "事项", "通知", "处理", "对话"]) {
      expect(screen.getByTitle(label)).toBeInTheDocument();
    }
    // 二级项未展开时不在屏幕上
    expect(screen.queryByTitle("回收站")).not.toBeInTheDocument();
    expect(screen.queryByTitle("存疑")).not.toBeInTheDocument();
  });

  it("事项 / 通知 / 对话是直接入口：点了立刻调对应回调，不展开气泡", () => {
    const p = mkProps();
    render(<MobileNav {...p} />);
    fireEvent.click(screen.getByTitle("事项"));
    expect(p.onShowBoard).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTitle("通知"));
    expect(p.onShowNotice).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTitle("对话"));
    expect(p.onToggleChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle("回收站")).not.toBeInTheDocument();
  });

  it("「处理」收拢存疑 / 流水 / 回收站三个视图", () => {
    const p = mkProps();
    render(<MobileNav {...p} />);
    fireEvent.click(screen.getByTitle("处理"));
    expect(screen.getByTitle("存疑")).toBeInTheDocument();
    expect(screen.getByTitle("流水")).toBeInTheDocument();
    expect(screen.getByTitle("回收站")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("存疑"));
    expect(p.onShowUncertain).toHaveBeenCalledTimes(1);
  });

  it("回收站从「处理」进（不与杂项混在一起）", () => {
    const p = mkProps();
    render(<MobileNav {...p} />);
    fireEvent.click(screen.getByTitle("处理"));
    fireEvent.click(screen.getByTitle("回收站"));
    expect(p.onShowTrash).toHaveBeenCalledTimes(1);
  });

  it("流水从「处理」进（各自独立回调）", () => {
    const p = mkProps();
    render(<MobileNav {...p} />);
    fireEvent.click(screen.getByTitle("处理"));
    fireEvent.click(screen.getByTitle("流水"));
    expect(p.onShowPipeline).toHaveBeenCalledTimes(1);
  });

  it("「更多」收拢用量 / 账户 / 设置 / 关于（回收站已归「处理」）", () => {
    const p = mkProps();
    render(<MobileNav {...p} />);
    expect(screen.queryByTitle("设置")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("更多"));
    for (const label of ["用量", "账户", "设置", "关于"]) {
      expect(screen.getByTitle(label)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByTitle("设置"));
    expect(p.onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

/** 钮最近的那层毛玻璃胶囊（中间三颗共享同一层；两侧独立钮各回 null）。 */
function capsule(label: string): Element | null {
  return screen.getByTitle(label).closest("div.glass.rounded-full");
}

describe("窄屏底部导航：三区结构（左独立 · 中胶囊 · 右独立）", () => {
  it("事项/通知/处理 同处一层胶囊；更多与对话各自独立", () => {
    render(<MobileNav {...mkProps()} />);
    const middle = ["事项", "通知", "处理"].map(capsule);
    expect(middle[0]).not.toBeNull();
    // 同一层胶囊 = 连成一组（组内 4px），不是三颗各自悬浮
    expect(middle[1]).toBe(middle[0]);
    expect(middle[2]).toBe(middle[0]);
    // 两侧是自己的圆钮，不在这层胶囊里
    expect(capsule("更多")).toBeNull();
    expect(screen.getByTitle("更多").className).toContain("glass");
    expect(screen.getByTitle("对话").className).toContain("bg-accent");
  });

  it("气泡挂在钮自己的容器里、与钮同轴（沿组内任一钮展开都对得上）", () => {
    render(<MobileNav {...mkProps()} />);
    fireEvent.click(screen.getByTitle("处理"));
    const anchor = screen.getByTitle("处理").parentElement;
    expect(anchor?.querySelector('button[title="存疑"]')).not.toBeNull();
  });
});

describe("窄屏底部导航：气泡开合（失焦消失）", () => {
  it("再点同一钮 = 收起气泡", () => {
    render(<MobileNav {...mkProps()} />);
    fireEvent.click(screen.getByTitle("处理"));
    expect(screen.getByTitle("存疑")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("处理"));
    expect(screen.queryByTitle("存疑")).not.toBeInTheDocument();
  });

  it("换组 = 直接切到新组的气泡（旧组的不残留）", () => {
    render(<MobileNav {...mkProps()} />);
    fireEvent.click(screen.getByTitle("处理"));
    fireEvent.click(screen.getByTitle("更多"));
    expect(screen.getByTitle("用量")).toBeInTheDocument();
    expect(screen.queryByTitle("存疑")).not.toBeInTheDocument();
  });

  it("选中二级项后气泡收起（不会留在屏幕上）", () => {
    const p = mkProps();
    render(<MobileNav {...p} />);
    fireEvent.click(screen.getByTitle("更多"));
    fireEvent.click(screen.getByTitle("关于"));
    expect(p.onOpenAbout).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle("用量")).not.toBeInTheDocument();
  });

  it("点导航之外的区域 → 收起", () => {
    render(<MobileNav {...mkProps()} />);
    fireEvent.click(screen.getByTitle("更多"));
    expect(screen.getByTitle("用量")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTitle("用量")).not.toBeInTheDocument();
  });

  it("页面滚动 → 收起", () => {
    render(<MobileNav {...mkProps()} />);
    fireEvent.click(screen.getByTitle("更多"));
    expect(screen.getByTitle("用量")).toBeInTheDocument();
    fireEvent.scroll(window);
    expect(screen.queryByTitle("用量")).not.toBeInTheDocument();
  });

  it("点直接入口（通知）时若有气泡开着，也会收起", () => {
    const p = mkProps();
    render(<MobileNav {...p} />);
    fireEvent.click(screen.getByTitle("处理"));
    expect(screen.getByTitle("存疑")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("通知"));
    expect(p.onShowNotice).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle("存疑")).not.toBeInTheDocument();
  });
});

describe("窄屏底部导航：徽标与高亮", () => {
  it("通知未读数挂在通知钮上，存疑条数挂在处理钮与存疑气泡上", () => {
    const p = { ...mkProps(), unreadNoticeCount: 3, uncertainCount: 5 };
    render(<MobileNav {...p} />);
    expect(screen.getByTitle("通知").textContent).toContain("3");
    expect(screen.getByTitle("处理").textContent).toContain("5");
    fireEvent.click(screen.getByTitle("处理"));
    expect(screen.getByTitle("存疑").textContent).toContain("5");
  });

  it("计数为 0 时不渲染角标（不留空泡）", () => {
    render(<MobileNav {...mkProps()} />);
    expect(screen.getByTitle("通知").querySelector("span.bg-warn")).toBeNull();
  });

  it("当前视图在「处理」组内（存疑）时，处理钮算当前视图", () => {
    const p = { ...mkProps(), view: "uncertain" as const };
    render(<MobileNav {...p} />);
    // 当前视图标记 = 钮内那枚小圆点不透明
    const dot = screen.getByTitle("处理").querySelector("span.rounded-full.bg-accent");
    expect(dot?.className).toContain("opacity-100");
  });

  it("展开中的钮不算当前视图（避免同屏两处绿）；当前视图的小圆点仍在", () => {
    const p = { ...mkProps(), view: "uncertain" as const };
    render(<MobileNav {...p} />);
    fireEvent.click(screen.getByTitle("处理"));
    const dot = screen.getByTitle("处理").querySelector("span.rounded-full.bg-accent");
    // 圆点 = 「当前视图」标记，展开与否都表示同一件事，不因展开而消失
    expect(dot?.className).toContain("opacity-100");
    // 展开态本身用抬起 + 中性色（不是绿底）——绿只留给当前视图
    expect(screen.getByTitle("处理").className).not.toContain("text-accent");
  });
});
