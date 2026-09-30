// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { handleEsc } from "../lib/escLayer";
import { fetchUrl, jsonResponse } from "./helpers/http";
import { makeRow, view } from "./helpers/board-fixtures";
import "@testing-library/jest-dom/vitest";

/** 最小看板：一条日期未知事项（保证「日期未知」段头渲染——空库会走空态分支）。 */
const BOARD = view({ undated: [makeRow({ id: "i1", name: "测试事项" })] });

/** fetch 替身：board/uncertain/chat-history/settings 分流；uncertainFail = 只有存疑库接口挂。
 *  writes = 写请求记录（App 级 Esc flush 集成测试断言用）。 */
function stubApp(opts: { uncertainFail?: boolean } = {}): {
  writes: { method: string; url: string }[];
} {
  const writes: { method: string; url: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = fetchUrl(input);
      const method = init?.method ?? "GET";
      if (url.includes("/api/settings/ai")) {
        if (method === "PUT") writes.push({ method, url });
        return Promise.resolve(
          jsonResponse({
            baseUrl: "http://x/v1",
            model: "m1",
            apiKeyMasked: null,
            overridden: false,
          }),
        );
      }
      if (url.includes("/api/sources")) return Promise.resolve(jsonResponse([]));
      if (url.includes("/api/uncertain")) {
        if (opts.uncertainFail === true) return Promise.reject(new Error("接口挂了"));
        return Promise.resolve(jsonResponse([]));
      }
      if (url.includes("/api/board")) {
        return Promise.resolve(jsonResponse(BOARD));
      }
      if (url.includes("/api/chat/history")) {
        return Promise.resolve(jsonResponse({ turns: [] }));
      }
      // 其余——本测试不触达
      return Promise.resolve(jsonResponse({}));
    }),
  );
  return { writes };
}

describe("App 接线（D-89：主视图切换 / Esc 分层 / 审核页错误面）", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("点活动栏 ⚠ → 审核页；Esc → 回看板", async () => {
    stubApp();
    render(<App />);
    // 看板先出来（四段锚点之一）
    expect(await screen.findByText("日期未知")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("存疑库审核（空）"));
    expect(await screen.findByText("存疑库审核")).toBeInTheDocument();
    expect(screen.queryByText("日期未知")).not.toBeInTheDocument(); // 主视图互斥

    handleEsc(); // App 全局 Esc 消费实际就是调它
    expect(await screen.findByText("日期未知")).toBeInTheDocument();
  });

  it("存疑库接口挂掉 → 审核页也有可见错误面（不拿假空态说事——评审 C1）", async () => {
    stubApp({ uncertainFail: true });
    render(<App />);
    expect(await screen.findByText("日期未知")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("存疑库审核（空）"));
    expect(await screen.findByText("存疑库审核")).toBeInTheDocument();
    expect(await screen.findByText(/存疑库拉取失败/)).toBeInTheDocument();
  });

  it("设置弹层 App 级键盘接线：点设置 → 改输入 → Esc → 关闭前 flush 落库（评审 H1 App 层守门）", async () => {
    const { writes } = stubApp();
    render(<App />);
    expect(await screen.findByText("日期未知")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("设置"));
    const input = await screen.findByDisplayValue("http://x/v1");
    input.focus(); // 真聚焦——closeWithFlush 的 blur() 才会派发 focusout
    fireEvent.change(input, { target: { value: "http://y/v1" } });
    fireEvent.keyDown(window, { key: "Escape" }); // 真走 App 全局 keydown → escLayer → closeWithFlush

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.method).toBe("PUT");
    await waitFor(() => expect(screen.queryByDisplayValue("http://y/v1")).not.toBeInTheDocument());
  });
});
