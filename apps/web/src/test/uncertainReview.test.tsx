// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UncertainInput } from "@summarizing/shared";
import { UncertainReview } from "../components/UncertainReview";
import { ActivityBar } from "../components/ActivityBar";
import { handleEsc } from "../lib/escLayer";
import "@testing-library/jest-dom/vitest";
import { emptyResponse, fetchUrl } from "./helpers/http";

/** 造一条存疑条目。 */
function makeEntry(partial: Partial<UncertainInput> = {}): UncertainInput {
  return {
    id: "u1",
    content: "听说要加口语考试",
    sourceType: "nc",
    sourceIdentity: { sourceLabel: "英语课官方群", groupId: "123" },
    eventTime: null,
    receivedAt: "2026-09-28T10:00:00",
    originRawInputId: "r1",
    needsHuman: 80,
    reason: "原文用『听说』，来源为口述",
    status: "open",
    resolvedRef: null,
    createdAt: "2026-09-28T10:00:00",
    resolvedAt: null,
    ...partial,
  };
}

/** fetch 替身：PUT /api/uncertain/:id → 204（或按 opts 造失败/已处置），并记录调用。 */
function stubResolve(opts: { fail?: boolean; gone?: boolean } = {}): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = fetchUrl(input);
      urls.push(url);
      if (opts.fail === true) return Promise.reject(new Error("网络挂了"));
      if (opts.gone === true) return Promise.resolve(emptyResponse(409));
      return Promise.resolve(emptyResponse(204));
    }),
  );
  return { urls };
}

describe("存疑库审核页（D-89）", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("只读列表：原话/需人工分/理由/来源/时间齐备", () => {
    render(<UncertainReview items={[makeEntry()]} onRemoved={() => {}} />);
    expect(screen.getByText("听说要加口语考试")).toBeInTheDocument();
    expect(screen.getByText(/需人工 80/)).toBeInTheDocument();
    expect(screen.getByText("原文用『听说』，来源为口述")).toBeInTheDocument();
    expect(screen.getByText(/英语课官方群/)).toBeInTheDocument();
  });

  it("空态：一句话（禁愧疚措辞）", () => {
    render(<UncertainReview items={[]} onRemoved={() => {}} />);
    expect(screen.getByText(/拿不准的信息会自动进来/)).toBeInTheDocument();
  });

  it("移动确认移除：点图标只变 X+勾，**移到勾上点击**才真删（PUT）；中途取消不发请求", async () => {
    const { urls } = stubResolve();
    const onRemoved = vi.fn();
    render(<UncertainReview items={[makeEntry()]} onRemoved={onRemoved} />);

    // 第一段：点归档图标 → 原位变 X、左侧弹出勾；此时**没有**任何请求
    fireEvent.click(screen.getByTitle("清掉这条（会再确认一次）"));
    expect(urls).toHaveLength(0);
    expect(screen.getByTitle("确认清掉这条")).toBeInTheDocument();
    expect(screen.getByTitle("取消")).toBeInTheDocument();

    // 取消路径：点 X 还原，不发请求
    fireEvent.click(screen.getByTitle("取消"));
    expect(urls).toHaveLength(0);
    expect(screen.getByTitle("清掉这条（会再确认一次）")).toBeInTheDocument();

    // 第二段：再唤醒 → 移到勾上点击 → 发 PUT 并通知刷新
    fireEvent.click(screen.getByTitle("清掉这条（会再确认一次）"));
    fireEvent.click(screen.getByTitle("确认清掉这条"));
    await waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toContain("/api/uncertain/u1");
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
  });

  it("鼠标离开整组 = 取消还原（移动确认的第二道防误触）", () => {
    stubResolve();
    render(<UncertainReview items={[makeEntry()]} onRemoved={() => {}} />);
    fireEvent.click(screen.getByTitle("清掉这条（会再确认一次）"));
    const group = screen.getByTitle("确认清掉这条").parentElement;
    if (group === null) throw new Error("找不到确认组");
    fireEvent.mouseLeave(group);
    expect(screen.getByTitle("清掉这条（会再确认一次）")).toBeInTheDocument();
  });

  it("Esc = 取消还原（走 Esc 分层栈，不会把审核页一起弹掉）", async () => {
    const { urls } = stubResolve();
    const onRemoved = vi.fn();
    render(<UncertainReview items={[makeEntry()]} onRemoved={onRemoved} />);
    fireEvent.click(screen.getByTitle("清掉这条（会再确认一次）"));
    await act(async () => {
      handleEsc(); // App 的全局 Esc 消费实际就是调它
    });
    expect(await screen.findByTitle("清掉这条（会再确认一次）")).toBeInTheDocument(); // 还原
    expect(urls).toHaveLength(0); // 没有发请求
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("指针在组外按下 = 取消还原（触屏 tap 别处 / mouseleave 覆盖不到的场景）", () => {
    stubResolve();
    render(<UncertainReview items={[makeEntry()]} onRemoved={() => {}} />);
    fireEvent.click(screen.getByTitle("清掉这条（会再确认一次）"));
    fireEvent.pointerDown(document.body);
    expect(screen.getByTitle("清掉这条（会再确认一次）")).toBeInTheDocument();
  });

  it("非 404/409 的移除失败 → 可见提示（不静默）且刷新收尾", async () => {
    stubResolve({ fail: true }); // 网络挂掉 = 非 gone 类失败
    const onRemoved = vi.fn();
    render(<UncertainReview items={[makeEntry()]} onRemoved={onRemoved} />);
    fireEvent.click(screen.getByTitle("清掉这条（会再确认一次）"));
    fireEvent.click(screen.getByTitle("确认清掉这条"));
    expect(await screen.findByText(/移除失败/)).toBeInTheDocument();
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
  });

  it("404/409（已被清扫并发处置）→ 静默刷新收尾，不报错提示", async () => {
    stubResolve({ gone: true });
    const onRemoved = vi.fn();
    render(<UncertainReview items={[makeEntry()]} onRemoved={onRemoved} />);
    fireEvent.click(screen.getByTitle("清掉这条（会再确认一次）"));
    fireEvent.click(screen.getByTitle("确认清掉这条"));
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    expect(screen.queryByText(/移除失败/)).not.toBeInTheDocument();
  });
});

describe("ActivityBar 存疑库入口（D-89）", () => {
  afterEach(cleanup);

  it("有 open 条目 → 徽标显示计数；为 0 → 无徽标", () => {
    const { rerender } = render(
      <ActivityBar
        view="board"
        uncertainCount={3}
        onHome={() => {}}
        onShowUncertain={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    expect(screen.getByText("3")).toBeInTheDocument();
    rerender(
      <ActivityBar
        view="board"
        uncertainCount={0}
        onHome={() => {}}
        onShowUncertain={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("三个入口回调各就各位：看板/审核/设置", () => {
    const onHome = vi.fn();
    const onShowUncertain = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <ActivityBar
        view="board"
        uncertainCount={0}
        onHome={onHome}
        onShowUncertain={onShowUncertain}
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(screen.getByTitle("回到看板顶部"));
    expect(onHome).toHaveBeenCalled();
    fireEvent.click(screen.getByTitle("存疑库审核（空）"));
    expect(onShowUncertain).toHaveBeenCalled();
    fireEvent.click(screen.getByTitle("设置"));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
