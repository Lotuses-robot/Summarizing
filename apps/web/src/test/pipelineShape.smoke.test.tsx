// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PipelineView } from "../components/pipeline/PipelineView";
import "@testing-library/jest-dom/vitest";

// 真形状冒烟：用**从真实服务抓下来、脱敏后固化**的响应喂给真实组件。
//
// 来源：2026-11-10 用 `curl -H 'Authorization: Bearer …' localhost:3001/api/v1/pipeline/runs`
// 与 `/runs/:id` 各抓一份，然后把群名、对话内容、id 全部替换成示例值（本仓库公开，
// 真实对话不该落进 fixture），只保留**形状**——字段名、嵌套层级、null 位置一字不改。
//
// 它回答的问题与单元测试不同：单测的假数据容易和真实响应漂移，这里锁住「真形状喂进真组件
// 还是对的」。形状若在服务端变了，这条会红。

const FIXTURE = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "fixtures/pipelineShape.json"), "utf8"),
) as { runs: unknown; detail: unknown };

/** 真实 `Response`（happy-dom 提供）——不走类型断言，让构造器自己校验形状。 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** 把真实响应接进 fetch。 */
function stubRealApi(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => {
      const url = String(input);
      if (url.includes("/api/pipeline/runs/")) return Promise.resolve(jsonResponse(FIXTURE.detail));
      if (url.includes("/api/pipeline/runs")) return Promise.resolve(jsonResponse(FIXTURE.runs));
      return Promise.resolve(jsonResponse({}));
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("真形状冒烟（脱敏后的真实响应喂真组件）", () => {
  it("台账渲染出批次，展开后原文与上下文都可见", async () => {
    stubRealApi();
    render(<PipelineView />);

    // 台账渲染成功（不崩、不是空态）
    expect((await screen.findAllByRole("button")).length).toBeGreaterThan(0);

    // 展开那条 chat 批次
    fireEvent.click(await screen.findByRole("button", { name: /前台对话/ }));
    const detail = within(await screen.findByTestId("run-detail"));

    // 原文逐字可见
    expect(detail.getByText(/帮我记一下，下周三下午三点在三楼会议室开组会。/)).toBeInTheDocument();

    // 上下文入口在（默认折叠）
    const toggle = await detail.findByRole("button", {
      name: /查看提交时的对话上下文（3 条消息 · @ 提及 1 条）/,
    });
    expect(detail.queryByText("我说的那个作业要交了")).not.toBeInTheDocument();

    // 点开后逐轮可见，且带时刻与 @ 提及
    fireEvent.click(toggle);
    expect(await detail.findByText(/我说的那个作业要交了/)).toBeInTheDocument();
    expect(detail.getByText(/你是说「课程设计」那条吗？/)).toBeInTheDocument();
    expect(detail.getByText(/2026-11-10T20:00:00/)).toBeInTheDocument();
    expect(detail.getByText(/@ 提及：「课程设计」/)).toBeInTheDocument();

    // 关键措辞：明说不是要记录的内容
    expect(detail.getByText(/不是要记录的内容/)).toBeInTheDocument();
  });
});
