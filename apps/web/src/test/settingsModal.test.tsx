// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "../components/settings/SettingsModal";
import { handleEsc } from "../lib/escLayer";
import { fetchUrl, jsonResponse } from "./helpers/http";
import "@testing-library/jest-dom/vitest";

// 设置弹层的交互守卫（设置重排 review 轮补）：AI 保存走 PUT（C1）、Esc 关闭前 flush（H1）、
// 在飞期间的后续失焦补发（H2）、读失败有错误面（M）。
// ⚠️ SettingsModal 用 document.activeElement.blur() 做关闭前 flush——测试须先 fireEvent.focus 真聚焦。

/** fetch 替身：/api/settings/ai 的 GET/PUT + /api/sources 空列表；deferFirstPut = 首条 PUT 挂起。
 *  写请求拦截记录（不打真后端）。 */
function stubAi(opts: { failGet?: boolean; deferFirstPut?: boolean } = {}): {
  calls: { method: string; url: string; body: unknown }[];
  releaseFirstPut: () => void;
} {
  const calls: { method: string; url: string; body: unknown }[] = [];
  // 受控 deferred：首条 PUT 挂着不 resolve，直到测试调 releaseFirstPut 放行
  let release: (() => void) | null = null;
  let deferred = false;
  /** 造一份 AI 设置视图（默认值 + 可选补丁）。 */
  const view = (patch: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
    baseUrl: "http://x/v1",
    model: "m1",
    apiKeyMasked: null,
    overridden: false,
    ...patch,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = fetchUrl(input);
      const method = init?.method ?? "GET";
      if (url.includes("/api/settings/ai")) {
        if (method === "PUT") {
          const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
          calls.push({ method, url, body });
          if (opts.deferFirstPut === true && !deferred) {
            deferred = true;
            return new Promise<Response>((resolve) => {
              release = () => resolve(jsonResponse(view()));
            });
          }
          return Promise.resolve(jsonResponse(view()));
        }
        if (opts.failGet === true) return Promise.reject(new Error("挂了"));
        return Promise.resolve(jsonResponse(view()));
      }
      if (url.includes("/api/sources")) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({}));
    }),
  );
  return { calls, releaseFirstPut: () => release?.() };
}

describe("设置弹层：AI 即时生效管道（设置重排 review 轮）", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("保存走 PUT（评审 C1：曾 POST 打 404——AI 设置全线存不进）", async () => {
    const { calls } = stubAi();
    render(<SettingsModal open onClose={() => {}} />);
    const input = await screen.findByDisplayValue("http://x/v1");
    fireEvent.change(input, { target: { value: "http://y/v1" } });
    fireEvent.blur(input);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.body).toMatchObject({ baseUrl: "http://y/v1" });
  });

  it("Esc 关闭前先 flush：未失焦的编辑在卸载前落库（评审 H1）", async () => {
    const { calls } = stubAi();
    const onClose = vi.fn();
    render(<SettingsModal open onClose={onClose} />);
    const input = await screen.findByDisplayValue("http://x/v1");
    input.focus(); // 真聚焦（fireEvent.focus 不设 activeElement，closeWithFlush 的 blur() 会打空）
    fireEvent.change(input, { target: { value: "http://z/v1" } });
    handleEsc(); // App 全局 Esc 消费的实际入口
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.body).toMatchObject({ baseUrl: "http://z/v1" }); // 未失焦的值没丢
    expect(onClose).toHaveBeenCalled();
  });

  it("在飞期间的后续失焦补发：busy 不再静默吞保存（评审 H2）", async () => {
    const { calls, releaseFirstPut } = stubAi({ deferFirstPut: true });
    render(<SettingsModal open onClose={() => {}} />);
    const base = await screen.findByDisplayValue("http://x/v1");
    const model = screen.getByDisplayValue("m1");

    fireEvent.change(base, { target: { value: "http://y/v1" } });
    fireEvent.blur(base); // PUT#1 挂起（在飞）
    await waitFor(() => expect(calls).toHaveLength(1));

    fireEvent.change(model, { target: { value: "m2" } });
    fireEvent.blur(model); // 在飞 → 记 pending，不静默丢

    releaseFirstPut(); // 放行 PUT#1
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.body).toMatchObject({ baseUrl: "http://y/v1", model: "m2" });
  });

  it("读失败有错误面（不拿旧表单冒充）（评审 M）", async () => {
    stubAi({ failGet: true });
    render(<SettingsModal open onClose={() => {}} />);
    expect(await screen.findByText(/读不到当前设置/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("http://x/v1")).not.toBeInTheDocument();
  });
});
