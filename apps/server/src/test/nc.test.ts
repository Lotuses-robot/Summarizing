import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { makeApp, exitAfter, gracefulClose, registerSources, type AppDeps } from "../app";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";
import { makeNcAdapter, SWEEP_INTERVAL_MS } from "../sources/nc";
import {
  assembleBatch,
  dueGroups,
  NcEventSchema,
  type BufferedEvent,
  type GroupBuffer,
} from "../sources/nc/types";
import { wallClockFromUnix } from "../shared/time";
import { FakeLlm } from "./helpers/fakeLlm";

// nc 适配器（D-84 §3）：快收 204 / 白名单 fail-closed / 私聊丢 / 重推去重 /
// 去抖满窗封批 / 窗长 KV 生效 / 图片段占位 / 关闭时强制封批。
// 封批经 ctx.setInterval 起的扫描定时器触发——测试用假时钟推进（不等真 5s）；纯函数单独测。
// 「自动封批防饿死」一个用例**故意用真定时器等 5s**（守卫 unref 饿死回归，见下）。

// 扫描间隔直接 import 自适配器（单一来源）——推进假时钟多于此即触发一次封批。

/** 本文件创建的全部 app——afterEach 统一 close：触发信源 stop + 清理表（清定时器），
 *  否则 handler 与定时器跨用例累积。 */
const openApps: FastifyInstance[] = [];

afterEach(async () => {
  vi.useRealTimers(); // 任何用例用过假时钟都恢复，防跨用例污染
  for (const a of openApps.splice(0)) {
    await a.close();
  }
});

/** 只假 setInterval/clearInterval（不假 setTimeout/Date/微任务）——封批扫描可被假时钟推进，
 *  而 fastify inject 的内部定时器照常工作（全量假时钟会让 inject 挂死）。 */
function useSweepFakeTimers(): void {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
}

/** 推进假时钟触发一次封批扫描（替代已删的 adapter.sweep()）。 */
function sweepNow(): void {
  vi.advanceTimersByTime(SWEEP_INTERVAL_MS + 1);
}

/** 造一个带白名单的 nc app（设置直接写库，等价联调 curl）。 */
function makeNcApp(
  llm: FakeLlm,
  groups: Record<string, string> | null,
  windowMinutes?: number,
  opts: { fakeTimers?: boolean } = {},
) {
  const db = makeDb(":memory:");
  if (groups !== null) {
    repo.setSourceSetting(db, "nc", "groups", JSON.stringify(groups));
  }
  if (windowMinutes !== undefined) {
    repo.setSourceSetting(db, "nc", "windowMinutes", JSON.stringify(windowMinutes));
  }
  const adapter = makeNcAdapter();
  const deps: AppDeps = { db, llmRef: { current: llm } };
  const app = makeApp(deps);
  // 先起假定时器再登记信源——信源经 ctx.setInterval 起的扫描定时器才会被假时钟接管（sweepNow 才能推进）
  if (opts.fakeTimers !== false) useSweepFakeTimers();
  registerSources(app, deps, [adapter]);
  openApps.push(app);
  return { db, app };
}

/** 造一条群消息事件（默认群 g1、发信人小明）。 */
function groupEvent(opts: {
  groupId: string;
  messageId: string;
  text: string;
  time: number;
  sender?: string;
  message?: unknown;
  messageType?: string;
}) {
  return {
    post_type: "message",
    message_type: opts.messageType ?? "group",
    group_id: opts.groupId,
    message_id: opts.messageId,
    user_id: "10001",
    raw_message: opts.text,
    time: opts.time,
    sender: { user_id: "10001", nickname: opts.sender ?? "小明" },
    ...(opts.message === undefined ? {} : { message: opts.message }),
  };
}

/** 投递一条 webhook 事件（返回 inject 响应）。 */
function emit(
  app: ReturnType<typeof makeApp>,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url: "/api/sources/nc/event", payload });
}
describe("nc 适配器：纯函数", () => {
  /** assembleBatch 夹具工厂：默认 小明/10001/英语群/2026-09-28T10:00:00，按需覆盖（specs/003）。 */
  function mkEvent(overrides: {
    messageId: string;
    content?: string;
    sender?: string;
    senderId?: string;
    role?: string;
    at?: string;
  }): BufferedEvent {
    const content = overrides.content ?? "内容";
    return {
      messageId: overrides.messageId,
      content,
      sender: overrides.sender ?? "小明",
      senderId: overrides.senderId ?? "1",
      ...(overrides.role === undefined ? {} : { role: overrides.role }),
      groupName: "英语群",
      at: overrides.at ?? "2026-09-28T10:00:00",
      raw: NcEventSchema.parse(
        groupEvent({
          groupId: "g1",
          messageId: overrides.messageId,
          text: content,
          time: 1,
          sender: overrides.sender,
        }),
      ),
    };
  }

  it("dueGroups：静默 ≥ 窗口的组才命中（去抖语义，从组内最后一条起算）", () => {
    const buffers = new Map<string, GroupBuffer>([
      ["g1", { groupId: "g1", events: [], lastAt: "2026-09-28T10:00:00" }], // 距今 4 分钟
      ["g2", { groupId: "g2", events: [], lastAt: "2026-09-28T10:02:30" }], // 距今 1 分半
    ]);
    const nowMs = Date.parse("2026-09-28T10:04:00");
    expect(dueGroups(buffers, nowMs, 3).map((b) => b.groupId)).toEqual(["g1"]);
  });

  it("assembleBatch：行协议逐行署名，eventTime = 首条时刻（specs/003）", () => {
    const batch = assembleBatch({
      groupId: "g1",
      events: [
        mkEvent({ messageId: "m1", at: "2026-09-28T10:00:00", content: "通知" }),
        mkEvent({ messageId: "m2", at: "2026-09-28T10:00:30", content: "细节" }),
      ],
      lastAt: "2026-09-28T10:00:30",
    });
    expect(batch.content).toBe("[10:00] 小明: 通知\n[10:00] 小明: 细节");
    expect(batch.eventTime).toBe("2026-09-28T10:00:00");
    expect(batch.raw).toHaveLength(2);
    expect(batch.sender).toBe("小明"); // 单人批次：唯一发送者照写
  });

  it("assembleBatch：多人批次逐行各归其主，sender 键省略（specs/003 US1/US2）", () => {
    const batch = assembleBatch({
      groupId: "g1",
      events: [
        mkEvent({ messageId: "m1", at: "2026-09-28T10:00:00", content: "谁看到通知了" }),
        mkEvent({
          messageId: "m2",
          at: "2026-09-28T10:00:20",
          content: "在我这",
          sender: "小红",
          senderId: "10002",
        }),
        mkEvent({ messageId: "m3", at: "2026-09-28T10:00:40", content: "放学来拿" }),
      ],
      lastAt: "2026-09-28T10:00:40",
    });
    expect(batch.content).toBe(
      "[10:00] 小明: 谁看到通知了\n[10:00] 小红: 在我这\n[10:00] 小明: 放学来拿",
    );
    expect(batch.sender).toBeUndefined(); // 多人批次不说谎：不写 sender
  });

  it("assembleBatch：群身份括注只认 owner/admin（大小写归一）；member 与缺席无噪声（specs/003 US3+评审）", () => {
    const batch = assembleBatch({
      groupId: "g1",
      events: [
        mkEvent({ messageId: "m1", content: "我宣布", role: "owner" }),
        mkEvent({ messageId: "m2", content: "同意", role: "admin" }),
        mkEvent({ messageId: "m3", content: "哦", role: "member" }),
        mkEvent({ messageId: "m4", content: "大写也认", role: "Owner" }),
        mkEvent({ messageId: "m5", content: "…" }),
      ],
      lastAt: "2026-09-28T10:00:40",
    });
    expect(batch.content).toBe(
      "[10:00] 小明（群主）: 我宣布\n[10:00] 小明（管理员）: 同意\n[10:00] 小明: 哦\n[10:00] 小明（群主）: 大写也认\n[10:00] 小明: …",
    );
  });

  it("assembleBatch：多行消息续行缩进，正文引文仍可命中（specs/003 评审修正）", () => {
    const batch = assembleBatch({
      groupId: "g1",
      events: [
        mkEvent({ messageId: "m1", content: "作业要求：\n1. 先写作文\n2. 下周交" }),
        mkEvent({ messageId: "m2", content: "收到" }),
      ],
      lastAt: "2026-09-28T10:00:30",
    });
    expect(batch.content).toBe(
      "[10:00] 小明: 作业要求：\n  1. 先写作文\n  2. 下周交\n[10:00] 小明: 收到",
    );
    // 引文（fence 空白归一比对）不受缩进影响：正文片段仍是子串
    expect(batch.content.includes("1. 先写作文")).toBe(true);
  });

  it("assembleBatch：跨天批次时刻升级为 [MM-DD HH:mm]（specs/003 Edge）", () => {
    const batch = assembleBatch({
      groupId: "g1",
      events: [
        mkEvent({ messageId: "m1", at: "2026-09-28T23:59:00", content: "睡前最后一句" }),
        mkEvent({ messageId: "m2", at: "2026-09-29T00:01:00", content: "补充" }),
      ],
      lastAt: "2026-09-29T00:01:00",
    });
    expect(batch.content).toBe("[09-28 23:59] 小明: 睡前最后一句\n[09-29 00:01] 小明: 补充");
  });

  it("assembleBatch：消息正文是 content 的连续子串（引文逐字校验兼容，specs/003 SC-002）", () => {
    const batch = assembleBatch({
      groupId: "g1",
      events: [
        mkEvent({ messageId: "m1", content: "英语作业下周三交" }),
        mkEvent({ messageId: "m2", content: "收到" }),
      ],
      lastAt: "2026-09-28T10:00:30",
    });
    expect(batch.content.includes("英语作业下周三交")).toBe(true);
    expect(batch.content.includes("收到")).toBe(true);
  });

  it("assembleBatch：同显示名不同 senderId 视为多人，sender 省略（specs/003 评审修正）", () => {
    const batch = assembleBatch({
      groupId: "g1",
      events: [
        mkEvent({ messageId: "m1", senderId: "10001", content: "我在 3 排" }),
        mkEvent({ messageId: "m2", senderId: "10002", content: "我在 7 排" }),
      ],
      lastAt: "2026-09-28T10:00:00",
    });
    expect(batch.content).toBe("[10:00] 小明: 我在 3 排\n[10:00] 小明: 我在 7 排");
    expect(batch.sender).toBeUndefined(); // 两个不同的 user_id——不能署成一个人
  });

  it("wallClockFromUnix：unix 秒 → 本地墙钟（D-64 格式）", () => {
    expect(wallClockFromUnix(1790595828)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

describe("nc 适配器：webhook 快收", () => {
  it("白名单群消息 → 204 + 入缓冲（不立即落档）", async () => {
    const { db, app } = makeNcApp(new FakeLlm(), { g1: "英语课官方群" });
    const res = await emit(
      app,
      groupEvent({ groupId: "g1", messageId: "m1", text: "作业通知", time: 1790595828 }),
    );
    expect(res.statusCode).toBe(204);
    expect(repo.listRawInputsByState(db, "pending")).toHaveLength(0); // 缓冲中，未投递
  });

  it("白名单外群 → 204 丢（缓冲与落档都没有）", async () => {
    const { db, app } = makeNcApp(new FakeLlm(), { g1: "英语群" });
    const res = await emit(
      app,
      groupEvent({ groupId: "g999", messageId: "m1", text: "闲聊", time: 1790595828 }),
    );
    expect(res.statusCode).toBe(204);
    sweepNow();
    expect(repo.listRawInputsByState(db, "pending")).toHaveLength(0);
  });

  it("未配置白名单（fail-closed）→ 全丢", async () => {
    const { db, app } = makeNcApp(new FakeLlm(), null);
    const res = await emit(
      app,
      groupEvent({ groupId: "g1", messageId: "m1", text: "x", time: 1790595828 }),
    );
    expect(res.statusCode).toBe(204);
    sweepNow();
    expect(repo.listRawInputsByState(db, "pending")).toHaveLength(0);
  });

  it("私聊与非消息事件 → 204 丢", async () => {
    const { db, app } = makeNcApp(new FakeLlm(), { g1: "英语群" });
    const priv = await emit(
      app,
      groupEvent({ groupId: "g1", messageId: "m1", text: "私聊", time: 1, messageType: "private" }),
    );
    const notice = await emit(app, { post_type: "notice", notice_type: "group_recall" });
    expect(priv.statusCode).toBe(204);
    expect(notice.statusCode).toBe(204);
    sweepNow();
    expect(repo.listRawInputsByState(db, "pending")).toHaveLength(0);
  });

  it("形状不符的请求体 → 204 静默丢（快收语义，不落档）", async () => {
    const { db, app } = makeNcApp(new FakeLlm(), { g1: "英语群" });
    const res = await app.inject({
      method: "POST",
      url: "/api/sources/nc/event",
      payload: "not an event",
      headers: { "content-type": "text/plain" },
    });
    expect(res.statusCode).toBe(204); // nc 规范：一律快收，非事件静默丢
    expect(repo.listRawInputsByState(db, "pending")).toHaveLength(0);
  });
});

describe("nc 适配器：去抖封批全链路", () => {
  it("静默满窗 sweep → 合并投递 → agent0 消化（弹性的 sourceIdentity）", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' }); // 消化轮：零变更合法
    const { db, app } = makeNcApp(llm, { g1: "英语课官方群" }, 0); // 窗长 0

    await emit(
      app,
      groupEvent({ groupId: "g1", messageId: "m1", text: "通知：作业", time: 1790595828 }),
    );
    await emit(
      app,
      groupEvent({ groupId: "g1", messageId: "m2", text: "截止10月8日", time: 1790595830 }),
    );
    sweepNow();

    const digested = repo.listRawInputsByState(db, "digested");
    await vi.waitFor(
      () => {
        expect(repo.listRawInputsByState(db, "digested")).toHaveLength(1);
      },
      { timeout: 3000 },
    );
    expect(digested.length).toBeLessThanOrEqual(1);
    const raw = repo.listRawInputsByState(db, "digested")[0];
    if (!raw) throw new Error("封批未落档");
    expect(raw.sourceType).toBe("nc");
    const hm = wallClockFromUnix(1790595828).slice(11, 16);
    expect(raw.content).toBe(`[${hm}] 小明: 通知：作业\n[${hm}] 小明: 截止10月8日`); // 组内合并（行协议逐行署名，specs/003）
  });

  it("重推同一 message_id → 只投递一次", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    const { db, app } = makeNcApp(llm, { g1: "英语群" }, 0);
    const ev = groupEvent({ groupId: "g1", messageId: "m1", text: "唯一一条", time: 1790595828 });
    await emit(app, ev);
    await emit(app, ev); // 重推
    sweepNow();
    await vi.waitFor(
      () => {
        expect(repo.listRawInputsByState(db, "digested")).toHaveLength(1);
      },
      { timeout: 3000 },
    );
    expect(repo.listRawInputsByState(db, "digested")).toHaveLength(1);
  });

  it("已在缓冲的消息重推 → 不重复入缓冲（组内只一条）", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    const { db, app } = makeNcApp(llm, { g1: "英语群" }, 0);
    const ev = groupEvent({ groupId: "g1", messageId: "m1", text: "一次", time: 1790595828 });
    await emit(app, ev);
    await emit(app, ev);
    sweepNow();
    await vi.waitFor(
      () => {
        expect(repo.listRawInputsByState(db, "digested")).toHaveLength(1);
      },
      { timeout: 3000 },
    );
    const raw = repo.listRawInputsByState(db, "digested")[0];
    const hm = wallClockFromUnix(1790595828).slice(11, 16);
    expect(raw?.content).toBe(`[${hm}] 小明: 一次`); // 只有一条，未重复
  });

  it("图片段 → [图片](url) 占位（base64 不进 content）", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    const { db, app } = makeNcApp(llm, { g1: "英语群" }, 0);
    await emit(
      app,
      groupEvent({
        groupId: "g1",
        messageId: "m1",
        text: "[图片]",
        time: 1790595828,
        message: [
          { type: "text", data: { text: "看这个" } },
          { type: "image", data: { url: "https://cdn.example/x.jpg", file: "base64..." } },
        ],
      }),
    );
    sweepNow();
    await vi.waitFor(
      () => {
        expect(repo.listRawInputsByState(db, "digested")).toHaveLength(1);
      },
      { timeout: 3000 },
    );
    const raw = repo.listRawInputsByState(db, "digested")[0];
    const hm = wallClockFromUnix(1790595828).slice(11, 16);
    expect(raw?.content).toBe(`[${hm}] 小明: 看这个[图片](https://cdn.example/x.jpg)`);
    expect(raw?.content).not.toContain("base64");
  });

  it("raw 归档列：nc 原事件数组落库（D-84 §3.2 原始载荷留底——曾断线：适配器不传 raw）", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    const { db, app } = makeNcApp(llm, { g1: "英语群" }, 0);
    const event = groupEvent({
      groupId: "g1",
      messageId: "m1",
      text: "留底测试",
      time: 1790595828,
    });
    await emit(app, event);
    sweepNow();
    await vi.waitFor(
      () => {
        expect(repo.listRawInputsByState(db, "digested")).toHaveLength(1);
      },
      { timeout: 3000 },
    );
    // 直查 DB 的 raw 列（RawInput 类型不含它——归档字段只进不出，D-84）
    const row = z
      .object({ raw: z.string().nullable() })
      .parse(db.$client.prepare("SELECT raw FROM raw_inputs WHERE source_type='nc'").get());
    expect(row.raw).not.toBeNull();
    const parsed: unknown = JSON.parse(row.raw ?? "null");
    expect(Array.isArray(parsed)).toBe(true); // 原事件数组
    expect(JSON.stringify(parsed)).toContain("留底测试"); // 事件原文在内
  });

  it("全空消息批次 → 留痕丢弃不进消化（specs/003 评审修正：行协议前缀不得救活空批）", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' }); // 若守卫失效，这里会被垃圾批次消耗
    const { db, app } = makeNcApp(llm, { g1: "英语群" }, 0);
    await emit(
      app,
      groupEvent({
        groupId: "g1",
        messageId: "m1",
        text: "",
        time: 1790595828,
        message: [{ type: "face", data: { id: "1" } }], // 无可展开段 → 正文空
      }),
    );
    sweepNow();
    await new Promise((r) => setTimeout(r, 50)); // 若误投递，异步消化会落档——给它时间暴露
    expect(repo.listRawInputsByState(db, "digested")).toHaveLength(0);
    expect(repo.listRawInputsByState(db, "pending")).toHaveLength(0);
  });
});

describe("nc 适配器：窗长与关闭", () => {
  it("扫描定时器自动封批（真实等 5s 周期，不推进假时钟）——防 unref 饿死回归", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    const { db, app } = makeNcApp(llm, { g1: "英语群" }, 0, { fakeTimers: false }); // 真定时器
    await emit(
      app,
      groupEvent({ groupId: "g1", messageId: "m1", text: "定时器测试", time: 1790595828 }),
    );

    // 关键：不推进假时钟——等 setInterval 自己跑（曾因 timer.unref() 被饿死永不封批）
    await vi.waitFor(
      () => {
        expect(repo.listRawInputsByState(db, "digested")).toHaveLength(1);
      },
      { timeout: 8000 },
    );
  }, 10000);

  it("窗长设置生效：设 60 分钟则最近消息不封批（扫描在跑也不封）", async () => {
    const llm = new FakeLlm();
    const { db, app } = makeNcApp(llm, { g1: "英语群" }, 60); // 60 分钟窗
    // 用「刚刚」的事件时刻——否则固定过去时间会立即满窗（去抖从消息时刻起算）
    const nowSec = Math.floor(Date.now() / 1000);
    await emit(app, groupEvent({ groupId: "g1", messageId: "m1", text: "还在等", time: nowSec }));
    sweepNow(); // 推进一次扫描——未满窗，不封
    expect(repo.listRawInputsByState(db, "pending")).toHaveLength(0); // 仍在缓冲
    expect(repo.listRawInputsByState(db, "digested")).toHaveLength(0);
  });

  it("关闭（app.close）时强制封批全部组——SIGINT 归 core，信源 stop 收尾", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    const { db, app } = makeNcApp(llm, { g1: "英语群" }, 60); // 60 分钟窗（远未到期）
    await emit(
      app,
      groupEvent({ groupId: "g1", messageId: "m1", text: "急着走", time: 1790595828 }),
    );

    // 触发 onClose → 信源 stop() 强制封批（SIGINT 归 core 的 index.ts，此处只验 stop）
    await app.close();
    await vi.waitFor(
      () => {
        expect(repo.listRawInputsByState(db, "digested")).toHaveLength(1);
      },
      { timeout: 3000 },
    );
  });

  it("SIGINT 关停内核：封批后显式 exit(0)，close 失败也保底退出（Ctrl-C 停得掉——评审 C1 回归守卫）", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    const { db, app } = makeNcApp(llm, { g1: "英语群" }, 60); // 60 分钟窗（远未到期）
    await emit(
      app,
      groupEvent({ groupId: "g1", messageId: "m1", text: "急着走", time: 1790595828 }),
    );

    // exit 的返回类型是 never——桩用 throw 真实满足它（零类型断言）；
    // exitAfter(gracefulClose(app)) 就是 index.ts 的 SIGINT 处理内核，await 它让桩抛出可被接住。
    /** exit 桩：抛出代表「被调用」。 */
    function fakeExit(code?: string | number | null): never {
      throw new Error(`exit:${code ?? 0}`);
    }
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(fakeExit);
    try {
      await expect(exitAfter(gracefulClose(app))).rejects.toThrow("exit:0");
      expect(exitSpy).toHaveBeenCalledWith(0); // 封批后显式退出——否则 Ctrl-C 停不掉进程
      await vi.waitFor(
        () => {
          expect(repo.listRawInputsByState(db, "digested")).toHaveLength(1); // 缓冲封批已落库
        },
        { timeout: 3000 },
      );
    } finally {
      exitSpy.mockRestore();
    }
  });
});
