// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatResponse } from "@summarizing/shared";
import { ChatPanel } from "../components/chat/ChatPanel";
import "@testing-library/jest-dom/vitest";
import { fetchUrl, jsonResponse } from "./helpers/http";

/** 受控 fetch 替身：记录请求体；fail=true 时模拟网络故障。
 *  /api/chat/history 按 URL 分流（回填请求），其余走 chat 应答。 */
function stubChat(
  response: ChatResponse,
  opts: { fail?: boolean; history?: { role: string; content: string; at: string }[] } = {},
): { bodies: unknown[] } {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = fetchUrl(input);
      if (url.includes("/api/chat/history")) {
        if (opts.fail === true) return Promise.reject(new Error("网络挂了"));
        return Promise.resolve(jsonResponse({ turns: opts.history ?? [] }));
      }
      if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
      if (opts.fail === true) return Promise.reject(new Error("网络挂了"));
      return Promise.resolve(jsonResponse(response));
    }),
  );
  return { bodies };
}

describe("ChatPanel（对话面板，05§四）", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("回复渲染气泡 + 工具轨迹 chips + 事项 chips；点事项 chip 深链", async () => {
    const onFocus = vi.fn();
    stubChat({
      reply: "有 1 件：英语作业。",
      actions: [
        { tool: "get_board", note: "查了看板" },
        { tool: "get_item", note: "看了「英语作业」" },
      ],
      references: [{ id: "it1", title: "英语作业" }],
    });
    render(
      <ChatPanel
        items={[{ id: "it1", title: "英语作业" }]}
        onActivity={() => {}}
        onRequestFocus={onFocus}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/问一句/), {
      target: { value: "最近有什么要交的" },
    });
    fireEvent.click(screen.getByText("发送"));

    expect(await screen.findByText("有 1 件：英语作业。")).toBeInTheDocument();
    expect(screen.getByText("查了看板")).toBeInTheDocument();
    expect(screen.getByText("看了「英语作业」")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("在看板中定位这条事项"));
    expect(onFocus).toHaveBeenCalledWith("it1");
    // 首条消息无历史（空数组），当前消息在 body
  });

  it("失败：原话退回输入框、本地占位不进 history", async () => {
    const first = stubChat({ reply: "", actions: [], references: [] }, { fail: true });
    render(
      <ChatPanel
        items={[{ id: "it1", title: "英语作业" }]}
        onActivity={() => {}}
        onRequestFocus={() => {}}
        onClose={() => {}}
      />,
    );
    const input = screen.getByPlaceholderText(/问一句/);

    fireEvent.change(input, { target: { value: "英语课周三交作文" } });
    fireEvent.click(screen.getByText("发送"));
    expect(await screen.findByText(/前台暂时联系不上/)).toBeInTheDocument();
    expect(input).toHaveValue("英语课周三交作文"); // 原话退回

    // 改一字重发：history 只含上一轮真实 user 消息，不含本地占位
    const second = stubChat({ reply: "好的。", actions: [], references: [] });
    fireEvent.change(input, { target: { value: "英语课周三交作文。" } });
    fireEvent.click(screen.getByText("发送"));
    await screen.findByText("好的。");
    expect(first.bodies[0]).toMatchObject({ message: "英语课周三交作文", history: [] });
    expect(second.bodies[0]).toMatchObject({
      history: [{ role: "user", content: "英语课周三交作文" }],
    });
  });

  it("@ 提及：下拉选择插入文本，mentions 随请求上传（2026-09-27）", async () => {
    const { bodies } = stubChat({ reply: "知道了。", actions: [], references: [] });
    render(
      <ChatPanel
        items={[
          { id: "it1", title: "英语作业" },
          { id: "it2", title: "社团例会" },
        ]}
        onActivity={() => {}}
        onRequestFocus={() => {}}
        onClose={() => {}}
      />,
    );
    const input = screen.getByPlaceholderText(/问一句/);
    fireEvent.change(input, { target: { value: "看 @英" } });
    // 下拉按已输片段匹配
    expect(screen.getByText("@英语作业")).toBeInTheDocument();
    expect(screen.queryByText("@社团例会")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("@英语作业"));
    // @片段替换为完整提及，mentions 记录在案
    expect(input).toHaveValue("看 @英语作业 ");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("知道了。");
    expect(bodies[0]).toMatchObject({
      message: "看 @英语作业",
      mentions: [{ id: "it1", title: "英语作业" }],
    });
  });

  it("启动回填（D-89）：历史消息以纯文本气泡回填；后续发送携带回填的 history", async () => {
    const { bodies } = stubChat(
      { reply: "接上。", actions: [], references: [] },
      {
        history: [
          { role: "user", content: "上次说的作业是什么", at: "2026-09-29T10:00:00" },
          { role: "assistant", content: "英语作业，9 月 30 号交。", at: "2026-09-29T10:00:01" },
        ],
      },
    );
    render(
      <ChatPanel items={[]} onActivity={() => {}} onRequestFocus={() => {}} onClose={() => {}} />,
    );
    // 回填可见（纯文本气泡）
    expect(await screen.findByText("上次说的作业是什么")).toBeInTheDocument();
    expect(screen.getByText("英语作业，9 月 30 号交。")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/问一句/), { target: { value: "那接下来呢" } });
    fireEvent.click(screen.getByText("发送"));
    await screen.findByText("接上。");
    // 上传的 history 含回填轮次（全量策略，D-89）
    expect(bodies[0]).toMatchObject({
      message: "那接下来呢",
      history: [
        { role: "user", content: "上次说的作业是什么" },
        { role: "assistant", content: "英语作业，9 月 30 号交。" },
      ],
    });
  });

  it("回填失败：一行本地占位可见（不静默），不影响继续对话", async () => {
    stubChat({ reply: "照常回复。", actions: [], references: [] }, { fail: true, history: [] });
    render(
      <ChatPanel items={[]} onActivity={() => {}} onRequestFocus={() => {}} onClose={() => {}} />,
    );
    expect(await screen.findByText(/历史记录暂时拉不回来/)).toBeInTheDocument();
  });

  it("回填竞态守卫：回填晚到时不覆盖本地已产生的消息（评审 F4 专用守卫）", async () => {
    // 受控 deferred：history 请求挂着不 resolve，直到测试手动放行（对象属性承载，规避 let 收窄）
    const holder: { release: ((res: Response) => void) | null } = { release: null };
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = fetchUrl(input);
        if (url.includes("/api/chat/history")) {
          return new Promise<Response>((resolve) => {
            holder.release = resolve;
          });
        }
        if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
        return Promise.resolve(jsonResponse({ reply: "好。", actions: [], references: [] }));
      }),
    );
    render(
      <ChatPanel items={[]} onActivity={() => {}} onRequestFocus={() => {}} onClose={() => {}} />,
    );
    // 回填还挂着 —— 先发一条消息（本地已有内容）
    fireEvent.change(screen.getByPlaceholderText(/问一句/), { target: { value: "提前问" } });
    fireEvent.click(screen.getByText("发送"));
    await screen.findByText("好。");

    // 现在回填晚到（带两条历史）：守卫应整份丢弃，不插进本地会话
    const release = holder.release;
    if (release === null) throw new Error("history 请求未发出");
    release(
      new Response(
        JSON.stringify({
          turns: [
            { role: "user", content: "旧话", at: "2026-09-29T09:00:00" },
            { role: "assistant", content: "旧答", at: "2026-09-29T09:00:01" },
          ],
        }),
        { status: 200 },
      ),
    );
    await waitFor(() => expect(screen.getByText("提前问")).toBeInTheDocument());
    expect(screen.queryByText("旧话")).not.toBeInTheDocument();
    expect(screen.queryByText("旧答")).not.toBeInTheDocument();
    // 消息序列不被篡改：本地「提前问」只出现一次
    expect(screen.getAllByText("提前问")).toHaveLength(1);
  });

  it("回复渲染 Markdown 子集 + 多行保真（2026-09-30 插播）", async () => {
    stubChat({
      reply: "有两件：\n\n- **英语作业** 9/30 交\n- 社团例会",
      actions: [],
      references: [],
    });
    render(
      <ChatPanel items={[]} onActivity={() => {}} onRequestFocus={() => {}} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByPlaceholderText(/问一句/), { target: { value: "有什么" } });
    fireEvent.click(screen.getByText("发送"));
    expect(await screen.findByText("英语作业")).toBeInTheDocument(); // strong 内文本
    expect(screen.getByText("英语作业").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("有两件：")).toBeInTheDocument();
  });
});

describe("ChatPanel 滚动锚定（specs/001-chat-scroll-anchor）", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /** 拿到消息滚动容器并把滚动度量设成可控值（happy-dom 无布局引擎，度量默认全 0；
   *  其 scrollTop setter 还会按内部度量钳制——一并接管为普通数据属性才可写）。 */
  function stubLogMetrics(scrollHeight: number, clientHeight: number): HTMLElement {
    const el = document.querySelector<HTMLElement>("[data-chat-log]");
    if (el === null) throw new Error("找不到 data-chat-log 容器");
    Object.defineProperty(el, "scrollTop", { value: 0, writable: true, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
    return el;
  }

  /** 挂一个无候选事项的空面板（滚动测试不关心 @ 候选）。 */
  function renderPanel(): void {
    render(
      <ChatPanel items={[]} onActivity={() => {}} onRequestFocus={() => {}} onClose={() => {}} />,
    );
  }

  it("US2：历史回填后列表停在底部（SC-002）", async () => {
    stubChat(
      { reply: "接上。", actions: [], references: [] },
      {
        history: [
          { role: "user", content: "上次说的作业是什么", at: "2026-09-29T10:00:00" },
          { role: "assistant", content: "英语作业，9 月 30 号交。", at: "2026-09-29T10:00:01" },
        ],
      },
    );
    renderPanel();
    const log = stubLogMetrics(1000, 400);
    await screen.findByText("英语作业，9 月 30 号交。");
    await waitFor(() => expect(log.scrollTop).toBe(1000)); // 回填后钉在底（非顶部）
  });

  it("US1：发送与回复到达后仍跟随底部（SC-001）", async () => {
    stubChat({ reply: "好。", actions: [], references: [] });
    renderPanel();
    const log = stubLogMetrics(800, 400);
    await waitFor(() => expect(log.scrollTop).toBe(800)); // 初始即在底
    // 模拟消息追加使内容变长
    Object.defineProperty(log, "scrollHeight", { value: 1200, configurable: true });
    fireEvent.change(screen.getByPlaceholderText(/问一句/), { target: { value: "问题" } });
    fireEvent.click(screen.getByText("发送"));
    await screen.findByText("好。");
    expect(log.scrollTop).toBe(1200); // 发送与回复两次追加都跟随到了新底部
  });

  it("US3：上翻后回复不拽回；滚回底部恢复跟随（SC-003）", async () => {
    stubChat({ reply: "迟到的回复。", actions: [], references: [] });
    renderPanel();
    const log = stubLogMetrics(2000, 400);
    const input = screen.getByPlaceholderText(/问一句/);
    fireEvent.change(input, { target: { value: "问题" } });
    fireEvent.click(screen.getByText("发送"));
    await screen.findByText("问题"); // 发送时在底（FR-001）
    // 用户上翻离开底部
    log.scrollTop = 100;
    fireEvent.scroll(log);
    // 回复到达：内容增长但视口不动
    Object.defineProperty(log, "scrollHeight", { value: 2400, configurable: true });
    await screen.findByText("迟到的回复。");
    expect(log.scrollTop).toBe(100); // 位移 0，没被拽回
    // 用户手动滚回底部 → 恢复跟随
    log.scrollTop = 2000; // 2400 - 400 = 底
    fireEvent.scroll(log);
    stubChat({ reply: "好的。", actions: [], references: [] });
    fireEvent.change(input, { target: { value: "再来" } });
    fireEvent.click(screen.getByText("发送"));
    await screen.findByText("好的。");
    expect(log.scrollTop).toBe(2400); // 恢复跟随
  });
});
