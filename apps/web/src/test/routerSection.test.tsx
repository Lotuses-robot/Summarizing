// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterSection } from "../components/settings/RouterSection";
import { fetchUrl, jsonResponse } from "./helpers/http";
import "@testing-library/jest-dom/vitest";

// 路由区（D-130 账户侧）：开关点了即存、绑定码整段提交。
// 这里守用户**看到的那行字**与**发出的是什么请求**——不测后端逻辑（routerApi.test.ts 管那半）。

/** fetch 替身：GET /api/router 回给定视图；PUT 记录并按需失败。 */
function stubRouter(
  view: { enabled: boolean; bindings: string[] },
  opts: { failPut?: boolean } = {},
): { calls: { method: string; url: string; body: unknown }[] } {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = fetchUrl(input);
      const method = init?.method ?? "GET";
      if (url.includes("/api/router")) {
        if (method !== "GET") {
          const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
          calls.push({ method, url, body });
          if (opts.failPut === true) {
            return Promise.resolve(jsonResponse({ error: "挂了" }, 500));
          }
          return Promise.resolve(jsonResponse({ ok: true }));
        }
        return Promise.resolve(jsonResponse(view));
      }
      return Promise.resolve(jsonResponse({}));
    }),
  );
  return { calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("路由区：读", () => {
  it("列出已有的绑定码；开关反映当前状态", async () => {
    stubRouter({ enabled: false, bindings: ["cust-A", "cust-B"] });
    render(<RouterSection id="s" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("cust-A")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("cust-B")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("读失败 → 可见错误（不静默留个空界面）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("挂了"))),
    );
    render(<RouterSection id="s" />);
    await waitFor(() => {
      expect(screen.getByText(/读取路由设置失败/)).toBeInTheDocument();
    });
  });
});

describe("路由区：写", () => {
  it("拨开关 → 立刻 PUT enabled", async () => {
    const { calls } = stubRouter({ enabled: true, bindings: [] });
    render(<RouterSection id="s" />);
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());

    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/api/router/enabled"))).toBe(true);
    });
    const call = calls.find((c) => c.url.includes("/api/router/enabled"));
    expect(call?.body).toEqual({ enabled: false });
  });

  it("加一条绑定码并失焦 → PUT 整段码表", async () => {
    const { calls } = stubRouter({ enabled: true, bindings: [] });
    render(<RouterSection id="s" />);
    await waitFor(() => expect(screen.getByText("添加绑定码")).toBeInTheDocument());

    fireEvent.click(screen.getByText("添加绑定码"));
    const input = screen.getByPlaceholderText("粘贴客户给你的绑定码");
    fireEvent.change(input, { target: { value: "cust-NEW" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/api/router/bindings"))).toBe(true);
    });
    const call = calls.find((c) => c.url.includes("/api/router/bindings"));
    expect(call?.body).toEqual({ bindings: ["cust-NEW"] });
  });

  it("删一条 → PUT 剩下那几条", async () => {
    const { calls } = stubRouter({ enabled: true, bindings: ["cust-A", "cust-B"] });
    render(<RouterSection id="s" />);
    await waitFor(() => expect(screen.getByDisplayValue("cust-B")).toBeInTheDocument());

    // 第二个删除钮 = cust-B 那一行
    const dels = screen.getAllByTitle("删这一条");
    fireEvent.click(dels[1] as HTMLElement);

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/api/router/bindings"))).toBe(true);
    });
    const call = calls.find((c) => c.url.includes("/api/router/bindings"));
    expect(call?.body).toEqual({ bindings: ["cust-A"] });
  });

  it("保存失败 → 常驻红字（不静默）", async () => {
    stubRouter({ enabled: true, bindings: ["cust-A"] }, { failPut: true });
    render(<RouterSection id="s" />);
    await waitFor(() => expect(screen.getByDisplayValue("cust-A")).toBeInTheDocument());

    fireEvent.blur(screen.getByDisplayValue("cust-A"));
    await waitFor(() => {
      expect(screen.getByText(/保存失败/)).toBeInTheDocument();
    });
  });
});
