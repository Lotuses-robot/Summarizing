// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineView } from "../components/pipeline/PipelineView";
import "@testing-library/jest-dom/vitest";
import { fetchUrl, jsonResponse } from "./helpers/http";

// 流水视图（specs/005）：台账 + 展开详情——「一条信息从进站到成事项」全程可查。

const RUNS = [
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

  it("台账渲染：状态徽章/来源/摘要/计数（含消化中）", async () => {
    stubApi();
    render(<PipelineView />);
    await waitFor(() => expect(screen.getByText("已消化")).toBeInTheDocument());
    expect(screen.getByText("消化中")).toBeInTheDocument();
    expect(screen.getByText("英语课官方群")).toBeInTheDocument();
    expect(screen.getByText("应用 1 项变更：新建事项「作业」")).toBeInTheDocument();
    expect(screen.getAllByText("2 条").length).toBeGreaterThan(0);
  });

  it("展开行 → 详情：原文 + 时间线事件按序渲染", async () => {
    stubApi();
    render(<PipelineView />);
    const row = await screen.findByText("英语课官方群");
    fireEvent.click(row);
    // 展开行懒取详情：原文与时间线事件按序可见
    await waitFor(() => expect(screen.getByText("群里说的作业通知")).toBeInTheDocument());
    expect(screen.getByText("第 1 轮：search_items")).toBeInTheDocument();
    expect(screen.getByText("应用 1 项变更：新建事项「作业」")).toBeInTheDocument();
  });

  it("空库 → 可见空态文案（不是空白/报错）", async () => {
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
    expect(await screen.findByText(/还没有批次/)).toBeInTheDocument();
  });
});
