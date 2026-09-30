// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown, parseMarkdown } from "../lib/markdown";
import "@testing-library/jest-dom/vitest";

// 前台回复的 Markdown 子集（2026-09-30 插播）：多行保真 + 基本样式 + 链接白名单。

describe("Markdown 子集渲染", () => {
  afterEach(cleanup);

  it("单换行在段内保真（whitespace-pre-wrap），空行分段", () => {
    const { container } = render(<Markdown text={"第一行\n第二行\n\n新的一段"} />);
    const ps = container.querySelectorAll("p");
    expect(ps).toHaveLength(2);
    expect(ps[0]?.textContent).toBe("第一行\n第二行");
    expect(ps[0]?.className).toContain("whitespace-pre-wrap");
    expect(ps[1]?.textContent).toBe("新的一段");
  });

  it("无序/有序列表成组渲染；列表前后段落正确断开", () => {
    render(<Markdown text={"先说一句：\n- 甲\n- 乙\n\n1. 一\n2. 二"} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["甲", "乙", "一", "二"]);
    expect(document.querySelectorAll("ul")).toHaveLength(1);
    expect(document.querySelectorAll("ol")).toHaveLength(1);
  });

  it("粗体/行内代码/标题", () => {
    const { container } = render(<Markdown text={"## 标题\n**加粗** 与 `代码`"} />);
    const heading = screen.getByText("标题").closest("p");
    expect(heading?.className).toContain("font-semibold");
    expect(container.querySelector("strong")?.textContent).toBe("加粗");
    expect(container.querySelector("code")?.textContent).toBe("代码");
  });

  it("链接：http(s) 放行（新窗口 + noreferrer）；javascript: 按纯文本渲染（不产生 a 标签）", () => {
    const { container } = render(
      <Markdown text={"[作业页](https://example.com/hw) 与 [坏链](javascript:alert(1))"} />,
    );
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com/hw");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noreferrer");
    expect(container.querySelectorAll("a")).toHaveLength(1); // 坏链没有变成链接
    expect(container.textContent).toContain("[坏链](javascript:alert(1))");
  });

  it("空文本/纯空白 → 不渲染任何块", () => {
    const { container } = render(<Markdown text={"  \n\n"} />);
    expect(container.firstChild).toBeNull();
    expect(parseMarkdown("")).toEqual([]);
  });

  it("列表项内的行内样式与段内换行都保留", () => {
    render(<Markdown text={"- **重要** 事项\n  明细行"} />);
    const li = screen.getByRole("listitem");
    expect(li.querySelector("strong")?.textContent).toBe("重要");
    expect(li.textContent).toContain("明细行");
  });
});
