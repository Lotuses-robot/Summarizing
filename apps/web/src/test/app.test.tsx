// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { handleEsc } from "../lib/escLayer";
import { markSwipeHintSeen } from "../lib/appearance";
import { fetchUrl, jsonResponse } from "./helpers/http";
import { makeRow, view } from "./helpers/board-fixtures";
import "@testing-library/jest-dom/vitest";

/** 最小看板：一条日期未知事项（保证「日期未知」段头渲染——空库会走空态分支）。 */
const BOARD = view({ undated: [makeRow({ id: "i1", name: "测试事项" })] });

/** fetch 替身：board/uncertain/chat-history/settings 分流；uncertainFail = 只有存疑库接口挂。
 *  writes = 写请求记录（App 级 Esc flush 集成测试断言用）。 */
function stubApp(opts: { uncertainFail?: boolean } = {}): {
  writes: { method: string; url: string }[];
  boardUrls: string[];
} {
  const writes: { method: string; url: string }[] = [];
  /** 每次看板请求的 URL（含 query）——分页/折叠参数断言用。 */
  const boardUrls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = fetchUrl(input);
      const method = init?.method ?? "GET";
      if (url.includes("/api/auth/me")) {
        // 006：App 启动先探登录态——给已登录让主界面照旧
        return Promise.resolve(jsonResponse({ username: "tester", sourceToken: "a".repeat(32) }));
      }
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
      if (url.includes("/api/router")) return Promise.resolve(jsonResponse({ channels: [] }));
      if (url.includes("/api/uncertain")) {
        if (opts.uncertainFail === true) return Promise.reject(new Error("接口挂了"));
        return Promise.resolve(jsonResponse([]));
      }
      if (url.includes("/api/board")) {
        boardUrls.push(url);
        // 已完成默认折叠（本机偏好）→ 服务端按 folded 决定查不查 done 行。
        // 夹具照此给：折叠时 done 为空、只给计数。
        // 分页：展开时按 page 给不同内容（第 1 / 2 页各一条），页数固定 2——
        // 这样「点了下一页真的换了内容」是可断言的（否则从桩上分辨不出翻没翻）。
        const folded = url.includes("folded=1");
        const page = /[?&]page=(\d+)/.exec(url)?.[1] ?? "1";
        return Promise.resolve(
          jsonResponse({
            ...BOARD,
            done: folded
              ? []
              : [makeRow({ id: `d-p${page}`, name: `已完成第 ${page} 页`, status: "done" })],
            doneMeta: { folded, page: Number(page), pageCount: 2, total: 2 },
          }),
        );
      }
      if (url.includes("/api/notices")) {
        // 通知列表分页（D-136）：空列表也要给 meta / unreadTotal / tags
        return Promise.resolve(
          jsonResponse({
            notices: [],
            meta: { folded: false, page: 1, pageCount: 0, total: 0 },
            unreadTotal: 0,
            tags: [],
          }),
        );
      }
      if (url.includes("/api/trash")) {
        return Promise.resolve(
          jsonResponse({ rows: [], meta: { folded: false, page: 1, pageCount: 0, total: 0 } }),
        );
      }
      if (url.includes("/api/chat/history")) {
        return Promise.resolve(jsonResponse({ turns: [] }));
      }
      // 其余——本测试不触达
      return Promise.resolve(jsonResponse({}));
    }),
  );
  return { writes, boardUrls };
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
    // 看板先出来（三段锚点之一）
    expect(await screen.findByText("日期未知")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("存疑库审核（空）"));
    expect(await screen.findByText("存疑库审核")).toBeInTheDocument();
    expect(screen.queryByText("日期未知")).not.toBeInTheDocument(); // 主视图互斥

    handleEsc(); // App 全局 Esc 消费实际就是调它
    expect(await screen.findByText("日期未知")).toBeInTheDocument();
  });

  it("已完成段折叠时请求带 folded=1（服务端据此一个 done 行都不查）", async () => {
    const { boardUrls } = stubApp();
    render(<App />);
    expect(await screen.findByText("日期未知")).toBeInTheDocument();

    // 已完成默认折叠（appearance.ts 的 DEFAULT_FOLDED）→ 首次请求就该带 folded=1
    expect(boardUrls[0]).toContain("folded=1");
    expect(boardUrls[0]).toContain("page=1");

    // 点段头展开 → 重拉，这次带 folded=0
    fireEvent.click(screen.getByText("已完成"));
    await waitFor(() => expect(boardUrls.some((u) => u.includes("folded=0"))).toBe(true));
    // 展开后回到第 1 页（最近完成的在最上面）
    const unfolded = boardUrls.filter((u) => u.includes("folded=0"));
    expect(unfolded.every((u) => u.includes("page=1"))).toBe(true);
  });

  it("已完成段翻页真的换内容（不是只改页码）", async () => {
    markSwipeHintSeen("board");
    const { boardUrls } = stubApp();
    render(<App />);
    expect(await screen.findByText("日期未知")).toBeInTheDocument();

    fireEvent.click(screen.getByText("已完成")); // 展开
    expect(await screen.findByText("已完成第 1 页")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("下一页"));
    // ① 发了 page=2 的请求 ②界面真的换成了第 2 页的内容（只断言 ① 会把「点了没反应」漏掉）
    await waitFor(() =>
      expect(boardUrls.some((u) => u.includes("page=2") && u.includes("folded=0"))).toBe(true),
    );
    expect(await screen.findByText("已完成第 2 页")).toBeInTheDocument();
    expect(screen.queryByText("已完成第 1 页")).not.toBeInTheDocument();
  });

  it("首屏未登录（401）→ 只显示登录壳，**不**提示「后端未连接」", async () => {
    // 回归（用户实测）：服务端 401 的文案是「未登录」，里面没有 "401"；
    // App 曾用 `errText(err).includes("401")` 判登录态 → 每次打开登录页都显示「后端服务未连接」。
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = fetchUrl(input);
        if (url.includes("/api/auth/me"))
          return Promise.resolve(jsonResponse({ error: "未登录" }, 401));
        return Promise.resolve(jsonResponse({}));
      }),
    );
    render(<App />);

    expect(await screen.findByRole("button", { name: "登录" })).toBeInTheDocument();
    expect(screen.queryByText(/后端服务未连接/)).not.toBeInTheDocument();
  });

  it("后端真的挂了（网络故障）→ 登录壳上如实提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    render(<App />);

    expect(await screen.findByRole("button", { name: "登录" })).toBeInTheDocument();
    expect(await screen.findByText(/后端服务未连接/)).toBeInTheDocument();
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
    // 首次进看板会弹手势教程（全屏黑幕，Esc 先归它——模态的本意）。
    // 本用例测的是设置弹层的 Esc，先把教程标成已读过。
    markSwipeHintSeen("board");
    markSwipeHintSeen("notice");
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

describe("通知页：标签展开选择模块（与看板同款）", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("切到通知页 → 有「标签」折叠栏；点开显示通知标签空态", async () => {
    stubApp();
    render(<App />);
    expect(await screen.findByText("日期未知")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("通知（都已读过）"));
    // 标签栏在（与看板同一组件），默认折叠 → 点开见空态
    const tagToggle = await screen.findByRole("button", { name: /^标签/ });
    fireEvent.click(tagToggle);
    expect(await screen.findByText("还没有标签——通知带了标签就会出现在这")).toBeInTheDocument();
  });
});
