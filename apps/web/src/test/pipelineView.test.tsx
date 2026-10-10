// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIGEST_MAX_ROUNDS } from "@summarizing/shared";
import { PipelineView } from "../components/pipeline/PipelineView";
import "@testing-library/jest-dom/vitest";
import { fetchUrl, jsonResponse } from "./helpers/http";

// 流水视图（specs/005）：台账 + 展开详情——「一条信息从进站到成事项」全程可查。
// 条目顺序与真接口一致：新到旧（最新在前，状态卡取 runs[0] 作「最近一批」）。

const RUNS = [
  {
    id: "r-digesting",
    sourceType: "nc",
    sourceLabel: "社团群",
    receivedAt: "2026-09-28T11:00:00",
    eventTime: null,
    digestState: "digesting",
    summary: null,
    eventCount: 1,
  },
  {
    id: "r-digested",
    sourceType: "nc",
    sourceLabel: "英语课官方群",
    receivedAt: "2026-09-28T10:00:00",
    eventTime: "2026-09-28T10:00:00",
    digestState: "digested",
    summary: "应用 1 项变更：新建事项「作业」",
    eventCount: 2,
  },
];

const DETAIL_EVENTS = [
  {
    id: "e1",
    action: "digest_trace",
    detail: "第 1 轮：search_items",
    payload: { round: 1, thought: "", tools: ["search_items"] },
    at: "2026-09-28T10:00:05",
    by: { actor: "agent0", model: "test" },
  },
  {
    id: "e2",
    action: "digest_done",
    detail: "应用 1 项变更：新建事项「作业」",
    payload: null,
    at: "2026-09-28T10:00:10",
    by: { actor: "agent0", model: "test" },
  },
];

/** 本地墙钟串（与 receivedAt 同格式；ISO 是 UTC 会差出时区）——供「刚完成/页开后到达」用例构造。
 *  显式补零（不依赖 ICU locale——sv-SE 在 small-icu 运行时会静默变格式）。 */
function localNowStr(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` +
    `T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
  );
}

/** 详情请求的空替身：给真实形状（列表 payload 不再被 `detail.events ?? []` 容错吸收——评审 F8 卫生）。 */
function emptyDetail(): Response {
  return jsonResponse({
    raw: {
      id: "r-empty",
      content: "（空）",
      sourceType: "chat",
      sourceIdentity: { sourceLabel: "测试" },
      receivedAt: "2026-09-28T00:00:00",
      eventTime: null,
      digestState: "digesting",
    },
    events: [],
  });
}

/** 台账路由替身（场景标志位留在用例内）：详情给空真形状，列表按传入闭包取 runs。 */
function stubRuns(current: () => unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = fetchUrl(input);
      if (url.includes("/api/pipeline/runs/r-")) return Promise.resolve(emptyDetail());
      if (url.includes("/api/pipeline/runs")) {
        return Promise.resolve(jsonResponse({ runs: current() }));
      }
      return Promise.resolve(jsonResponse({}));
    }),
  );
}

/** 受控 fetch 替身：台账按 URL 分流；详情按 id 返回固定事件。 */
function stubApi(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = fetchUrl(input);
      if (url.includes("/api/pipeline/runs/r-digested")) {
        return Promise.resolve(
          jsonResponse({
            raw: {
              id: "r-digested",
              content: "群里说的作业通知",
              sourceType: "nc",
              sourceIdentity: { sourceLabel: "英语课官方群" },
              receivedAt: "2026-09-28T10:00:00",
              eventTime: "2026-09-28T10:00:00",
              digestState: "digested",
            },
            events: DETAIL_EVENTS,
          }),
        );
      }
      if (url.includes("/api/pipeline/runs/r-digesting")) {
        return Promise.resolve(
          jsonResponse({
            raw: {
              id: "r-digesting",
              content: "社团群消息",
              sourceType: "nc",
              sourceIdentity: { sourceLabel: "社团群" },
              receivedAt: "2026-09-28T11:00:00",
              eventTime: null,
              digestState: "digesting",
            },
            events: [
              {
                id: "e3",
                action: "digest_trace",
                detail: "第 1 轮：search_items",
                payload: null,
                at: "2026-09-28T11:00:05",
                by: { actor: "agent0", model: "test" },
              },
              {
                id: "e4",
                action: "digest_trace",
                detail: "第 2 轮：get_item",
                payload: null,
                at: "2026-09-28T11:00:08",
                by: { actor: "agent0", model: "test" },
              },
              {
                id: "e5",
                action: "digest_trace",
                detail: "第 3 轮：search_uncertain",
                payload: null,
                at: "2026-09-28T11:00:11",
                by: { actor: "agent0", model: "test" },
              },
              {
                id: "e6",
                action: "digest_trace",
                detail: "第 4 轮：search_recent_raws",
                payload: null,
                at: "2026-09-28T11:00:14",
                by: { actor: "agent0", model: "test" },
              },
            ],
          }),
        );
      }
      if (url.includes("/api/pipeline/runs")) {
        return Promise.resolve(jsonResponse({ runs: RUNS }));
      }
      return Promise.resolve(jsonResponse({}));
    }),
  );
}

describe("PipelineView（流水视图，specs/005）", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("台账渲染：状态/来源/摘要/耗时（含置顶消化状态卡）", async () => {
    stubApi();
    render(<PipelineView />);
    await waitFor(() => expect(screen.getByText("已消化")).toBeInTheDocument());
    // 标题旁批次数
    expect(screen.getByText("2 个批次")).toBeInTheDocument();
    // 「消化中」恰好两处：状态卡大 H1 + 列表行（计数确定——H1 被删此断言必红）
    expect(screen.getAllByText("消化中")).toHaveLength(2);
    expect(screen.getByText("英语课官方群")).toBeInTheDocument();
    expect(screen.getByText("应用 1 项变更：新建事项「作业」")).toBeInTheDocument();
    // 置顶状态卡：已跑耗时 + 轮次进度（真实事件驱动，非纯装饰）
    expect(screen.getByText(/已跑 \d+s/)).toBeInTheDocument();
    expect(screen.getByText(/第 4\/8 轮/)).toBeInTheDocument(); // 详情里 4 条 digest_trace
    // 渐隐轨迹：最新活动全亮，上一轮更淡（越旧越透明——「滚动栏 + 残影」）
    const newest = await screen.findByText("第 4 轮：search_recent_raws");
    const older = screen.getByText("第 3 轮：search_uncertain");
    expect(newest.style.opacity).toBe("1");
    expect(Number(older.style.opacity)).toBeLessThan(1);
    // 残影上限 3 条：更旧的第 1 轮不上轨迹
    expect(screen.queryByText("第 1 轮：search_items")).not.toBeInTheDocument();
  });

  it("展开行 → 详情：原文 + 时间线最新在上（走查 2026-10-10 修订）", async () => {
    stubApi();
    render(<PipelineView />);
    const row = await screen.findByText("英语课官方群");
    fireEvent.click(row);
    // 展开行懒取详情：原文与时间线事件可见
    await waitFor(() => expect(screen.getByText("群里说的作业通知")).toBeInTheDocument());
    expect(screen.getAllByText("第 1 轮：search_items")).toHaveLength(1);
    expect(screen.getAllByText("应用 1 项变更：新建事项「作业」").length).toBeGreaterThanOrEqual(1);
    // 时间线顺序：最新（digest_done）在上，旧事件（trace）在下
    const detail = within(screen.getByTestId("run-detail"));
    const order = detail
      .getAllByText(/第 1 轮：search_items|应用 1 项变更：新建事项「作业」/)
      .map((el) => el.textContent);
    expect(order).toEqual(["应用 1 项变更：新建事项「作业」", "第 1 轮：search_items"]);
  });

  it(
    "完成闪示：消化中 → 已完成（3 秒后回落空闲），走查 2026-10-10",
    { timeout: 10_000 },
    async () => {
      let phase: "digesting" | "digested" = "digesting";
      // 同一批次的状态跃迁（digesting→digested 才触发闪示）
      const digestingRun = { ...RUNS[1], digestState: "digesting", summary: null };
      stubRuns(() => (phase === "digesting" ? [digestingRun] : [RUNS[1]]));
      render(<PipelineView />);
      await waitFor(() => expect(screen.getAllByText("消化中").length).toBeGreaterThan(0));

      phase = "digested";
      fireEvent.click(screen.getByTitle("刷新")); // 手动轮询到完成态
      expect(await screen.findByText("已完成")).toBeInTheDocument();
      // 3 秒规格的下限：1 秒后仍在（防被悄悄缩短成眨眼闪）
      await new Promise((r) => setTimeout(r, 1000));
      expect(screen.getByText("已完成")).toBeInTheDocument();
      // 随后消失，回落空闲卡（最近一批已消化）
      await waitFor(() => expect(screen.queryByText("已完成")).not.toBeInTheDocument(), {
        timeout: 6000,
      });
      expect(screen.getByText("空闲")).toBeInTheDocument();
    },
  );

  it(
    "同轮询两批同时完成 → 两张已完成卡（不只闪第一个，评审 F1）",
    { timeout: 10_000 },
    async () => {
      let done = false;
      const before = [RUNS[0], { ...RUNS[1], digestState: "digesting", summary: null }];
      const after = [{ ...RUNS[0], digestState: "digested" }, RUNS[1]];
      stubRuns(() => (done ? after : before));
      render(<PipelineView />);
      await waitFor(() => expect(screen.getAllByText("消化中").length).toBeGreaterThanOrEqual(2));

      done = true;
      fireEvent.click(screen.getByTitle("刷新"));
      await waitFor(() => expect(screen.getAllByText("已完成")).toHaveLength(2));
    },
  );

  it("首轮建底：挂载时就有「刚完成」批次 → 不闪（历史不许闪，评审 F4）", async () => {
    const recentRun = { ...RUNS[1], receivedAt: localNowStr() };
    stubRuns(() => [recentRun]);
    render(<PipelineView />);
    // 同一次提交渲染空闲卡与（若有）闪示卡——空闲在即闪示无
    expect(await screen.findByText(/最近一批已消化——/)).toBeInTheDocument();
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();
  });

  it("页开后到达的旧批次（完成态）→ 不闪（新近窗口只认「刚完成」，评审 F4）", async () => {
    let arrived = false;
    const oldRun = { ...RUNS[1], receivedAt: "2026-09-01T10:00:00" }; // 明显旧数据
    stubRuns(() => (arrived ? [oldRun] : []));
    render(<PipelineView />);
    await waitFor(() => expect(screen.getByText("空闲")).toBeInTheDocument()); // 基线建底（空库）

    arrived = true;
    fireEvent.click(screen.getByTitle("刷新"));
    // 列表已吃进这条（批次数更新说明本轮已处理），但它不闪
    await waitFor(() => expect(screen.getByText("1 个批次")).toBeInTheDocument());
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();
  });

  it("常驻状态卡：无在途时也在——空闲 + 最近一批结局", async () => {
    stubRuns(() => [RUNS[1]]); // 只有已消化批次
    render(<PipelineView />);
    expect(await screen.findByText("空闲")).toBeInTheDocument();
    expect(screen.getByText(/最近一批已消化——应用 1 项变更：新建事项「作业」/)).toBeInTheDocument();
  });

  it("快消化闪示：页开后新到的批次一轮就完成（没赶上 digesting 轮询）也闪", async () => {
    let arrived = false;
    // receivedAt 在请求时刻生成（页开后「刚完成」——评审 F3：消除渲染前构造的时间竞态）
    stubRuns(() => (arrived ? [{ ...RUNS[1], receivedAt: localNowStr() }] : []));
    render(<PipelineView />);
    await waitFor(() => expect(screen.getByText("空闲")).toBeInTheDocument()); // 基线建底（空库）

    arrived = true;
    fireEvent.click(screen.getByTitle("刷新"));
    expect(await screen.findByText("已完成")).toBeInTheDocument();
  });

  it("失败重试极快完成：见过的 failed 批直接变 digested → 也闪（二轮评审 F2 盲区）", async () => {
    let phase: "failed" | "digested" = "failed";
    const failedRun = {
      ...RUNS[1],
      digestState: "failed",
      summary: "处理失败，标记「未处理」：测试",
    };
    stubRuns(() => (phase === "failed" ? [failedRun] : [RUNS[1]]));
    render(<PipelineView />);
    // 基线先见到 failed 态（列表行精确「未处理」；空闲卡红叉同帧渲染）
    await waitFor(() => expect(screen.getByText("未处理")).toBeInTheDocument());

    phase = "digested"; // 模拟重试后在下一个轮询间隔内整批完成（没赶上 digesting 观测）
    fireEvent.click(screen.getByTitle("刷新"));
    expect(await screen.findByText("已完成")).toBeInTheDocument();
  });

  it("轮数封顶：跨重试累计超上限也只显「第 N/N 轮」（二轮评审 F1 盲区）", async () => {
    // 上限 + 1 条 trace（常量调整后此处仍表达同一意图）
    const traces = Array.from({ length: DIGEST_MAX_ROUNDS + 1 }, (_, i) => ({
      id: `x${i}`,
      action: "digest_trace",
      detail: `第 ${i + 1} 轮：search_items`,
      payload: null,
      at: `2026-09-28T12:${String(10 + i).padStart(2, "0")}:00`,
      by: { actor: "agent0", model: "test" },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const url = fetchUrl(input);
        if (url.includes("/api/pipeline/runs/r-digesting")) {
          return Promise.resolve(
            jsonResponse({
              raw: {
                id: "r-digesting",
                content: "社团群消息",
                sourceType: "nc",
                sourceIdentity: { sourceLabel: "社团群" },
                receivedAt: "2026-09-28T11:00:00",
                eventTime: null,
                digestState: "digesting",
              },
              events: traces,
            }),
          );
        }
        if (url.includes("/api/pipeline/runs")) {
          return Promise.resolve(jsonResponse({ runs: [RUNS[0]] }));
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );
    render(<PipelineView />);
    expect(
      await screen.findByText(new RegExp(`第 ${DIGEST_MAX_ROUNDS}/${DIGEST_MAX_ROUNDS} 轮`)),
    ).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`第 ${DIGEST_MAX_ROUNDS + 1}/`))).not.toBeInTheDocument();
  });

  it("展开消化中批次：详情随轮询刷新（eventCount 变 → 重拉，走查修订 2026-10-10）", async () => {
    let grown = false;
    const first = {
      id: "e1",
      action: "digest_trace",
      detail: "第 1 轮：search_items",
      payload: null,
      at: "2026-09-28T11:00:05",
      by: { actor: "agent0", model: "test" },
    };
    const second = {
      id: "e2",
      action: "digest_trace",
      detail: "第 2 轮：get_item",
      payload: null,
      at: "2026-09-28T11:00:08",
      by: { actor: "agent0", model: "test" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const url = fetchUrl(input);
        if (url.includes("/api/pipeline/runs/r-digesting")) {
          return Promise.resolve(
            jsonResponse({
              raw: {
                id: "r-digesting",
                content: "社团群消息",
                sourceType: "nc",
                sourceIdentity: { sourceLabel: "社团群" },
                receivedAt: "2026-09-28T11:00:00",
                eventTime: null,
                digestState: "digesting",
              },
              events: grown ? [first, second] : [first],
            }),
          );
        }
        if (url.includes("/api/pipeline/runs")) {
          return Promise.resolve(
            jsonResponse({ runs: [{ ...RUNS[0], eventCount: grown ? 2 : 1 }] }),
          );
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );
    render(<PipelineView />);
    // 展开消化中的批次（卡片 meta 里也有「社团群」——用行按钮定位）
    fireEvent.click(await screen.findByRole("button", { name: /社团群/ }));
    // 断言限定在详情面板内（状态卡轨迹也在刷新——不做 within 会被假通过）
    const detail = within(await screen.findByTestId("run-detail"));
    await detail.findByText("第 1 轮：search_items");
    expect(detail.queryByText("第 2 轮：get_item")).not.toBeInTheDocument();

    grown = true; // 新事件落流水 → 父级轮询拿到新 eventCount
    fireEvent.click(screen.getByTitle("刷新"));
    expect(await detail.findByText("第 2 轮：get_item")).toBeInTheDocument();
  });

  it("空库 → 状态卡空闲 + 可见空态文案（不是空白/报错）", async () => {
    stubRuns(() => []);
    render(<PipelineView />);
    expect(await screen.findByText("空闲")).toBeInTheDocument();
    expect(screen.getByText("等待第一条信息。")).toBeInTheDocument();
    expect(screen.getByText(/还没有批次/)).toBeInTheDocument();
  });
});
