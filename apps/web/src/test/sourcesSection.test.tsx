// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourcesSection } from "../components/settings/SourcesSection";
import { emptyResponse, fetchUrl, jsonResponse } from "./helpers/http";
import "@testing-library/jest-dom/vitest";

/** 测试令牌（hookPath 用）。 */
const TOKEN = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";

/** 渲染信源区（006：接入地址/令牌轮换已移入用户卡——本区只列信源）。 */
function renderSection() {
  return render(<SourcesSection />);
}

/** 当前时刻往前 minutes 分钟的北京墙钟串（源活动时间戳用）。 */
function beijingAgo(minutes: number): string {
  const d = new Date(Date.now() + 8 * 60 * 60_000 - minutes * 60_000);
  /** 两位数补零。 */
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** fetch 替身：按 URL/method 分流（列表 / 读值 / 写值）；记录写调用与读值次数。
 *  writeFail = 写操作拒绝（模拟后端故障——失败必须可见）。 */
function stubApi(
  settings: Record<string, unknown>,
  opts: {
    writeFail?: boolean;
    settingsSchema?: unknown[];
    hookPath?: string | null;
    /** 「收到」信号的时刻（喂给默认 activity 声明）。 */
    eventAt?: string;
    /** 「入库」信号的时刻。 */
    ingestAt?: string;
    state?: "ok" | "error";
    /** 覆盖活动信号声明（默认模拟 nc：收到 + 入库）。 */
    activity?: { label: string; at?: string }[];
    /** 接入引导（适配器声明；默认模拟 nc 的引导文案）。 */
    guide?: string;
  } = {},
): {
  writes: { url: string; method: string; body: unknown }[];
  readCount: () => number;
} {
  const writes: { url: string; method: string; body: unknown }[] = [];
  let reads = 0; // 只计「设置值读」（/api/sources 列表在下面提前分流，不计入）
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = fetchUrl(input);
      if (init?.method === "PUT" || init?.method === "DELETE") {
        if (opts.writeFail === true) return Promise.reject(new Error("网络挂了"));
        const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
        writes.push({ url, method: init.method, body });
        return Promise.resolve(emptyResponse(204));
      }
      if (url.endsWith("/api/sources")) {
        const state = opts.state ?? "error";
        return Promise.resolve(
          jsonResponse([
            {
              name: "nc",
              state,
              lastError: state === "error" ? "封批失败（群 123）" : undefined,
              // 活动信号由适配器声明（2026-10-21）：前端只按 label 渲染，不认识含义。
              // 未给时刻 = 该信号「从未发生」（JSON 里 at 缺席）。
              activity: opts.activity ?? [
                { label: "收到", at: opts.eventAt },
                { label: "入库", at: opts.ingestAt },
              ],
              guide: opts.guide ?? "填进 nc 的网络配置 → HTTP 服务器",
              settings: opts.settingsSchema ?? [
                {
                  key: "groups",
                  type: "record",
                  label: "群白名单",
                  description: "只收这些群的消息",
                },
                { key: "windowMinutes", type: "number", label: "打包窗长（分钟）", default: 3 },
              ],
              // 接入路径由后端下发（006；可用 opts.hookPath 覆盖）
              hookPath: opts.hookPath === undefined ? "/hook/TOKEN/nc/event" : opts.hookPath,
            },
          ]),
        );
      }
      // 读设置值（只读一次——即时生效模式无「保存后回读」）
      reads += 1;
      return Promise.resolve(jsonResponse(settings));
    }),
  );
  return { writes, readCount: () => reads };
}

describe("设置·信源区（D-89 / 走查修订③：分组卡 + 改完即生效）", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("渲染：卡头=源名+状态+最近出错；行=左标签右控件；record 行编辑、number 现值", async () => {
    stubApi({ groups: { "123": "英语课官方群" }, windowMinutes: 5 });
    renderSection();
    expect(await screen.findByText("nc")).toBeInTheDocument();
    expect(screen.getByText("最近出错")).toBeInTheDocument();
    expect(screen.getByText(/封批失败（群 123）/)).toBeInTheDocument();
    // 值加载完成后行才渲染：标签在左、控件在右
    expect(await screen.findByText("群白名单")).toBeInTheDocument();
    expect(screen.getByText("打包窗长（分钟）")).toBeInTheDocument();
    // record 键值对行 + number 现值
    expect(screen.getByDisplayValue("123")).toBeInTheDocument();
    expect(screen.getByDisplayValue("英语课官方群")).toBeInTheDocument();
    const num = screen.getByDisplayValue("5");
    expect(num).toHaveAttribute("type", "number");
  });

  it("改 number 失焦即存：PUT 改动键 + 一闪「已保存」", async () => {
    const { writes } = stubApi({ windowMinutes: 5 });
    renderSection();
    const num = await screen.findByDisplayValue("5");
    fireEvent.change(num, { target: { value: "8" } });
    expect(writes).toHaveLength(0); // 输入中不写
    fireEvent.blur(num);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.method).toBe("PUT");
    expect(writes[0]?.url).toBe("/api/sources/nc/settings/windowMinutes");
    expect(writes[0]?.body).toBe(8);
    expect(await screen.findByText("已保存")).toBeInTheDocument();
    // 失焦又聚焦、值没变 → 不重复写
    fireEvent.blur(num);
    expect(writes).toHaveLength(1);
  });

  it("清空 number 失焦 = DELETE 回默认：输入变空 + placeholder 3 + 「已恢复默认」", async () => {
    const { writes } = stubApi({ windowMinutes: 5 });
    renderSection();
    const num = await screen.findByDisplayValue("5");
    fireEvent.change(num, { target: { value: "" } });
    fireEvent.blur(num);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.method).toBe("DELETE");
    expect(await screen.findByText(/已恢复默认/)).toBeInTheDocument();
    const cleared = screen.getByPlaceholderText("3");
    if (!(cleared instanceof HTMLInputElement)) throw new Error("数字字段不是输入框");
    expect(cleared.value).toBe("");
  });

  it("record 改值失焦整对象 PUT；加一行（先值后键）最终一次写含新键；空行不写", async () => {
    const { writes } = stubApi({ groups: { "123": "英语课官方群" } });
    renderSection();
    // 改既有行备注 → 失焦即存整对象
    const rec = await screen.findByDisplayValue("英语课官方群");
    fireEvent.change(rec, { target: { value: "英语群" } });
    fireEvent.blur(rec);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toEqual({ "123": "英语群" });

    // 加一行：空行不写
    fireEvent.click(screen.getByText("添加一行"));
    const keyInputs = screen.getAllByPlaceholderText("键");
    const valInputs = screen.getAllByPlaceholderText("值");
    const keyInput = keyInputs[keyInputs.length - 1];
    const valInput = valInputs[valInputs.length - 1];
    if (keyInput === undefined || valInput === undefined) throw new Error("新行输入框缺失");
    fireEvent.blur(keyInput); // 空键 → 对象不变 → 不写
    expect(writes).toHaveLength(1);
    // 先填值、再填键、失焦 → 一次写含新键（填值后在键框失焦那刻对象仍与新键无关）
    fireEvent.change(valInput, { target: { value: "社团群" } });
    fireEvent.blur(valInput); // 键为空 → 不写
    expect(writes).toHaveLength(1);
    fireEvent.change(keyInput, { target: { value: "456" } });
    fireEvent.blur(keyInput);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.body).toEqual({ "123": "英语群", "456": "社团群" });
  });

  it("写失败 → 常驻红字（不静默）", async () => {
    stubApi({ windowMinutes: 5 }, { writeFail: true });
    renderSection();
    const num = await screen.findByDisplayValue("5");
    fireEvent.change(num, { target: { value: "8" } });
    fireEvent.blur(num);
    expect(await screen.findByText(/保存失败/)).toBeInTheDocument();
  });

  it("无声明设置的源不发废 GET", async () => {
    const { readCount } = stubApi({}, { settingsSchema: [] });
    renderSection();
    await screen.findByText("这个信源没有可配置项");
    expect(readCount()).toBe(0);
  });

  it("boolean/select 点了即存、secret 失焦即存（FieldInput 写路径全型守门）", async () => {
    const { writes } = stubApi(
      { notify: false, mode: "a" },
      {
        settingsSchema: [
          { key: "notify", type: "boolean", label: "到货通知" },
          { key: "mode", type: "select", label: "模式", options: ["a", "b"] },
          { key: "token", type: "secret", label: "令牌" },
        ],
      },
    );
    const { container } = renderSection();
    const box = await screen.findByRole("checkbox");
    fireEvent.click(box);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toBe(true);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.body).toBe("b");

    const secret = container.querySelector('input[type="password"]');
    if (!(secret instanceof HTMLInputElement)) throw new Error("secret 输入框缺失");
    fireEvent.change(secret, { target: { value: "s3cret" } });
    fireEvent.blur(secret);
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[2]?.body).toBe("s3cret");
  });

  it("清空回默认后再失焦：不重复 DELETE（基线乐观清理的守门）", async () => {
    const { writes } = stubApi({ windowMinutes: 5 });
    renderSection();
    const num = await screen.findByDisplayValue("5");
    fireEvent.change(num, { target: { value: "" } });
    fireEvent.blur(num);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.method).toBe("DELETE");
    fireEvent.blur(num); // 基线已乐观记「回到未设置」→ 不再发
    expect(writes).toHaveLength(1);
  });

  it("删行按钮 → 整对象落库（写请求不含被删行）", async () => {
    const { writes } = stubApi({ groups: { "123": "英语课官方群" } });
    renderSection();
    await screen.findByDisplayValue("英语课官方群");
    fireEvent.click(screen.getByTitle("删这一行"));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.method).toBe("PUT");
    expect(writes[0]?.body).toEqual({});
  });

  it("接入地址：由后端下发的 hookPath 拼站点源展示（前端零拼接）；可复制", async () => {
    stubApi({}, { hookPath: `/hook/${TOKEN}/nc/event` });
    renderSection();
    expect(
      await screen.findByText(`${location.origin}/hook/${TOKEN}/nc/event`),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(await screen.findByText("已复制")).toBeInTheDocument();
  });

  it("无登记路径的源（hookPath=null）不显示接入地址行", async () => {
    stubApi({}, { hookPath: null });
    renderSection();
    await screen.findByText("nc");
    expect(screen.queryByText("接入地址")).not.toBeInTheDocument();
  });

  it("卡头 chip 按适配器声明的顺序渲染「收到 · 入库」相对时间", async () => {
    stubApi({}, { state: "ok", eventAt: beijingAgo(5), ingestAt: beijingAgo(120) });
    renderSection();
    expect(await screen.findByText("收到 5 分钟前 · 入库 2 小时前")).toBeInTheDocument();
  });

  it("从未有过活动：按声明逐个写「从未<label>」，不编造时间", async () => {
    stubApi({}, { state: "ok" });
    renderSection();
    expect(await screen.findByText("从未收到 · 从未入库")).toBeInTheDocument();
  });

  it("无 webhook 的源：信号由适配器决定（这里只声明「入库」）", async () => {
    stubApi({}, { state: "ok", hookPath: null, activity: [{ label: "入库", at: beijingAgo(1) }] });
    renderSection();
    expect(await screen.findByText(/^入库 (1 分钟前|刚刚)$/)).toBeInTheDocument();
    expect(screen.queryByText(/收到/)).not.toBeInTheDocument();
  });

  it("适配器没声明任何活动信号 → 不渲染空 chip", async () => {
    stubApi({}, { state: "ok", activity: [] });
    renderSection();
    await screen.findByText("nc");
    expect(screen.queryByTitle(/：/)).not.toBeInTheDocument();
  });

  it("接入引导来自适配器（summary.guide），前端零硬编码", async () => {
    stubApi({}, { state: "ok", guide: "把 webhook 指到本页地址" });
    renderSection();
    expect(await screen.findByText("把 webhook 指到本页地址")).toBeInTheDocument();
  });

  it("出错态：卡头仍是「最近出错」，不显示活动时间", async () => {
    stubApi({}, { state: "error", eventAt: beijingAgo(5), ingestAt: beijingAgo(120) });
    renderSection();
    expect(await screen.findByText("最近出错")).toBeInTheDocument();
    expect(screen.queryByText(/^收到 /)).not.toBeInTheDocument();
  });
});
