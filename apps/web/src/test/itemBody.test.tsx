// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetItemResult } from "@summarizing/shared";
import { handleEsc } from "../lib/escLayer";
import { ItemBody } from "../components/board/ItemBody";
import { jsonResponse } from "./helpers/http";
import "@testing-library/jest-dom/vitest";

/** 用受控 fetch 替身喂真实 api.ts（不走网络、不打 mock 层——替身只应答 JSON）。 */
function stubFetch(detail: GetItemResult): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((init?: RequestInit): Promise<Response> => {
      const body = init?.method === "POST" ? detail.item : detail;
      return Promise.resolve(jsonResponse(body));
    }),
  );
}

/** 造一份事项详情（测试关心的字段外给合法默认）。 */
function makeDetail(overrides: Partial<GetItemResult> = {}): GetItemResult {
  return {
    item: {
      id: "it1",
      elements: [
        { label: "name", text: "英语作业" },
        { label: "dueDate", text: "2026-09-30 18:00", note: "按往年惯例推算" },
        { label: "链接", text: "https://example.com/hw" },
      ],
      tags: ["英语课"],
      status: "todo",
      kind: "task",
      doubtNote: null,
    },
    evidence: [
      {
        id: "ev1",
        itemId: "it1",
        subject: "元素:dueDate",
        fragmentId: "fr1",
        pointer: null,
        capturedAt: "2026-09-26T10:00:00",
        capturedBy: "agent0:test",
      },
      {
        id: "ev2",
        itemId: "it1",
        subject: "元素:链接",
        fragmentId: "fr1",
        pointer: null,
        capturedAt: "2026-09-26T10:00:00",
        capturedBy: "agent0:test",
      },
    ],
    fragments: [
      { id: "fr1", content: "英语作业 9 月 30 号截止", contentHash: "h", rawInputId: "raw1" },
    ],
    versions: [
      {
        id: "v1",
        itemId: "it1",
        action: "create_item",
        detail: "新建事项「英语作业」",
        snapshot: { elements: [], tags: [], status: "todo", kind: "task", doubtNote: null },
        at: "2026-09-26 10:00",
        by: { actor: "agent0", model: "test" },
        revokedBy: null,
      },
    ],
    rawInputs: {
      raw1: {
        id: "raw1",
        content: "群通知：英语作业 9 月 30 号截止，请互相转告",
        sourceType: "paste",
        sourceIdentity: { sourceLabel: "QQ", groupId: "123", sender: "学习委员" },
        receivedAt: "2026-09-26T10:00:00",
        eventTime: null,
        digestState: "digested",
      },
    },
    media: {},
    ...overrides,
  };
}

describe("ItemBody（展开体，D-80/D-82）", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("分级默认：基本信息与元素平铺可见、引文收起（点元素展开）、版本史只显计数", async () => {
    stubFetch(makeDetail());
    render(<ItemBody id="it1" />);

    // dueDate 是固定元素：只在基本信息区以 [ddl] 出现一次，**不进元素区**（曾两处重复显示）
    await waitFor(() => expect(screen.getByText("[ddl]")).toBeInTheDocument());
    expect(screen.queryByText("[dueDate]")).not.toBeInTheDocument();
    // 自由元素「链接」平铺可见，其引文默认收起（证据计数可见）
    await waitFor(() => expect(screen.getByText("[链接]")).toBeInTheDocument());
    expect(screen.getByText("· 证据(1)")).toBeInTheDocument();
    expect(screen.queryByText("看原文")).not.toBeInTheDocument();

    // 点元素行展开引文（引文是唯一折叠层）
    fireEvent.click(screen.getByText("[链接]"));
    expect(screen.getByText("看原文")).toBeInTheDocument();
    // 再点收起
    fireEvent.click(screen.getByText("[链接]"));
    expect(screen.queryByText("看原文")).not.toBeInTheDocument();

    // 版本史默认收，只显计数；点开见明细
    expect(screen.queryByText(/新建事项/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/编辑列表/));
    expect(screen.getByText(/新建事项/)).toBeInTheDocument();
  });

  it("展开体内没有操作按钮（走查修订④修正：操作统一走行右缘快捷）；存疑按钮随 D-89 退场", async () => {
    stubFetch(makeDetail());
    render(<ItemBody id="it1" />);
    await waitFor(() => expect(screen.getByText(/基本信息/)).toBeInTheDocument());
    expect(screen.queryByText("标完成")).not.toBeInTheDocument();
    expect(screen.queryByText("归档")).not.toBeInTheDocument();
    expect(screen.queryByText("恢复待办")).not.toBeInTheDocument();
    expect(screen.queryByText("撤回归档")).not.toBeInTheDocument();
    // D-89：解除存疑按钮随存疑 UI 全退场（负断言）
    expect(screen.queryByText(/了解清楚/)).not.toBeInTheDocument();
  });

  it("ddl 附相对时间（shared relativeDueText）与推断说明", async () => {
    // 90 小时后到期（>2 天档）→ ceil(3.75) = 「还有 4 天」；用动态日期避免墙钟漂移。
    // ddl 串按北京墙钟生成（epoch+8h 的 UTC 分量——本地 getter 在 UTC 机器上会偏 8h，CI 实测）
    const due = new Date(Date.now() + 90 * 60 * 60_000 + 8 * 60 * 60_000);
    /** 数字补零成两位（墙钟格式用）。 */
    const pad = (n: number): string => String(n).padStart(2, "0");
    const ddl = `${due.getUTCFullYear()}-${pad(due.getUTCMonth() + 1)}-${pad(due.getUTCDate())} ${pad(due.getUTCHours())}:${pad(due.getUTCMinutes())}`;
    stubFetch(
      makeDetail({
        item: {
          ...makeDetail().item,
          elements: makeDetail().item.elements.map((e) =>
            e.label === "dueDate" ? { ...e, text: ddl } : e,
          ),
        },
      }),
    );
    render(<ItemBody id="it1" />);
    await waitFor(() => expect(screen.getByText(/还有 4 天/)).toBeInTheDocument());
    // 推断 = 行内后缀开关（与「· 证据(n)」同款，走查修订）：默认收起，点开/再点收
    expect(screen.queryByText(/按往年惯例推算/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("· 推断"));
    expect(screen.getByText(/按往年惯例推算/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("· 推断"));
    expect(screen.queryByText(/按往年惯例推算/)).not.toBeInTheDocument();
  });

  it("来源信息栏：一行一批次（不按身份串合并），各行独立展开、批次行直达原文", async () => {
    stubFetch(
      makeDetail({
        rawInputs: {
          raw1: {
            id: "raw1",
            content: "群通知",
            sourceType: "nc",
            sourceIdentity: { sourceLabel: "英语课群", groupId: "940641749", sender: "学习委员" },
            receivedAt: "2026-09-26T10:00:00",
            eventTime: null,
            digestState: "digested",
          },
          // 同来源、不同批次，且身份键形状不同（一个带 sender 一个不带）→ 仍各占一行：
          // 哪些键逐批稳定是适配器的形状知识，前端不假设、不合并（用户 2026-10-14 定）
          raw2: {
            id: "raw2",
            content: "补发",
            sourceType: "nc",
            sourceIdentity: { sourceLabel: "英语课群", groupId: "940641749" },
            receivedAt: "2026-09-27T10:00:00",
            eventTime: null,
            digestState: "digested",
          },
        },
      }),
    );
    render(<ItemBody id="it1" />);
    await waitFor(() => expect(screen.getByText("来源信息")).toBeInTheDocument());
    // 计数 = 批次数（2）；两行收起态都只有 [nc] 英语课群（不放别的——用户 2026-10-14 定）
    expect(screen.getByText("来源信息").parentElement).toHaveTextContent("2");
    const rows = screen.getAllByText("[nc]");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.parentElement).toHaveTextContent("[nc] 英语课群");
    expect(screen.queryByText("[groupId]")).not.toBeInTheDocument();
    // 展开第一行（新批次在前 = raw2）：只列本批次的自由键（没有 sender 就是不列——不猜）
    const firstRow = rows[0];
    if (firstRow === undefined) throw new Error("没有来源行");
    fireEvent.click(firstRow);
    expect(screen.getByText("[groupId]").parentElement).toHaveTextContent("[groupId] 940641749");
    expect(screen.queryByText("[sender]")).not.toBeInTheDocument();
    expect(screen.getByText(/raw2 · 2026-09-27 10:00:00/)).toBeInTheDocument();
    // 批次行「看原文」直达该批次原文（无待高亮句 → 整段平铺）
    fireEvent.click(screen.getByText("看原文"));
    const overlayText = await screen.findByText("补发");
    expect(overlayText.tagName).toBe("P");
    act(() => {
      handleEsc();
    });
    expect(screen.queryByText("补发")).not.toBeInTheDocument();
    // 第二行独立展开：它有 sender、批次行是 raw1——各是各的
    const secondRow = rows[1];
    if (secondRow === undefined) throw new Error("没有第二个来源行");
    fireEvent.click(secondRow);
    expect(screen.getByText("[sender]").parentElement).toHaveTextContent("[sender] 学习委员");
    expect(screen.getByText(/raw1 · 2026-09-26 10:00:00/)).toBeInTheDocument();
    expect(screen.getAllByText("看原文")).toHaveLength(2);
    // 收起第一行 → 只剩第二行自己的键与批次行
    fireEvent.click(firstRow);
    expect(screen.queryByText(/raw2 · /)).not.toBeInTheDocument();
    expect(screen.getAllByText("[groupId]")).toHaveLength(1);
    expect(screen.getByText("[sender]")).toBeInTheDocument();
    // 再点第二行收起
    fireEvent.click(secondRow);
    expect(screen.queryByText("[groupId]")).not.toBeInTheDocument();
  });

  it("「看原文」打开引文悬浮窗：批次原文 + 高亮引文句", async () => {
    stubFetch(makeDetail());
    render(<ItemBody id="it1" />);
    fireEvent.click(await screen.findByText("[链接]"));
    // 引文旁标来源（D-89 选 B）：裸 sourceLabel 可见，hover 是**完整身份串**（含其余键）
    const label = screen.getByTitle("QQ（groupId=123 · sender=学习委员）");
    expect(label).toHaveTextContent("QQ");
    expect(label).not.toHaveTextContent("groupId"); // 行内只见裸 label，全串在 title
    fireEvent.click(screen.getByText("看原文"));
    // 高亮句落在 <mark> 里（indexOf 定位成功）；其所在 <p> 的完整文本 = 批次原文。
    // 同文本有两处（引文 blockquote + 悬浮窗 mark），取 tagName=MARK 的那个
    const candidates = await screen.findAllByText("英语作业 9 月 30 号截止");
    const mark = candidates.find((el) => el.tagName === "MARK");
    if (mark === undefined) throw new Error("悬浮窗未给出 <mark> 高亮");
    expect(mark.closest("p")?.textContent).toBe("群通知：英语作业 9 月 30 号截止，请互相转告");
    // Esc 分层退出：悬浮窗挂着层，handleEsc 让最上层收起（App 全局键实际就是这么触发的）
    fireEvent.keyDown(window, { key: "Escape" }); // 无人监听也不应出错
    expect(mark).toBeInTheDocument();
    act(() => {
      handleEsc();
    });
    expect(mark).not.toBeInTheDocument();
  });
});

describe("通知展开体不显示 [ddl]（D-106：通知无 ddl）", () => {
  it("kind=notice → 基本信息里没有 [ddl] 行（不说「未知」）", async () => {
    const detail = makeDetail({
      item: {
        id: "n1",
        elements: [{ label: "name", text: "课改到明理楼3楼" }],
        tags: [],
        status: "todo",
        kind: "notice",
        doubtNote: null,
      },
    });
    stubFetch(detail);
    render(<ItemBody id="n1" />);
    // 通知无 summary → 基本信息整块不渲染（阅读器与默认形态一致）；等元素区的空态出现即视为已加载
    await waitFor(() => expect(screen.getByText(/暂无——对前台说话即可补充/)).toBeInTheDocument());
    expect(screen.queryByText("基本信息")).not.toBeInTheDocument();
    expect(screen.queryByText("[ddl]")).not.toBeInTheDocument();
    expect(screen.queryByText("未知")).not.toBeInTheDocument();
  });
});
