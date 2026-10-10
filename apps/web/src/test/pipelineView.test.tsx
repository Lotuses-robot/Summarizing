// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
                detail: "第 1 轮：list_recent_items",
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
    // 「消化中」出现两处：置顶状态卡 + 列表行——用 getAllByText
    expect(screen.getAllByText("消化中").length).toBeGreaterThan(0);
    expect(screen.getByText("英语课官方群")).toBeInTheDocument();
    expect(screen.getByText("应用 1 项变更：新建事项「作业」")).toBeInTheDocument();
    // 置顶状态卡：已跑耗时 + 轮次进度（真实事件驱动，非纯装饰）
    expect(screen.getByText(/已跑 \d+s/)).toBeInTheDocument();
    expect(screen.getByText(/第 2\/8 轮/)).toBeInTheDocument(); // 详情里 2 条 digest_trace
    // 渐隐轨迹：最新活动全亮，上一轮更淡（越旧越透明——「滚动栏 + 残影」）
    const newest = await screen.findByText("第 2 轮：get_item");
    const older = screen.getByText("第 1 轮：list_recent_items");
    expect(newest.style.opacity).toBe("1");
    expect(Number(older.style.opacity)).toBeLessThan(1);
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

  it("完成闪示：消化中 → 已完成（3 秒后回落空闲），走查 2026-10-10", async () => {
    let phase: "digesting" | "digested" = "digesting";
    // 同一批次的状态跃迁（digesting→digested 才触发闪示）
    const digestingRun = { ...RUNS[1], digestState: "digesting", summary: null };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const url = fetchUrl(input);
        if (url.includes("/api/pipeline/runs")) {
          return Promise.resolve(
            jsonResponse({ runs: phase === "digesting" ? [digestingRun] : [RUNS[1]] }),
          );
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );
    render(<PipelineView />);
    await waitFor(() => expect(screen.getAllByText("消化中").length).toBeGreaterThan(0));

    phase = "digested";
    fireEvent.click(screen.getByTitle("刷新")); // 手动轮询到完成态
    expect(await screen.findByText("已完成")).toBeInTheDocument();
    // 3 秒后闪示消失，回落空闲卡（最近一批已消化）
    await waitFor(() => expect(screen.queryByText("已完成")).not.toBeInTheDocument(), {
      timeout: 6000,
    });
    expect(screen.getByText("空闲")).toBeInTheDocument();
  });

  it("常驻状态卡：无在途时也在——空闲 + 最近一批结局", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const url = fetchUrl(input);
        if (url.includes("/api/pipeline/runs")) {
          return Promise.resolve(jsonResponse({ runs: [RUNS[1]] })); // 只有已消化批次
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );
    render(<PipelineView />);
    expect(await screen.findByText("空闲")).toBeInTheDocument();
    expect(screen.getByText(/最近一批已消化——应用 1 项变更：新建事项「作业」/)).toBeInTheDocument();
  });

  it("快消化闪示：页开后新到的批次一轮就完成（没赶上 digesting 轮询）也闪", async () => {
    // 本地墙钟串（与 receivedAt 同格式；ISO 是 UTC 会差出时区）
    const d = new Date();
    /** 两位补零。 */
    const p = (n: number) => String(n).padStart(2, "0");
    const localNow = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const recentRun = { ...RUNS[1], receivedAt: localNow };
    let arrived = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const url = fetchUrl(input);
        if (url.includes("/api/pipeline/runs")) {
          return Promise.resolve(jsonResponse({ runs: arrived ? [recentRun] : [] }));
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );
    render(<PipelineView />);
    await waitFor(() => expect(screen.getByText("空闲")).toBeInTheDocument()); // 基线建底（空库）

    arrived = true;
    fireEvent.click(screen.getByTitle("刷新"));
    expect(await screen.findByText("已完成")).toBeInTheDocument();
  });

  it("空库 → 状态卡空闲 + 可见空态文案（不是空白/报错）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const url = fetchUrl(input);
        if (url.includes("/api/pipeline/runs")) {
          return Promise.resolve(jsonResponse({ runs: [] }));
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );
    render(<PipelineView />);
    expect(await screen.findByText("空闲")).toBeInTheDocument();
    expect(screen.getByText("等待第一条信息。")).toBeInTheDocument();
    expect(screen.getByText(/还没有批次/)).toBeInTheDocument();
  });
});
