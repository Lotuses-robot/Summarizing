// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AboutModal } from "../components/AboutModal";
import "@testing-library/jest-dom/vitest";
// AboutModal 组件渲染（真实入口断言用户所见——评审 2026-10-13 补：此前仅纯函数有测试）。

describe("AboutModal 组件渲染", () => {
  afterEach(cleanup);

  it("头部：产品名 + 更新场景显「旧 → 新」chip（旧版/箭头/当前版）", () => {
    render(<AboutModal open onClose={() => {}} showUpgradeFrom="v0.2.0" />);
    expect(screen.getByText("Summarizing")).toBeInTheDocument();
    expect(screen.getByText("v0.2.0")).toBeInTheDocument();
    expect(screen.getByText("→")).toBeInTheDocument();
  });

  it("回滚（seen 比当前新）不画倒序箭头——退化为纯当前版", () => {
    render(<AboutModal open onClose={() => {}} showUpgradeFrom="v99.0.0" />);
    expect(screen.queryByText("→")).not.toBeInTheDocument();
  });

  it("更新日志区渲染出真实版本段标题（v*）", () => {
    render(<AboutModal open onClose={() => {}} />);
    // 真实 CHANGELOG 至少含 v0.1.0（版本段标题渲染）
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
    expect(screen.getByText("知道了")).toBeInTheDocument(); // 关闭按钮
  });

  it("open=false 不渲染", () => {
    const { container } = render(<AboutModal open={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
