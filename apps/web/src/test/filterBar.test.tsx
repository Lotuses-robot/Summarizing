// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { FilterBar, type BoardFilter } from "../components/FilterBar";
import "@testing-library/jest-dom/vitest";

/** 受控宿主：像 App 一样真正应用 onChange（FilterBar 是受控组件，父级不落地 DOM 就不会变）。 */
function Harness({
  initial,
  onChange,
}: {
  initial: BoardFilter;
  onChange: (next: BoardFilter) => void;
}) {
  const [filter, setFilter] = useState<BoardFilter>(initial);
  return (
    <FilterBar
      filter={filter}
      allTags={["英语课", "社团"]}
      onChange={(next) => {
        onChange(next);
        setFilter(next);
      }}
    />
  );
}

/** 渲染受控宿主并取回输入框（带 token 时 placeholder 为空，用容器查）。 */
function setup(filter: BoardFilter) {
  const onChange = vi.fn();
  const { container } = render(<Harness initial={filter} onChange={onChange} />);
  const input = container.querySelector("input");
  if (!input) throw new Error("FilterBar 里没有输入框");
  return { onChange, input };
}

describe("FilterBar（顶部筛选栏，05§二 改版）", () => {
  afterEach(cleanup);

  it("输 # 出匹配下拉；Enter 确认成 token 并清空输入（token 堆在搜索框左侧）", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ query: "", tags: [] }} onChange={onChange} />);
    const input = screen.getByPlaceholderText("过滤：标题，或 #标签");
    fireEvent.change(input, { target: { value: "#英语" } });
    // 下拉只给匹配候选（未选中标签不铺开成墙）
    expect(screen.getByText("#英语课")).toBeInTheDocument();
    expect(screen.queryByText("#社团")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    // token 渲染在搜索框左侧，输入框清空
    expect(screen.getByTitle("移除该标签筛选")).toBeInTheDocument();
    expect(screen.queryByText("#社团")).not.toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ tags: ["英语课"], query: "" }),
    );
  });

  it("点 token 移除；输不存在的标签名 Enter 也能选中（建新 token）", () => {
    const { onChange } = setup({ query: "", tags: ["英语课"] });
    fireEvent.click(screen.getByTitle("移除该标签筛选"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ tags: [] }));

    const { onChange: onChange2, input: input2 } = setup({ query: "", tags: [] });
    fireEvent.change(input2, { target: { value: "#新标签" } });
    fireEvent.keyDown(input2, { key: "Enter" });
    expect(onChange2).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ["新标签"] }));
  });

  it("空框 Backspace 删末个 token", () => {
    const { onChange, input } = setup({ query: "", tags: ["英语课", "社团"] });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ["英语课"] }));
  });
});
