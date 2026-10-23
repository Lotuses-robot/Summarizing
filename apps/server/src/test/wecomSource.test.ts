import { describe, expect, it } from "vitest";
import { makeWecomAdapter } from "../sources/wecom";
import {
  appendLine,
  DEFAULT_KF_THRESHOLDS,
  dueStreams,
  type KfLine,
  type KfBuffer,
} from "../sources/wecom/batching";
import type { SourceContext, WebhookRegistrar } from "../sources/types";
import { nowWallClock } from "../shared/time";

// 企业微信 · 微信客服**信源**（D-128 / D-130 分层后）：
// 它只做三件事——解协议（`raw` → 行）、算流键（open_kfid + external_userid）、缓冲后四闸切段 → ingest。
// 验签/解密/拉取/绑定/回执全在 Router（`router/wecom/`），所以这里**没有任何 HTTP 与 fetch**。
//
// 入参 `raw` 就是 sync_msg 的一条消息对象——Router 把它原样转过来。

/** 造一条最小 text 消息。 */
function textMessage(args: {
  msgid: string;
  kfid?: string;
  ext?: string;
  content: string;
  origin?: number;
  at?: string;
}): Record<string, unknown> {
  return {
    msgid: args.msgid,
    open_kfid: args.kfid ?? "kf1",
    external_userid: args.ext ?? "cust-A",
    origin: args.origin ?? 3,
    msgtype: "text",
    text: { content: args.content },
    send_time: args.at ?? "1790000000",
  };
}

/** 记录型 SourceContext（只实现被测代码用得到的口；adapter 私有态与真实装配一致）。 */
function makeCtx(settings: Record<string, unknown> = {}): {
  ctx: SourceContext;
  ingested: Array<{ content: string; identity: Record<string, unknown>; eventTime: string | null }>;
  activities: string[];
  fireTimers: () => void;
} {
  const ingested: Array<{
    content: string;
    identity: Record<string, unknown>;
    eventTime: string | null;
  }> = [];
  const activities: string[] = [];
  const timers: Array<() => void> = [];
  const ctx: SourceContext = {
    name: "wecom",
    ingest(batch) {
      ingested.push({
        content: batch.content,
        identity: batch.identity,
        eventTime: batch.eventTime,
      });
      return { ok: true, id: `raw-${ingested.length}` };
    },
    getSetting: (key) => settings[key],
    setSetting: () => undefined,
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    onCleanup: () => undefined,
    setInterval: (fn) => {
      timers.push(fn);
    },
    reportError: () => undefined,
    markActivity: (key) => {
      activities.push(key);
    },
  };
  return { ctx, ingested, activities, fireTimers: () => timers.forEach((f) => f()) };
}

/** 收集登记的路由（本组用例不请求路由——信源不挂 HTTP）。 */
function makeRegistrar(): WebhookRegistrar {
  /** 什么都不做的路由处理器（本组用例不请求路由）。 */
  const noop = (): void => undefined;
  return { get: noop, post: noop, put: noop, delete: noop };
}

/** 上岗一个适配器（register + 返回 ctx 记录）。 */
function mount(settings: Record<string, unknown> = {}): {
  adapter: ReturnType<typeof makeWecomAdapter>;
  ingested: Array<{ content: string; identity: Record<string, unknown>; eventTime: string | null }>;
  activities: string[];
  fireTimers: () => void;
} {
  const { ctx, ingested, activities, fireTimers } = makeCtx(settings);
  const adapter = makeWecomAdapter();
  adapter.register(ctx, makeRegistrar());
  return { adapter, ingested, activities, fireTimers };
}

describe("微信客服信源：accept（解协议 → 算流键 → 缓冲）", () => {
  it("文本消息 → 缓冲；封批后 ingest，identity 带 openKfid / externalUserId / 展示名", () => {
    const { adapter, ingested } = mount();
    const res = adapter.accept({
      raw: textMessage({ msgid: "m1", content: "我要退货" }),
      receivedAt: "2026-10-23T10:00:00",
    });
    expect(res).toEqual({ ok: true });
    expect(ingested).toHaveLength(0); // 还没到闸门

    void adapter.stop?.();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.content).toContain("我要退货");
    expect(ingested[0]?.identity["openKfid"]).toBe("kf1");
    expect(ingested[0]?.identity["externalUserId"]).toBe("cust-A");
    expect(String(ingested[0]?.identity["displayName"])).toContain("cust-A".slice(-6));
  });

  it("send_time 是**数字**（官方 uint64）→ 收下（历史写成字符串也收）", () => {
    // 官方文档：msg_list.send_time 是 uint64，示例是裸数字 `"send_time": 1615478585`。
    // 只收字符串会让真实消息**整条被拒**——而且所有测试夹具都写字符串，本地永远绿。
    const { adapter, ingested } = mount();
    const numeric = adapter.accept({
      raw: {
        msgid: "m-num",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "数字时刻" },
        send_time: 1790000000,
      },
      receivedAt: "2026-10-23T10:00:00",
    });
    expect(numeric).toEqual({ ok: true });

    const quoted = adapter.accept({
      raw: {
        msgid: "m-str",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "字符串时刻" },
        send_time: "1790000001",
      },
      receivedAt: "2026-10-23T10:00:01",
    });
    expect(quoted).toEqual({ ok: true });

    void adapter.stop?.();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.content).toContain("数字时刻");
    expect(ingested[0]?.content).toContain("字符串时刻");
  });

  it("时刻的脏形态（空串/0/非数字/负数）→ eventTime 为 null，不造出 1970", () => {
    const { adapter, ingested } = mount();
    const dirty: Array<string | number> = ["", "  ", "abc", 0, -1];
    for (const [i, raw] of dirty.entries()) {
      void adapter.accept({
        raw: {
          msgid: `m-dirty-${i}`,
          open_kfid: "kf1",
          external_userid: "cust-A",
          origin: 3,
          msgtype: "text",
          text: { content: `脏时刻${i}` },
          send_time: raw,
        },
        receivedAt: "2026-10-23T10:00:00",
      });
    }
    void adapter.stop?.();
    expect(ingested).toHaveLength(1);
    // 全批都没有真时刻 → eventTime 必须是 null（01§5.3 禁接收时间兜底）
    expect(ingested[0]?.eventTime).toBeNull();
    expect(ingested[0]?.content).not.toContain("1970");
  });

  it("同一条消息重复投递 → 拒收（重投幂等：游标整页推进，中断会重来）", () => {
    const { adapter, ingested } = mount();
    const raw = textMessage({ msgid: "m-dup", content: "只说一次" });
    expect(adapter.accept({ raw, receivedAt: "2026-10-23T10:00:00" })).toEqual({ ok: true });
    expect(adapter.accept({ raw, receivedAt: "2026-10-23T10:00:01" })).toEqual({
      ok: false,
      reason: "重复消息（已在缓冲或已封批）",
    });
    void adapter.stop?.();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.content.match(/只说一次/g)).toHaveLength(1);
  });

  it("已封批的消息再投一次 → 仍拒收（去重集合跨封批保留）", () => {
    const { adapter, ingested } = mount();
    const raw = textMessage({ msgid: "m-after-seal", content: "封批之后重投" });
    void adapter.accept({ raw, receivedAt: "2026-10-23T10:00:00" });
    void adapter.stop?.(); // 强制封批
    expect(ingested).toHaveLength(1);
    expect(adapter.accept({ raw, receivedAt: "2026-10-23T10:00:02" }).ok).toBe(false);
    expect(ingested).toHaveLength(1);
  });

  it("同一客户连发两条 → 同一批（不是一条一批）", () => {
    const { adapter, ingested } = mount();
    adapter.accept({
      raw: textMessage({ msgid: "m1", content: "你好" }),
      receivedAt: "2026-10-23T10:00:00",
    });
    adapter.accept({
      raw: textMessage({ msgid: "m2", content: "想问下订单" }),
      receivedAt: "2026-10-23T10:00:05",
    });
    void adapter.stop?.();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.content).toContain("你好");
    expect(ingested[0]?.content).toContain("想问下订单");
  });

  it("两个客户 → **两批**，身份各带自己的 externalUserId（流键含客户 id）", () => {
    const { adapter, ingested } = mount();
    adapter.accept({
      raw: textMessage({ msgid: "m1", ext: "cust-A", content: "我要退货" }),
      receivedAt: "2026-10-23T10:00:00",
    });
    adapter.accept({
      raw: textMessage({ msgid: "m2", ext: "cust-B", content: "发票怎么开" }),
      receivedAt: "2026-10-23T10:00:01",
    });
    void adapter.stop?.();
    expect(ingested).toHaveLength(2);
    expect(ingested.map((b) => String(b.identity["externalUserId"])).sort()).toEqual([
      "cust-A",
      "cust-B",
    ]);
    expect(ingested.every((b) => b.identity["openKfid"] === "kf1")).toBe(true);
  });

  it("客服的回复与客户的提问进**同一条流**（按 origin 判方向，不按有无 external_userid）", () => {
    // 官方文档：客服回复也带 external_userid（那是「属于哪段对话」的键），方向看 origin
    //   3 = 微信客户  5 = 接待人员  4 = 系统事件
    const { adapter, ingested } = mount();
    adapter.accept({
      raw: {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "退货怎么操作" },
        send_time: "1790000000",
      },
      receivedAt: "2026-10-23T10:00:00",
    });
    adapter.accept({
      raw: {
        msgid: "m2",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 5,
        servicer_userid: "zhangsan",
        msgtype: "text",
        text: { content: "点这里申请即可" },
        send_time: "1790000010",
      },
      receivedAt: "2026-10-23T10:00:10",
    });
    void adapter.stop?.();
    expect(ingested).toHaveLength(1); // 同一段对话 = 一批
    expect(ingested[0]?.content).toContain("退货怎么操作");
    expect(ingested[0]?.content).toContain("点这里申请即可");
    expect(ingested[0]?.content).toContain("客服 zhangsan"); // 回复方署名到接待人员
  });

  it("图片消息 → 正文留占位（media_id 不当 URL 外发）", () => {
    const { adapter, ingested } = mount();
    adapter.accept({
      raw: {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "image",
        image: { media_id: "MEDIA123" },
        send_time: "1790000000",
      },
      receivedAt: "2026-10-23T10:00:00",
    });
    void adapter.stop?.();
    expect(ingested[0]?.content).toContain("[图片](wecom-media:MEDIA123)");
  });

  it("没有 external_userid → 拒收（不猜归属，避免把不同客户混进一条流）", () => {
    const { adapter, ingested } = mount();
    const res = adapter.accept({
      raw: { msgid: "m1", open_kfid: "kf1", msgtype: "text", text: { content: "客服侧消息" } },
      receivedAt: "2026-10-23T10:00:00",
    });
    expect(res.ok).toBe(false);
    void adapter.stop?.();
    expect(ingested).toHaveLength(0);
  });

  it("事件消息（msgtype=event）→ 拒收（不含可提取信息）", () => {
    const { adapter, ingested } = mount();
    const res = adapter.accept({
      raw: {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-A",
        msgtype: "event",
        event: { event_type: "enter_session" },
      },
      receivedAt: "2026-10-23T10:00:00",
    });
    expect(res.ok).toBe(false);
    void adapter.stop?.();
    expect(ingested).toHaveLength(0);
  });

  it("raw 不是对象 / 缺 msgtype → 拒收并带原因（不抛）", () => {
    const { adapter } = mount();
    expect(adapter.accept({ raw: "不是对象", receivedAt: "2026-10-23T10:00:00" }).ok).toBe(false);
    expect(
      adapter.accept({ raw: { open_kfid: "kf1" }, receivedAt: "2026-10-23T10:00:00" }).ok,
    ).toBe(false);
  });

  it("空正文 / 只有空白 → 拒收（不落一条空行）", () => {
    const { adapter } = mount();
    const res = adapter.accept({
      raw: {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-A",
        msgtype: "text",
        text: { content: "   " },
      },
      receivedAt: "2026-10-23T10:00:00",
    });
    expect(res.ok).toBe(false);
  });
});

describe("微信客服信源：四闸切段", () => {
  it("静默闸到期 → 扫描封批（不用等 stop）", () => {
    const { adapter, ingested, fireTimers } = mount({ windowMinutes: 0 });
    adapter.accept({
      raw: textMessage({ msgid: "m1", content: "你好" }),
      receivedAt: "2026-10-23T10:00:00",
    });
    fireTimers();
    expect(ingested).toHaveLength(1);
  });

  it("accept 成功即打点 receive（信源卡显示的是「收到」时间，不是封批时间）", () => {
    const { adapter, activities } = mount();
    void adapter.accept({
      raw: textMessage({ msgid: "m1", content: "你好" }),
      receivedAt: "2026-10-23T10:00:00",
    });
    expect(activities).toContain("receive");
  });

  it("封批时打点 seal（声明过的活动信号）", () => {
    const { adapter, activities } = mount({ windowMinutes: 0 });
    adapter.accept({
      raw: textMessage({ msgid: "m1", content: "你好" }),
      receivedAt: "2026-10-23T10:00:00",
    });
    void adapter.stop?.();
    expect(activities).toContain("seal");
  });

  it("阈值从设置读：改即生效（这里把静默拉到 999 分钟 → 扫描不切段）", () => {
    const { adapter, ingested, fireTimers } = mount({ windowMinutes: 999 });
    // 到达时刻取「现在」——闸门拿 Date.now() 比，喂一个过去的时刻会被判成早就静默了
    adapter.accept({
      raw: textMessage({ msgid: "m1", content: "你好" }),
      receivedAt: nowWallClock(),
    });
    fireTimers();
    expect(ingested).toHaveLength(0); // 999 分钟没到
  });
});

describe("分流缓冲（sources/wecom/batching.ts）", () => {
  /** 造一条最小行。 */
  function line(content: string): KfLine {
    return {
      messageId: null,
      content,
      sender: "x",
      senderId: null,
      at: null,
      mediaId: null,
      fromCustomer: true,
    };
  }

  it("按流键分流：不同键各自累积、互不串", () => {
    const buffers = new Map<string, KfBuffer>();
    appendLine(buffers, "a", "A", line("一条"), "2026-10-23T10:00:00");
    appendLine(buffers, "b", "B", line("另一条"), "2026-10-23T10:00:00");
    expect(buffers.size).toBe(2);
    expect(buffers.get("a")?.lines).toHaveLength(1);
    expect(buffers.get("b")?.lines).toHaveLength(1);
  });

  it("同一条流累积；字节数跟着涨", () => {
    const buffers = new Map<string, KfBuffer>();
    appendLine(buffers, "a", "A", line("一二三"), "2026-10-23T10:00:00");
    appendLine(buffers, "a", "A", line("四五"), "2026-10-23T10:00:05");
    const buf = buffers.get("a");
    expect(buf?.lines).toHaveLength(2);
    expect(buf?.bytes).toBe(Buffer.byteLength("一二三") + Buffer.byteLength("四五"));
  });

  it("条数闸命中也切段（忙流不用等静默）", () => {
    const buffers = new Map<string, KfBuffer>();
    for (let i = 0; i < 5; i += 1) {
      appendLine(buffers, "a", "A", line("x"), "2026-10-23T10:00:00");
    }
    const now = Date.parse("2026-10-23T10:00:01+08:00");
    expect(dueStreams(buffers, now, DEFAULT_KF_THRESHOLDS)).toHaveLength(0);
    expect(dueStreams(buffers, now, { ...DEFAULT_KF_THRESHOLDS, maxEvents: 5 })).toHaveLength(1);
  });

  it("龄期闸从**到达时刻**算（补推的旧消息时刻不触发误切）", () => {
    const buffers = new Map<string, KfBuffer>();
    appendLine(
      buffers,
      "a",
      "A",
      { ...line("补推的旧消息"), at: "2026-10-23T07:00:00" },
      "2026-10-23T10:00:00",
    );
    const now = Date.parse("2026-10-23T10:00:05+08:00");
    expect(dueStreams(buffers, now, DEFAULT_KF_THRESHOLDS)).toHaveLength(0);
  });
});
