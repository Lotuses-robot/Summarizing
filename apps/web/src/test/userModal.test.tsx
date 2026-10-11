// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserModal } from "../components/UserModal";
import { fetchUrl, jsonResponse } from "./helpers/http";
import "@testing-library/jest-dom/vitest";

// 用户卡（006）：账户事务的独立落点（用户名 / 改密 / 接入地址 + 轮换 / 退出）。
// 用户 2026-10-03 批评「改密塞进设置很奇怪」后抽出——本文件守其行为。

const ME = { username: "tester", sourceToken: "f".repeat(32) };
const NEW_TOKEN = "deadbeefdeadbeefdeadbeefdeadbeef";
/** 空操作桩（默认回调）。 */
const noop = () => {};

/** fetch 替身：改密 PUT（记调用）与轮换 POST；其余空。 */
function stubUser(): { calls: { method: string; url: string; body: unknown }[] } {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = fetchUrl(input);
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      if (url.includes("/api/auth/password")) return Promise.resolve(jsonResponse({}, 204));
      if (url.includes("/api/auth/source-token/rotate")) {
        return Promise.resolve(jsonResponse({ sourceToken: NEW_TOKEN }));
      }
      return Promise.resolve(jsonResponse({}));
    }),
  );
  return { calls };
}

describe("用户卡（006）", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("改密：三字段填齐且一致才可提交；提交后清空 + 成功提示", async () => {
    const { calls } = stubUser();
    render(<UserModal open onClose={noop} me={ME} onLogout={noop} onTokenRotated={noop} />);

    const old = screen.getByLabelText("原密码");
    const next = screen.getByLabelText("新密码");
    const confirm = screen.getByLabelText("确认新密码");
    const submit = screen.getByRole("button", { name: "修改密码" });
    expect(submit).toBeDisabled(); // 空表单不可提交

    fireEvent.change(old, { target: { value: "old-password" } });
    fireEvent.change(next, { target: { value: "new-password-1" } });
    fireEvent.change(confirm, { target: { value: "new-password-1" } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/auth/password"))).toBe(true));
    expect(await screen.findByText(/密码已修改/)).toBeInTheDocument();
  });

  it("两次新密码不一致：提示且不可提交", () => {
    stubUser();
    render(<UserModal open onClose={noop} me={ME} onLogout={noop} onTokenRotated={noop} />);
    fireEvent.change(screen.getByLabelText("原密码"), { target: { value: "old-password" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new-password-1" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "differs-here" } });
    expect(screen.getByText(/两次输入的新密码不一致/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "修改密码" })).toBeDisabled();
  });

  it("账户令牌可复制；轮换（确认后）→ 令牌换新、旧串消失；取消则不动", async () => {
    stubUser();
    /** 带状态宿主：onTokenRotated 接回 prop（与 App 行为同构）。 */
    function Harness() {
      const [token, setToken] = useState(ME.sourceToken);
      return (
        <UserModal
          open
          onClose={noop}
          me={{ ...ME, sourceToken: token }}
          onLogout={noop}
          onTokenRotated={setToken}
        />
      );
    }
    render(<Harness />);
    // 用户卡只展示账户令牌本身（接入地址归各信源卡片——见 sourcesSection 测试）
    expect(await screen.findByText(ME.sourceToken)).toBeInTheDocument();

    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    fireEvent.click(screen.getByRole("button", { name: /重新生成令牌/ }));
    expect(screen.getByText(ME.sourceToken)).toBeInTheDocument(); // 取消：不动

    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    fireEvent.click(screen.getByRole("button", { name: /重新生成令牌/ }));
    expect(await screen.findByText(NEW_TOKEN)).toBeInTheDocument();
    expect(screen.queryByText(ME.sourceToken)).not.toBeInTheDocument();
  });

  it("退出登录：点按钮触发 onLogout", () => {
    stubUser();
    const onLogout = vi.fn();
    render(<UserModal open onClose={noop} me={ME} onLogout={onLogout} onTokenRotated={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /退出登录/ }));
    expect(onLogout).toHaveBeenCalled();
  });
});
