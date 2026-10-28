import { afterEach, describe, expect, it, vi } from "vitest";
import * as repo from "../storage/repo";
import { makeWxwebAdapter, SEAL_MAX_ATTEMPTS, SWEEP_INTERVAL_MS } from "../sources/wxweb";
import {
  assembleBatch,
  dueGroups,
  WxEventSchema,
  type BufferedEvent,
  type GroupBuffer,
  type SealThresholds,
} from "../sources/wxweb/types";
import { cleanupAllTestAccounts, makeTestAccount, type TestAccount } from "./helpers/app";
import { FakeLlm } from "./helpers/fakeLlm";

// 微信消息适配器（docs/14）：走 `/hook/<令牌>/wxweb/event` 网关。
// 覆盖：快收 204 / 自身消息丢弃 / 白名单 fail-closed / 重推去重 / 非文本占位 /
// 引用回复 / 真假时刻（禁接收兜底）/ 四闸封批 / 行协议。

afterEach(async () => {
  vi.useRealTimers();
  await cleanupAllTestAccounts();
});

/** 只假 setInterval/clearInterval（不假 Date/微任务）——封批扫描可被假时钟推进，
 *  而 fastify inject 的内部定时器照常工作。 */
function useSweepFakeTimers(): void {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
}

/** 推进假时钟触发一次封批扫描。 */
function sweepNow(): void {
  vi.advanceTimersByTime(SWEEP_INTERVAL_MS + 1);
}

/** 造一个带白名单的微信消息测试账户（windowMinutes=0 = 每次扫描立即封批）。 */
async function makeWxApp(
  conversations: Record<string, string> | null,
  opts: { fakeTimers?: boolean } = {},
): Promise<TestAccount> {
  if (opts.fakeTimers !== false) useSweepFakeTimers();
  const t = await makeTestAccount({ llm: new FakeLlm() });
  if (conversations !== null) {
    repo.setSourceSetting(t.db, "wxweb", "conversations", JSON.stringify(conversations));
  }
  repo.setSourceSetting(t.db, "wxweb", "windowMinutes", JSON.stringify(0));
  return t;
}

/** 一条群消息事件（字段照 docs/14 §4.2 的真实抓取值）。 */
function groupEvent(over: {
  messageId: string;
  text: string;
  userId?: string;
  nickname?: string;
  convId?: string;
  convName?: string;
  time?: number | null;
  isSelf?: boolean;
  type?: number;
  typeName?: string;
  quoteFrom?: string | null;
  segments?: { type: string; data?: Record<string, unknown> }[];
}): unknown {
  const convId = over.convId ?? "49159426819@chatroom";
  return {
    time: over.time === undefined ? 1793101146 : over.time,
    self_id: "wxid_1p4nyyjk5ztn19_0e21",
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: over.messageId,
    user_id: over.userId ?? "wxid_1c7w1m1gafnu22",
    message: over.segments ?? [{ type: "text", data: { text: over.text } }],
    raw_message: over.text,
    font: 0,
    sender: {
      user_id: over.userId ?? "wxid_1c7w1m1gafnu22",
      nickname: over.nickname ?? "如鱼得水",
      card: over.nickname ?? "如鱼得水",
      role: "member",
    },
    wx: {
      conv_id: convId,
      conv_name: over.convName ?? "改名测试2",
      sender_name: over.nickname ?? "如鱼得水",
      type: over.type ?? 1,
      type_name: over.typeName ?? "文本",
      is_self: over.isSelf ?? false,
      quote_from: over.quoteFrom ?? null,
      raw: over.text,
    },
    group_id: convId,
    anonymous: null,
  };
}

/** 投递一条事件到 webhook（真入口：走网关 + 令牌鉴权）。 */
async function post(t: TestAccount, event: unknown): Promise<number> {
  const res = await t.inject({
    method: "POST",
    url: `/hook/${t.space.sourceToken}/wxweb/event`,
    // 上游固定发 application/json（docs/14 §2.1）；字符串载荷必须显式带这个头，
    // 否则 Fastify 按 text/plain 解析 → 415
    headers: { "content-type": "application/json; charset=utf-8" },
    payload: typeof event === "string" ? event : JSON.stringify(event),
  });
  return res.statusCode;
}

/** 全部批次（**落库 ≠ 消化完**：封批后立刻 insert，状态 pending；消化是异步的）。
 *  这些用例关心的是「消息有没有按协议落到库里」，故三种状态合起来算。 */
function raws(t: TestAccount) {
  return [
    ...repo.listRawInputsByState(t.db, "pending"),
    ...repo.listRawInputsByState(t.db, "digesting"),
    ...repo.listRawInputsByState(t.db, "digested"),
    ...repo.listRawInputsByState(t.db, "failed"),
  ];
}

/** 推进一次封批扫描（封批是同步的：组装 → ingest → insert，当拍就落库）。 */
function sealNow(): void {
  sweepNow();
}

describe("接线：webhook 快收", () => {
  it("白名单内的消息 → 204，封批后落库", async () => {
    const t = await makeWxApp({ "49159426819@chatroom": "测试群" });
    expect(await post(t, groupEvent({ messageId: "m1", text: "测试消息内容" }))).toBe(204);

    sealNow();
    const rows = raws(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("wxweb");
    expect(rows[0]?.identity["displayName"]).toBe("测试群");
    expect(rows[0]?.identity["conversationId"]).toBe("49159426819@chatroom");
    expect(rows[0]?.content).toContain("测试消息内容");
    // 行协议：`[时刻] 发送者: 正文`
    expect(rows[0]?.content).toMatch(/^\[\d{2}:\d{2}\] 如鱼得水: 测试消息内容/);
  });

  it("形状不符 → 不炸、不落库", async () => {
    const t = await makeWxApp({ "49159426819@chatroom": "测试群" });
    // 合法 JSON 但不是消息事件 → 我们回 204（收下了但不需要）
    expect(await post(t, { hello: "world" })).toBe(204);
    // 不是合法 JSON 的载荷在 Fastify 解析层就被拒（400）——不到我们的处理器
    expect(await post(t, "not an object")).toBe(400);
    sealNow();
    expect(raws(t)).toHaveLength(0);
  });
});

describe("自身消息：只认 wx.is_self（docs/14 §4.7）", () => {
  it("is_self=true → 丢弃（哪怕 user_id 与 self_id 不等）", async () => {
    const t = await makeWxApp({ "49159426819@chatroom": "测试群" });
    // 微信库里自己的消息 user_id 不带后缀、self_id 带后缀——字符串不等，但 is_self 准确
    await post(
      t,
      groupEvent({
        messageId: "m1",
        text: "我自己说的话",
        userId: "wxid_1p4nyyjk5ztn19",
        isSelf: true,
      }),
    );
    sealNow();
    expect(raws(t)).toHaveLength(0);
  });

  it("反例：is_self=false 但 user_id == self_id 仍收（不按字符串判）", async () => {
    const t = await makeWxApp({ "49159426819@chatroom": "测试群" });
    await post(
      t,
      groupEvent({
        messageId: "m1",
        text: "别人说的",
        userId: "wxid_1p4nyyjk5ztn19_0e21", // 恰好等于 self_id
        isSelf: false,
      }),
    );
    sealNow();
    expect(raws(t)).toHaveLength(1);
  });
});

describe("白名单：fail-closed", () => {
  it("未配置白名单 → 全都不收", async () => {
    const t = await makeWxApp(null);
    await post(t, groupEvent({ messageId: "m1", text: "x" }));
    sealNow();
    expect(raws(t)).toHaveLength(0);
  });

  it("不在白名单的会话 → 丢弃；键是 conv_id 原文（含 @chatroom）", async () => {
    const t = await makeWxApp({ "49159426819": "少写了后缀" }); // 键不完整
    await post(t, groupEvent({ messageId: "m1", text: "x" }));
    sealNow();
    expect(raws(t)).toHaveLength(0);
  });
});

describe("去重（上游明确要求接收侧做，docs/14 §6）", () => {
  it("同一 message_id 重推 → 只入库一次", async () => {
    const t = await makeWxApp({ "49159426819@chatroom": "测试群" });
    const ev = groupEvent({ messageId: "dup-1", text: "只该出现一次" });
    await post(t, ev);
    await post(t, ev);
    await post(t, ev);
    sealNow();
    const rows = raws(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content.match(/只该出现一次/g)).toHaveLength(1);
  });
});

describe("非文本消息与引用回复", () => {
  it("非文本 → 用占位文本（上游已转好），不猜内容", async () => {
    const t = await makeWxApp({ "49159426819@chatroom": "测试群" });
    await post(
      t,
      groupEvent({
        messageId: "m1",
        text: "[图片]",
        type: 3,
        typeName: "图片",
        segments: [{ type: "text", data: { text: "[图片]" } }],
      }),
    );
    sealNow();
    const rows = raws(t);
    expect(rows[0]?.content).toContain("[图片]");
  });

  it("引用回复 → 正文前置「（回复 X）」，不回显 reply 段的 id", async () => {
    const t = await makeWxApp({ "49159426819@chatroom": "测试群" });
    await post(
      t,
      groupEvent({
        messageId: "m1",
        text: "OHOHOH",
        quoteFrom: "如鱼得水",
        segments: [
          { type: "reply", data: { id: "112" } },
          { type: "text", data: { text: "OHOHOH" } },
        ],
      }),
    );
    sealNow();
    const content = raws(t)[0]?.content ?? "";
    expect(content).toContain("（回复 如鱼得水）OHOHOH");
    // reply 段的 id 是本条自己的 local_id，不是被引用消息——不该出现在正文里
    expect(content).not.toContain("112");
  });
});

describe("时刻：无真时刻不兜底进 eventTime（01§5.3）", () => {
  it("time 缺失 → eventTime 为 null，但行前缀仍有机械时刻", async () => {
    const t = await makeWxApp({ "49159426819@chatroom": "测试群" });
    await post(t, groupEvent({ messageId: "m1", text: "没带时刻", time: null }));
    sealNow();
    const rows = raws(t);
    expect(rows[0]?.eventTime).toBeNull();
    expect(rows[0]?.content).toMatch(/^\[\d{2}:\d{2}\]/); // 机械时刻照有
  });

  it("time 是字符串数字也认（历史桥接形态）", () => {
    // 数字形态（官方示例）
    expect(
      WxEventSchema.parse(groupEvent({ messageId: "m1", text: "x", time: 1793101146 })).time,
    ).toBe(1793101146);

    // 字符串形态：直接构造一条完整事件（不走 groupEvent 的 number 签名）
    const asString = {
      post_type: "message",
      message_type: "private",
      message_id: "m2",
      user_id: "u1",
      raw_message: "x",
      time: "1793101146",
      wx: { conv_id: "u1", is_self: false },
    };
    expect(WxEventSchema.parse(asString).time).toBe(1793101146);

    // 非法字符串 → null（不猜、不当 0）
    expect(WxEventSchema.parse({ ...asString, time: "not-a-number" }).time).toBeNull();
  });
});

/** 造一条缓冲事件（纯函数测试用）——raw 走真实 schema 构造，不用类型断言。 */
function bufEvent(id: string, at: string): BufferedEvent {
  return {
    messageId: id,
    content: `第 ${id} 条`,
    sender: "某人",
    senderId: "s1",
    displayName: "群",
    conversationName: "上游群名",
    at,
    trueTime: true,
    raw: WxEventSchema.parse(groupEvent({ messageId: id, text: `第 ${id} 条` })),
  };
}

describe("封批四闸（与 nc 同语义）", () => {
  const T: SealThresholds = {
    windowMinutes: 3,
    maxEvents: 3,
    maxBytes: 10_000,
    maxAgeMinutes: 10,
  };

  it("条数闸：达到上限即切", () => {
    const b: GroupBuffer = {
      groupId: "g",
      events: [
        bufEvent("1", "2026-09-28T10:00:00"),
        bufEvent("2", "2026-09-28T10:00:01"),
        bufEvent("3", "2026-09-28T10:00:02"),
      ],
      lastAt: "2026-09-28T10:00:02",
      lastSeenAt: "2026-09-28T10:00:02",
      firstSeenAt: "2026-09-28T10:00:00",
    };
    expect(dueGroups(new Map([["g", b]]), 1_790_000_000_000, T)).toHaveLength(1);
  });

  it("静默闸按**到达时刻**算，不按消息时刻（补推积压不误触发）", () => {
    const b: GroupBuffer = {
      groupId: "g",
      events: [bufEvent("1", "2020-01-01T00:00:00")], // 消息很旧
      lastAt: "2020-01-01T00:00:00",
      lastSeenAt: "2026-09-28T10:00:00", // 刚到达
      firstSeenAt: "2026-09-28T10:00:00",
    };
    const justNow = Date.parse("2026-09-28T10:00:10+08:00");
    expect(dueGroups(new Map([["g", b]]), justNow, T)).toHaveLength(0);
  });
});

describe("行协议（D-91 同口径）", () => {
  it("多行消息：续行缩进两空格，每条只有一个前缀", () => {
    const b: GroupBuffer = {
      groupId: "g",
      events: [{ ...bufEvent("1", "2026-09-28T10:00:00"), content: "第一行\n第二行" }],
      lastAt: "2026-09-28T10:00:00",
    };
    const batch = assembleBatch(b);
    expect(batch.content).toBe("[10:00] 某人: 第一行\n  第二行");
    expect(batch.hasContent).toBe(true);
  });

  it("空正文的批次 hasContent=false（行前缀不掩盖空）", () => {
    const b: GroupBuffer = {
      groupId: "g",
      events: [{ ...bufEvent("1", "2026-09-28T10:00:00"), content: "   " }],
      lastAt: "2026-09-28T10:00:00",
    };
    expect(assembleBatch(b).hasContent).toBe(false);
  });

  it("昵称里的冒号被折成全角（不破坏行结构）", () => {
    const b: GroupBuffer = {
      groupId: "g",
      events: [{ ...bufEvent("1", "2026-09-28T10:00:00"), sender: "a:b" }],
      lastAt: "2026-09-28T10:00:00",
    };
    // 昵称里的半角冒号被折成全角：正文一侧不再出现「名字里的冒号」
    // （时间前缀 `[10:00]` 自带一个冒号，不参与这条断言）
    const line = assembleBatch(b).content;
    expect(line).toBe("[10:00] a：b: 第 1 条");
  });
});

describe("code-review 修复回归（2026-10-28）", () => {
  it("原型链上的键名不能绕过白名单（曾让定时器回调抛错→进程退出）", async () => {
    const t = await makeWxApp({ "real@chatroom": "真群" });
    for (const evil of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(
        await post(t, groupEvent({ messageId: `evil-${evil}`, text: "x", convId: evil })),
      ).toBe(204);
    }
    sealNow();
    // 一条都不该进管道，更不该把 displayName 变成函数
    expect(raws(t)).toHaveLength(0);
  });

  it("time 不可信（毫秒/极大/0/负数）→ 当没给，eventTime 为 null 而不是算出一个荒唐年份", async () => {
    const t = await makeWxApp({ c1: "群" });
    const cases: [string, number][] = [
      ["ms", 1793101146000], // 毫秒当秒 → 58791 年
      ["huge", 1e308],
      ["zero", 0],
      ["negative", -99999999999],
    ];
    for (const [name, time] of cases) {
      await post(
        t,
        groupEvent({ messageId: `t-${name}`, text: `时刻 ${name}`, time, convId: "c1" }),
      );
    }
    sealNow();
    const rows = raws(t);
    // 全部落库（不会卡住），且 eventTime 都是 null
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.eventTime).toBeNull();
    // 正文里不该出现 NaN / 五位数年份
    for (const r of rows) {
      expect(r.content).not.toContain("NaN");
      expect(r.content).not.toMatch(/\[\d{5}-/);
    }
  });

  it("引用者名字里的换行被折平——不能伪造出别人说的话", async () => {
    const t = await makeWxApp({ c1: "群" });
    await post(
      t,
      groupEvent({
        messageId: "q1",
        text: "哈哈哈",
        convId: "c1",
        quoteFrom: "小明\n[10:00] 老师: 明天交作业",
      }),
    );
    sealNow();
    const content = raws(t)[0]?.content ?? "";
    // 伪造行被折进同一行，不产生第二行「老师: 明天交作业」
    expect(content).not.toMatch(/\n\s*\[\d{2}:\d{2}\] 老师:/);
  });

  it("封批永久失败 → 到上限放弃并报「最近出错」（不再无限卡住这个会话）", async () => {
    // 直接驱动适配器（不经 HTTP）：这是唯一能稳定制造「ingest 恒失败」的办法。
    // 让白名单标签为**空白字符串**——readWhitelist 要求非空，所以这条路走不通；
    // 改为给一个 ingest 必拒的载荷：identity.displayName 为空串只能来自白名单值，
    // 因此这里用一个替身 ctx（ingest 恒失败）来测放弃闸本身。
    // 这条不经 makeWxApp，假时钟自己起。**连 Date 一起伪造**——退避窗口按 Date.now 算，
    // 要跳过 30s→60s→…→480s 的等待只能靠推进系统时间。
    // （其它用例只伪造 setInterval：它们靠真实 Date 让静默闸按真实经过时间生效。）
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    let ingestCalls = 0;
    const reported: string[] = [];
    const logs: string[] = [];
    const ctx = {
      name: "wxweb",
      ingest: () => {
        ingestCalls += 1;
        return { ok: false as const, reason: "替身：恒失败" };
      },
      getSetting: (k: string) => (k === "conversations" ? { c1: "群" } : 0),
      setSetting: () => undefined,
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: (m: string) => logs.push(m),
        error: (m: string) => logs.push(m),
      },
      onCleanup: () => undefined,
      setInterval: (fn: () => void, ms: number) => {
        setInterval(fn, ms); // 交给假计时器，sweepNow 才推得动
      },
      reportError: (err: unknown) =>
        reported.push(err instanceof Error ? err.message : String(err)),
      markActivity: () => undefined,
    };
    const router = {
      post: () => undefined,
      get: () => undefined,
      put: () => undefined,
      delete: () => undefined,
    };
    const adapter = makeWxwebAdapter();
    adapter.register(ctx, router);
    expect(
      adapter.accept({
        raw: groupEvent({ messageId: "x1", text: "hi", convId: "c1" }),
        receivedAt: "2026-09-28T10:00:00",
      }).ok,
    ).toBe(true);

    // 退避窗口用**真实**时钟算（假计时器只伪造了 setInterval），只推进扫描会一直被挡住。
    // 每轮把系统时间往前跳 20 分钟（超过最大退避 10 分钟），窗口立即过期 → 下一次扫描立刻重试。
    for (let i = 0; i < SEAL_MAX_ATTEMPTS + 1; i++) {
      vi.setSystemTime(Date.now() + 20 * 60_000);
      sweepNow();
    }

    expect(ingestCalls).toBe(SEAL_MAX_ATTEMPTS); // 不再无限重试
    expect(reported.some((m) => m.includes("丢弃这批"))).toBe(true); // 可见的「最近出错」
    // 放弃后缓冲已清：再扫也不会再调 ingest
    sweepNow();
    expect(ingestCalls).toBe(SEAL_MAX_ATTEMPTS);
    // **不登记去重 id**：这批没落库，得让上游重放能救回来（docs/07 §五）
    expect(
      adapter.accept({
        raw: groupEvent({ messageId: "x1", text: "hi", convId: "c1" }),
        receivedAt: "2026-09-28T10:00:00",
      }).ok,
    ).toBe(true);
  });
});

describe("第二轮 review 修复（2026-10-28）", () => {
  it("只有引用、没有正文的消息 → 空批守卫仍然生效（不被「（回复 X）」衬成非空）", async () => {
    const t = await makeWxApp({ c1: "群" });
    // 上游把一张贴纸转成了空正文，只带 reply 段与 quote_from
    await post(
      t,
      groupEvent({
        messageId: "r1",
        text: "",
        convId: "c1",
        quoteFrom: "李四",
        segments: [{ type: "reply", data: { id: "9" } }],
      }),
    );
    sealNow();
    expect(raws(t)).toHaveLength(0); // 没内容就不该进管道
  });

  it("省略 message 数组的引用回复：仍然带「（回复 X）」", async () => {
    const t = await makeWxApp({ c1: "群" });
    await post(
      t,
      groupEvent({ messageId: "r2", text: "OHOHOH", convId: "c1", quoteFrom: "如鱼得水" }),
    );
    sealNow();
    expect(raws(t)[0]?.content).toContain("（回复 如鱼得水）OHOHOH");
  });

  it("is_self 认不出（null / 缺失 / 乱值）→ 当自己的消息丢弃，不冒收", async () => {
    const t = await makeWxApp({ c1: "群" });
    // 直接构造完整事件（不走 groupEvent 的强类型签名），逐个变体改 is_self
    /** 造一条只改 is_self 的完整事件（`omit` = 整个键缺席）。 */
    const make = (id: string, isSelf: unknown, omit = false): unknown => {
      const wx: Record<string, unknown> = { conv_id: "c1" };
      if (!omit) wx["is_self"] = isSelf;
      return {
        post_type: "message",
        message_type: "group",
        message_id: id,
        user_id: "wxid_u",
        message: [{ type: "text", data: { text: "不知道谁发的" } }],
        raw_message: "不知道谁发的",
        sender: { user_id: "wxid_u", nickname: "某人" },
        wx,
      };
    };
    await post(t, make("s-0", null));
    await post(t, make("s-1", undefined, true)); // 键整个缺席
    await post(t, make("s-2", "yes"));
    await post(t, make("s-3", "maybe"));
    sealNow();
    expect(raws(t)).toHaveLength(0);
  });

  it("放弃后**不登记去重 id**：上游重放能救回来（不再把瞬时故障变成永久丢失）", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    let fail = true;
    let ingestCalls = 0;
    const ctx = {
      name: "wxweb",
      ingest: () => {
        ingestCalls += 1;
        return fail
          ? { ok: false as const, reason: "替身：故障中" }
          : { ok: true as const, id: "x" };
      },
      getSetting: (k: string) => (k === "conversations" ? { c1: "群" } : 0),
      setSetting: () => undefined,
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      onCleanup: () => undefined,
      setInterval: (fn: () => void, ms: number) => {
        setInterval(fn, ms);
      },
      reportError: () => undefined,
      markActivity: () => undefined,
    };
    const adapter = makeWxwebAdapter();
    adapter.register(ctx, {
      post: () => undefined,
      get: () => undefined,
      put: () => undefined,
      delete: () => undefined,
    });
    const one = groupEvent({ messageId: "retry-1", text: "故障期间的消息", convId: "c1" });
    expect(adapter.accept({ raw: one, receivedAt: "2026-09-28T10:00:00" }).ok).toBe(true);

    // 一路失败到放弃
    for (let i = 0; i < SEAL_MAX_ATTEMPTS + 1; i++) {
      vi.setSystemTime(Date.now() + 20 * 60_000);
      sweepNow();
    }
    const afterGiveUp = ingestCalls;

    // 故障恢复，上游重放同一条——**必须还能进来**（没被去重吞掉）
    fail = false;
    vi.setSystemTime(Date.now() + 20 * 60_000);
    expect(adapter.accept({ raw: one, receivedAt: "2026-09-28T10:05:00" }).ok).toBe(true);
    vi.setSystemTime(Date.now() + 20 * 60_000);
    sweepNow();
    expect(ingestCalls).toBeGreaterThan(afterGiveUp);
  });
});

describe("第三轮 review 修复（2026-10-28）", () => {
  it("乱序到达：eventTime 取**最早**的，不是最先到的", () => {
    const late = bufEvent("a", "2026-09-28T10:20:00");
    const early = bufEvent("b", "2026-09-28T10:00:00");
    // 到达序是「晚的先到」
    const batch = assembleBatch({ groupId: "g", events: [late, early], lastAt: late.at });
    expect(batch.eventTime).toBe("2026-09-28T10:00:00");
  });

  it("存档保留上游未声明的字段（type / type_name / conv_name / wx.raw）", () => {
    const raw = {
      post_type: "message",
      message_type: "group",
      message_id: "x",
      user_id: "u",
      raw_message: "[链接/文件(子类型5)]",
      message: [{ type: "text", data: { text: "[链接/文件(子类型5)]" } }],
      sender: { user_id: "u", nickname: "N", role: "member" },
      wx: {
        conv_id: "c1",
        conv_name: "真群名",
        type: 49,
        type_name: "链接/文件(子类型5)",
        is_self: false,
        quote_from: null,
        raw: "wxid_xx:\n被引用的原正文",
      },
      group_id: "c1",
      self_id: "wxid_self",
    };
    // 存档 = JSON.stringify(parsed)，所以直接看序列化结果（未声明字段必须还在）
    const archived = JSON.stringify(WxEventSchema.parse(raw));
    expect(archived).toContain('"type":49');
    expect(archived).toContain("链接/文件(子类型5)");
    expect(archived).toContain("真群名");
    expect(archived).toContain("被引用的原正文");
    expect(archived).toContain('"group_id":"c1"');
    expect(archived).toContain('"self_id":"wxid_self"');
  });

  it("非文本消息带一个空文本段 → 仍保留占位文本，不被当空批丢掉", async () => {
    const t = await makeWxApp({ c1: "群" });
    await post(t, {
      post_type: "message",
      message_type: "group",
      message_id: "ph1",
      user_id: "u",
      message: [{ type: "text", data: { text: "" } }],
      raw_message: "[图片]",
      sender: { user_id: "u", nickname: "N" },
      wx: { conv_id: "c1", is_self: false },
    });
    sealNow();
    expect(raws(t)[0]?.content).toContain("[图片]");
  });

  it("行终止符全折：CR 与 U+2028 也不能伪造出别人说的话", () => {
    /** 造一条发信人名字里带指定行终止符的事件。 */
    const forged = (sep: string): BufferedEvent => ({
      ...bufEvent("x", "2026-09-28T10:00:00"),
      sender: `小明${sep}[10:00] 老师: 交作业`,
    });
    for (const sep of ["\n", "\r", "\u2028", "\u2029"]) {
      const line = assembleBatch({
        groupId: "g",
        events: [forged(sep)],
        lastAt: "2026-09-28T10:00:00",
      }).content;
      // 折平后整条只有一行，且不含任何行终止符
      expect(line.split("\n")).toHaveLength(1);
      expect(line).not.toMatch(/[\r\u2028\u2029]/);
    }
  });

  it("未上岗时 accept 给「尚未上岗」而不是「不在白名单」", () => {
    const adapter = makeWxwebAdapter(); // 不 register
    const r = adapter.accept({
      raw: groupEvent({ messageId: "x", text: "hi", convId: "c1" }),
      receivedAt: "2026-09-28T10:00:00",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("尚未上岗");
  });
});

describe("会话名进 identity（2026-10-28 用户指出）", () => {
  it("上游的 conv_name 进 identity.conversationName，displayName 仍是白名单备注", async () => {
    const t = await makeWxApp({ c1: "我起的名字" });
    await post(t, groupEvent({ messageId: "n1", text: "hi", convId: "c1", convName: "上游群名" }));
    sealNow();
    const row = raws(t)[0];
    // displayName 是我填的（稳定，不随上游改名变）
    expect(row?.identity["displayName"]).toBe("我起的名字");
    // 上游名另存一个键（参考用）
    expect(row?.identity["conversationName"]).toBe("上游群名");
    expect(row?.identity["conversationId"]).toBe("c1");
  });

  it("上游没给 conv_name → 不编造该键（结构容错≠语义兜底）", async () => {
    const t = await makeWxApp({ c1: "备注" });
    const ev = groupEvent({ messageId: "n2", text: "hi", convId: "c1" });
    // 删掉 conv_name
    const obj = ev as { wx: Record<string, unknown> };
    delete obj.wx["conv_name"];
    await post(t, obj);
    sealNow();
    expect(raws(t)[0]?.identity).not.toHaveProperty("conversationName");
  });
});
