// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickActiveSection, SettingsModal } from "../components/settings/SettingsModal";
import { handleEsc } from "../lib/escLayer";
import { fetchUrl, jsonResponse } from "./helpers/http";
import "@testing-library/jest-dom/vitest";

// 设置弹层的交互守卫（设置重排 review 轮补）：AI 保存走 PUT（C1）、Esc 关闭前 flush（H1）、
// 在飞期间的后续失焦补发（H2）、读失败有错误面（M）。
// ⚠️ SettingsModal 用 document.activeElement.blur() 做关闭前 flush——测试须先 fireEvent.focus 真聚焦。
// 006：账户面已移入独立 UserModal——SettingsModal 不再收 me/onLogout/onTokenRotated。

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

describe("滚动联动判定（用户走查 2026-10-03 修）", () => {
  it("滚到底（atBottom）：最后一段必须点亮——即使它顶不到容器顶（真 bug 的根因）", () => {
    // 滚到最底：信源顶边仍在容器顶下方（正距离，顶不到顶）——旧的「top≤0 才算」会让它永远落选
    expect(
      pickActiveSection(
        new Map([
          ["appearance", -1200],
          ["ai", -900],
          ["data", -300],
          ["sources", 180], // 顶不到顶
        ]),
        true,
      ),
    ).toBe("sources");
  });

  it("常规滚动：取顶边最接近容器顶的一段（含尚未越顶的正距离）", () => {
    // 中段：data 顶边 -40（刚过顶）最接近 0 → data
    expect(
      pickActiveSection(
        new Map([
          ["appearance", -600],
          ["ai", -40],
          ["data", 300],
          ["sources", 800],
        ]),
      ),
    ).toBe("ai");
    // 刚打开：appearance 顶边 +10 最接近顶 → appearance
    expect(
      pickActiveSection(
        new Map([
          ["appearance", 10],
          ["ai", 400],
        ]),
      ),
    ).toBe("appearance");
    // 滚到 sources 顶边 -5（已过顶）→ sources
    expect(
      pickActiveSection(
        new Map([
          ["appearance", -1200],
          ["ai", -900],
          ["data", -500],
          ["sources", -5],
        ]),
      ),
    ).toBe("sources");
  });
});

/** 拒收规则区 fetch 替身（D-107）：GET/PUT /api/settings/rejection-rules。
 *  写请求记录；stored 记录服务端最后存的值（断言「失焦即存」真的发出去了）。 */
function stubRules(): { puts: { rules: string }[] } {
  const puts: { rules: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = fetchUrl(input);
      const method = init?.method ?? "GET";
      if (url.includes("/api/settings/ai")) {
        return Promise.resolve(
          jsonResponse({
            baseUrl: "http://x/v1",
            model: "m1",
            apiKeyMasked: null,
            overridden: false,
          }),
        );
      }
      if (url.includes("/api/settings/rejection-rules")) {
        if (method === "PUT") {
          const parsed: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
          const rules =
            typeof parsed === "object" && parsed !== null && "rules" in parsed
              ? String(parsed.rules)
              : "";
          puts.push({ rules });
          return Promise.resolve(jsonResponse({ rules }));
        }
        return Promise.resolve(jsonResponse({ rules: "" }));
      }
      if (url.includes("/api/sources")) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({}));
    }),
  );
  return { puts };
}

describe("设置弹层：收取规则（D-107）", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("左栏有「收取规则」入口；渲染出规则文本框", async () => {
    stubRules();
    render(<SettingsModal open onClose={() => {}} />);
    // 左栏按钮 + 分区标题都叫「收取规则」——两处都在（≥2）
    expect((await screen.findAllByText("收取规则")).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByPlaceholderText(/拼多多砍一刀/)).toBeInTheDocument();
  });

  it("失焦即存：改了规则后 blur → PUT 发出，body 带 rules", async () => {
    const { puts } = stubRules();
    render(<SettingsModal open onClose={() => {}} />);
    const box = await screen.findByPlaceholderText(/拼多多砍一刀/);
    fireEvent.change(box, { target: { value: "不要集赞拉票" } });
    fireEvent.blur(box);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.rules).toBe("不要集赞拉票");
  });

  it("没改动就不发 PUT（不制造无意义写）", async () => {
    const { puts } = stubRules();
    render(<SettingsModal open onClose={() => {}} />);
    const box = await screen.findByPlaceholderText(/拼多多砍一刀/);
    fireEvent.focus(box);
    fireEvent.blur(box);
    await waitFor(() => expect(screen.getByPlaceholderText(/拼多多砍一刀/)).toBeInTheDocument());
    expect(puts).toHaveLength(0);
  });

  it("Esc 关闭前 flush：改完没失焦，Esc 也能把规则发出去（评审 H1 同款守卫）", async () => {
    const { puts } = stubRules();
    render(<SettingsModal open onClose={() => {}} />);
    const box = await screen.findByPlaceholderText(/拼多多砍一刀/);
    fireEvent.change(box, { target: { value: "esc 前存下" } });
    handleEsc(); // App 的全局 Esc 消费实际就是调它（本测试单渲染 Modal，没有 App 在听 keydown）
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.rules).toBe("esc 前存下");
  });
});
