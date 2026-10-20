// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageSummary } from "@summarizing/shared";
import { UsageModal } from "../components/UsageModal";
import { jsonResponse } from "./helpers/http";
import "@testing-library/jest-dom/vitest";

// 用量仪表盘（010）：三个大号数字分开显示（未命中输入 / 输出 / 缓存命中）——
// 用户明确要求「缓存和输入输出都分开统计」；缓存未提供时不能拿 0 冒充。

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 用受控 fetch 替身喂真实 api.ts；按 range 参数返回对应聚合。 */
function stubUsage(byRange: Record<string, UsageSummary>): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      const range = /range=([a-z0-9]+)/.exec(url)?.[1] ?? "7d";
      const data = byRange[range];
      if (data === undefined) return Promise.resolve(jsonResponse({ error: "boom" }, 500));
      return Promise.resolve(jsonResponse(data));
    }),
  );
  return { urls };
}

/** 一份聚合（默认值 = 用户最常看的近 7 天）。 */
function makeSummary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    range: "7d",
    inputTokens: 12345,
    completionTokens: 678,
    cachedTokens: 9000,
    callCount: 12,
    ...overrides,
  };
}

describe("UsageModal", () => {
  it("三个大号数字分开显示：未命中输入 / 输出 / 缓存命中", async () => {
    stubUsage({ "7d": makeSummary() });
    render(<UsageModal open onClose={() => {}} />);

    expect(await screen.findByText("12,345")).toBeInTheDocument();
    expect(screen.getByText("678")).toBeInTheDocument();
    expect(screen.getByText("9,000")).toBeInTheDocument(); // 缓存命中——独立一项
    expect(screen.getByText("未命中输入")).toBeInTheDocument();
    expect(screen.getByText("输出")).toBeInTheDocument();
    expect(screen.getByText("缓存命中")).toBeInTheDocument();
    expect(screen.getByText("共 12 次调用")).toBeInTheDocument();
  });

  it("服务商未提供缓存字段 → 显示「服务商未提供」，不是 0", async () => {
    stubUsage({ "7d": makeSummary({ cachedTokens: null }) });
    render(<UsageModal open onClose={() => {}} />);

    await screen.findByText("12,345");
    expect(screen.getByText("服务商未提供")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("零调用：说「这段时间还没有调用」，不显示 0 次", async () => {
    stubUsage({
      "7d": makeSummary({
        inputTokens: 0,
        completionTokens: 0,
        cachedTokens: null,
        callCount: 0,
      }),
    });
    render(<UsageModal open onClose={() => {}} />);

    expect(await screen.findByText("这段时间还没有调用")).toBeInTheDocument();
  });

  it("切范围会重新拉数据，并按新范围显示", async () => {
    const { urls } = stubUsage({
      "7d": makeSummary(),
      today: makeSummary({
        range: "today",
        inputTokens: 111,
        completionTokens: 22,
        cachedTokens: 100,
      }),
    });
    render(<UsageModal open onClose={() => {}} />);
    await screen.findByText("12,345");

    fireEvent.click(screen.getByRole("tab", { name: "今日" }));
    expect(await screen.findByText("111")).toBeInTheDocument();
    expect(screen.getByText("22")).toBeInTheDocument();
    expect(urls.some((u) => u.includes("range=today"))).toBe(true);
  });

  it("默认范围 = 近 7 天", async () => {
    const { urls } = stubUsage({ "7d": makeSummary() });
    render(<UsageModal open onClose={() => {}} />);
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    expect(urls[0]).toContain("range=7d");
  });

  it("加载失败可见（不静默）", async () => {
    stubUsage({}); // 任何 range 都 500
    render(<UsageModal open onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("用量加载失败");
  });

  it("关闭态不渲染", () => {
    stubUsage({ "7d": makeSummary() });
    render(<UsageModal open={false} onClose={() => {}} />);
    expect(screen.queryByText("用量")).not.toBeInTheDocument();
  });
});
