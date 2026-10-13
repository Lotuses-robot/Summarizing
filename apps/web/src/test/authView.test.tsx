// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { fetchUrl, jsonResponse } from "./helpers/http";
import { makeRow, view } from "./helpers/board-fixtures";
import "@testing-library/jest-dom/vitest";

// 认证壳（006 T028）：未登录只有登录页（备案号挂页脚）；?code= 预填进注册视图；
// 登录成功进主界面；受保护请求 401 → 单点拦截切回认证壳。

const BOARD = view({ undated: [makeRow({ id: "i1", name: "测试事项" })] });
const TOKEN = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";

/** fetch 替身：认证 + 主界面数据分流；loggedIn 随登录调用翻转（me 据此 200/401）。
 *  uncertain401After = 第 N 次之后的存疑库读返回 401（测单点拦截切壳）。 */
function stubAuth(opts: { initialLoggedIn?: boolean; uncertain401After?: number } = {}) {
  let loggedIn = opts.initialLoggedIn === true;
  let uncertainReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = fetchUrl(input);
      if (url.includes("/api/auth/login")) {
        loggedIn = true;
        return Promise.resolve(jsonResponse({ username: "tester" }));
      }
      if (url.includes("/api/auth/me")) {
        return Promise.resolve(
          loggedIn
            ? jsonResponse({ username: "tester", sourceToken: TOKEN })
            : jsonResponse({ error: "未登录" }, 401),
        );
      }
      if (url.includes("/api/board")) return Promise.resolve(jsonResponse(BOARD));
      if (url.includes("/api/uncertain")) {
        uncertainReads += 1;
        if (opts.uncertain401After !== undefined && uncertainReads > opts.uncertain401After) {
          return Promise.resolve(jsonResponse({ error: "未登录" }, 401));
        }
        return Promise.resolve(jsonResponse([]));
      }
      if (url.includes("/api/sources")) return Promise.resolve(jsonResponse([]));
      if (url.includes("/api/chat/history")) return Promise.resolve(jsonResponse({ turns: [] }));
      return Promise.resolve(jsonResponse({}));
    }),
  );
}

describe("认证壳（006）", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("未登录：只有登录页 + 备案号页脚；主界面不可见", async () => {
    stubAuth();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "登录" })).toBeInTheDocument();
    expect(screen.getByText("粤ICP备2026147541号-1")).toBeInTheDocument();
    expect(screen.queryByText("日期未知")).not.toBeInTheDocument();
  });

  it("?code= 预填 → 进注册视图且邀请码已填", async () => {
    window.history.replaceState(null, "", "/register?code=ABCDE12345");
    stubAuth();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "注册" })).toBeInTheDocument();
    expect(screen.getByLabelText("邀请码")).toHaveValue("ABCDE12345");
  });

  it("注册失败显示 zod issues 的真话（A13：不再只显示「请求体不合法」）", async () => {
    window.history.replaceState(null, "", "/register?code=ABCDE12345");
    // 服务端校验失败返 {error, issues}——本用例专测 authErrorText 优先显示 issues[].message
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const url = fetchUrl(input);
        if (url.includes("/api/auth/register")) {
          return Promise.resolve(
            jsonResponse(
              { error: "请求体不合法", issues: [{ message: "用户名至少 2 个字符" }] },
              400,
            ),
          );
        }
        return Promise.resolve(jsonResponse({ error: "未登录" }, 401)); // me（未登录）
      }),
    );
    render(<App />);
    await screen.findByRole("heading", { name: "注册" });
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "a" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "pw12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    // 真话上屏（而非笼统的「请求体不合法」）
    expect(await screen.findByText("用户名至少 2 个字符")).toBeInTheDocument();
    expect(screen.queryByText("请求体不合法")).not.toBeInTheDocument();
  });

  it("登录成功 → 主界面（看板出现）", async () => {
    stubAuth();
    render(<App />);
    await screen.findByRole("heading", { name: "登录" });
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "tester" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "pw12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("日期未知")).toBeInTheDocument();
  });

  it("受保护请求 401 → 单点拦截切回认证壳", async () => {
    stubAuth({ initialLoggedIn: true, uncertain401After: 1 });
    render(<App />);
    expect(await screen.findByText("日期未知")).toBeInTheDocument();
    // 点审核触发再一次 uncertain 拉取 → 401 → 拦截回壳
    fireEvent.click(screen.getByTitle("存疑库审核（空）"));
    expect(await screen.findByRole("heading", { name: "登录" })).toBeInTheDocument();
  });
});
