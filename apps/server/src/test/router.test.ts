import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestRealm, cleanupAllTestAccounts, type TestRealm } from "./helpers/app";
import { makeWecomAdapter } from "../sources/wecom";
import { makeWecomIngress } from "../router/wecom/ingress";
import { makeBindingStore } from "../router/store";
import { setAccountStatus } from "../storage/registry";
import { writeRouterSetting } from "../router/settings";
import type { SourceAdapter } from "../sources/types";

// Router · 微信接入（D-130）：**部署级**的一对多接入。
//
// 这里测的全是 Router 的职责——验签、解密、拉取、绑定、投递、回执。
// 断言尽量走真实 HTTP 入口（`/relay/wecom/callback`）与真实 `makeApp`：企业微信看到的那个
// 状态码/响应体才是验收对象（宪法 V）；信源侧只有 `accept` 被调用这一件事与它有关。

/** 43 位 EncodingAESKey。 */
const AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG".slice(0, 43);
const CORP_ID = "ww1234567890abcdef";
const CALLBACK_TOKEN = "cb-token";

const CREDENTIALS: Record<string, string> = {
  "wecom.corpId": CORP_ID,
  "wecom.secret": "sec",
  "wecom.callbackToken": CALLBACK_TOKEN,
  "wecom.encodingAesKey": AES_KEY,
  "wecom.openKfids": "kf1",
};

/** 按企业微信协议加密（与生产解密端独立实现——测的是协议理解是否一致）。 */
function encryptForTest(msg: string, receiveId: string): string {
  const key = Buffer.from(`${AES_KEY}=`, "base64");
  const iv = key.subarray(0, 16); // 官方：IV = AESKey 前 16 字节
  const msgBuf = Buffer.from(msg, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const body = Buffer.concat([
    crypto.randomBytes(16),
    lenBuf,
    msgBuf,
    Buffer.from(receiveId, "utf8"),
  ]);
  const padLen = 32 - (body.length % 32);
  const padded = Buffer.concat([body, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

/** 算回调签名（与企业微信一致）。 */
function sign(timestamp: string, nonce: string, encrypt: string): string {
  return crypto
    .createHash("sha1")
    .update([CALLBACK_TOKEN, timestamp, nonce, encrypt].sort().join(""))
    .digest("hex");
}

/** 回调 URL 的 query 串（GET 验证与 POST 推送共用）。 */
function callbackQuery(encrypt: string): string {
  const timestamp = "1600000000";
  const nonce = "n1";
  return `msg_signature=${sign(timestamp, nonce, encrypt)}&timestamp=${timestamp}&nonce=${nonce}`;
}

afterEach(async () => {
  await cleanupAllTestAccounts();
  vi.unstubAllGlobals();
});

/** Router 实例 + 凭据 + 投递观测。`delivered` 记录每个**被 accept 的** external_userid
 *  ——信源缓冲是私有的，测试要判断「投递真的到了」，只能从入口看（不扒内部状态）。 */
interface RelayRealm extends TestRealm {
  /** 已经进过某账户信源的消息的 external_userid（按到达顺序）。 */
  delivered: string[];
}

/** 造一个装了 Router 的实例 + 写凭据（等价运维用命令行配）。
 *
 *  `factories` 默认给「真 wecom 适配器 + 投递观测」；传 `[]` = 账户里没有任何信源。 */
async function makeRelayRealm(factories?: Array<() => SourceAdapter>): Promise<RelayRealm> {
  const delivered: string[] = [];
  /** 观测用包装：真适配器 + 记下每条被 accept 的客户 id。 */
  const observed: Array<() => SourceAdapter> = factories ?? [
    () => {
      const inner = makeWecomAdapter();
      return {
        ...inner,
        accept(input) {
          const ext = (input.raw as { external_userid?: unknown } | null)?.external_userid;
          if (typeof ext === "string") delivered.push(ext);
          return inner.accept(input);
        },
        register: inner.register.bind(inner),
        stop: inner.stop?.bind(inner),
      };
    },
  ];
  // ⚠️ 生产接入表当前为空（微信已停用）——测试显式注入，不依赖生产注册表：
  // 这些用例测的是「接入实现本身对不对」，与「当前是否启用」是两件事。
  const realm = await makeTestRealm({
    adapters: observed,
    withRouter: true,
    ingressFactories: [({ db, hub, log }) => makeWecomIngress(db, hub, log)],
  });
  for (const [key, value] of Object.entries(CREDENTIALS)) {
    writeRouterSetting(realm.registry, key, value);
  }
  return { ...realm, delivered };
}

/** 在 realm 的 wecom 绑定表里建立一条绑定（D-134：按接入分区）。 */
function bindWecom(realm: TestRealm, code: string, uid: string): void {
  makeBindingStore(realm.registry, "wecom").set(code, uid);
}

/** 假 fetch：gettoken 恒成功；sync_msg 返回给定消息列表；send_msg 计数；
 *  `callbackIps` 给了就回一份回调 IP 清单（开了白名单的用例才需要）。 */
function stubWecomFetch(msgList: unknown[], callbackIps?: string[]): { sent: string[] } {
  const sent: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/cgi-bin/gettoken")) {
        return Promise.resolve(
          new Response(JSON.stringify({ errcode: 0, access_token: "AT", expires_in: 7200 })),
        );
      }
      if (url.includes("/cgi-bin/getcallbackip")) {
        return Promise.resolve(
          new Response(JSON.stringify({ errcode: 0, ip_list: callbackIps ?? [] })),
        );
      }
      if (url.includes("/cgi-bin/kf/send_msg")) {
        sent.push(typeof init?.body === "string" ? init.body : "");
        return Promise.resolve(new Response(JSON.stringify({ errcode: 0, msgid: "x" })));
      }
      // 接管会话：默认会话在「未处理」（0），转「智能助手接待」（1）成功
      if (url.includes("/cgi-bin/kf/service_state/get")) {
        return Promise.resolve(new Response(JSON.stringify({ errcode: 0, service_state: 0 })));
      }
      if (url.includes("/cgi-bin/kf/service_state/trans")) {
        return Promise.resolve(new Response(JSON.stringify({ errcode: 0 })));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ errcode: 0, has_more: 0, msg_list: msgList })),
      );
    }),
  );
  return { sent };
}

/** 等到条件成立（拉取与投递是异步的：回调先 200，之后才真的落库）。
 *  @param check 判定函数
 *  @param what 超时时的说明（写清楚在等什么） */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等超时：${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 推一个 kf_msg_or_event 事件（真实 HTTP 入口）；返回企业微信看到的状态码。
 *  `remoteAddress` 用来模拟回调来源（白名单用例）。 */
async function postEvent(
  realm: TestRealm,
  event = "kf_msg_or_event",
  remoteAddress = "127.0.0.1",
): Promise<number> {
  const xml = `<xml><Event><![CDATA[${event}]]></Event></xml>`;
  const encrypt = encryptForTest(xml, CORP_ID);
  const res = await realm.app.inject({
    method: "POST",
    url: `/relay/wecom/callback?${callbackQuery(encrypt)}`,
    payload: `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`,
    headers: { "content-type": "text/xml" },
    remoteAddress,
  });
  return res.statusCode;
}

describe("Router · 微信回调（真实 HTTP 入口）", () => {
  it("URL 验证：验签 → 解密 → 原样回 echostr 明文", async () => {
    const realm = await makeRelayRealm();
    const echo = encryptForTest("echo-plain-text", CORP_ID);
    const res = await realm.app.inject({
      method: "GET",
      url: `/relay/wecom/callback?${callbackQuery(echo)}&echostr=${encodeURIComponent(echo)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("echo-plain-text");
  });

  it("echostr 含 `+` 且未做 URL 编码（企业微信真实发法）→ 仍能验签通过并原样回明文", async () => {
    // 官方「URL 有效性验证」明确要求接收方做 URL 解码。`echostr` 是 base64，`+` 必然出现；
    // 按表单规则解 query 会把 `+` 变成空格 → 签名对不上 → 验证永远失败（实测过）。
    const realm = await makeRelayRealm();
    // 反复加密直到密文里带 `+`（base64 里很常见）
    let echo = "";
    for (let i = 0; i < 200 && !echo.includes("+"); i += 1) {
      echo = encryptForTest(`echo-plain-${i}`, CORP_ID);
    }
    expect(echo).toContain("+");
    const ts = "1600000000";
    const nonce = "n1";
    const res = await realm.app.inject({
      method: "GET",
      // ⚠️ 刻意**不编码**：企业微信就是这么发的
      url: `/relay/wecom/callback?msg_signature=${sign(ts, nonce, echo)}&timestamp=${ts}&nonce=${nonce}&echostr=${echo}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.startsWith("echo-plain-")).toBe(true); // 解密成功、回的是明文
  });

  it("签名不匹配 → 401（不能让任何人冒充回调）", async () => {
    const realm = await makeRelayRealm();
    const echo = encryptForTest("echo", CORP_ID);
    const res = await realm.app.inject({
      method: "GET",
      url: `/relay/wecom/callback?msg_signature=deadbeef&timestamp=1&nonce=n&echostr=${encodeURIComponent(echo)}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("receiveId 不匹配 → 401（回调不是发给本企业的）", async () => {
    const realm = await makeRelayRealm();
    const echo = encryptForTest("echo", "other-corp");
    const res = await realm.app.inject({
      method: "GET",
      url: `/relay/wecom/callback?${callbackQuery(echo)}&echostr=${encodeURIComponent(echo)}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("未配置 Token/AESKey → 500（配置错误要响亮，不静默）", async () => {
    // 不写凭据；显式注入 wecom 接入（生产表已停用）
    const realm = await makeTestRealm({
      withRouter: true,
      ingressFactories: [({ db, hub, log }) => makeWecomIngress(db, hub, log)],
    });
    const echo = encryptForTest("echo", CORP_ID);
    const res = await realm.app.inject({
      method: "GET",
      url: `/relay/wecom/callback?${callbackQuery(echo)}&echostr=${encodeURIComponent(echo)}`,
    });
    expect(res.statusCode).toBe(500);
  });

  it("kf_msg_or_event 事件 → 200「success」并触发拉取；其它事件 → 不拉取", async () => {
    const realm = await makeRelayRealm();
    const spy = vi.fn((url: string) => {
      if (url.includes("/cgi-bin/gettoken")) {
        return Promise.resolve(
          new Response(JSON.stringify({ errcode: 0, access_token: "AT", expires_in: 7200 })),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ errcode: 0, has_more: 0, msg_list: [] })),
      );
    });
    vi.stubGlobal("fetch", spy);

    expect(await postEvent(realm)).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(spy.mock.calls.some(([u]) => String(u).includes("/cgi-bin/kf/sync_msg"))).toBe(true);

    spy.mockClear();
    expect(await postEvent(realm, "other_event")).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(spy.mock.calls.some(([u]) => String(u).includes("/cgi-bin/kf/sync_msg"))).toBe(false);
  });

  it("回调不是账户令牌路径——`/hook/<令牌>/wecom/*` 上没有任何路由（地址属 Router，不暴露给用户）", async () => {
    const realm = await makeRelayRealm();
    const account = await realm.addAccount();
    const res = await account.inject({
      method: "GET",
      url: account.hookUrl("wecom", "/callback"),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Router · 拉取令牌来自回调事件（不是配置项）", () => {
  it("回调事件里的 <Token> 会被带进 sync_msg 请求体；没有回调时就留空", async () => {
    // 官方：sync_msg 的 `token` 是「回调事件返回的 token 字段，10 分钟内有效」——
    // 它不是运维配置项（v0.7.0 曾误做成 wecom.pullToken 配置，用户照着后台找不到）。
    const realm = await makeRelayRealm();
    const bodies: Array<{ token?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url.includes("/cgi-bin/gettoken")) {
          return Promise.resolve(
            new Response(JSON.stringify({ errcode: 0, access_token: "AT", expires_in: 7200 })),
          );
        }
        if (url.includes("/cgi-bin/kf/sync_msg")) {
          bodies.push(
            typeof init?.body === "string" ? (JSON.parse(init.body) as { token?: string }) : {},
          );
          return Promise.resolve(
            new Response(JSON.stringify({ errcode: 0, has_more: 0, msg_list: [] })),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ errcode: 0, ip_list: [] })));
      }),
    );

    // 轮询定时器 30s 一跳，`start()` 后不会立刻拉；用一次无 <Token> 的回调触发首轮拉取
    await realm.router?.start();
    const plainXml = `<xml><Event><![CDATA[kf_msg_or_event]]></Event></xml>`;
    const plainEnc = encryptForTest(plainXml, CORP_ID);
    await realm.app.inject({
      method: "POST",
      url: `/relay/wecom/callback?${callbackQuery(plainEnc)}`,
      payload: `<xml><Encrypt><![CDATA[${plainEnc}]]></Encrypt></xml>`,
      headers: { "content-type": "text/xml" },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(bodies.length).toBeGreaterThan(0);
    // ① 没经过带 <Token> 的回调 → 不带令牌（官方允许，只是频率限制更严）
    expect(bodies[0]?.token === undefined || bodies[0]?.token === "").toBe(true);

    // ② 推一个带 <Token> 的回调 → 下一次拉取带上它
    bodies.length = 0;
    const xml = `<xml><Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[PT-123]]></Token></xml>`;
    const encrypt = encryptForTest(xml, CORP_ID);
    await realm.app.inject({
      method: "POST",
      url: `/relay/wecom/callback?${callbackQuery(encrypt)}`,
      payload: `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`,
      headers: { "content-type": "text/xml" },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(bodies.some((b) => b.token === "PT-123")).toBe(true);
  });
});

describe("Router · 运行状态对界面可见（L28）", () => {
  it("拉取失败 → GET /api/router 带上 lastError，不必 SSH 翻日志", async () => {
    const realm = await makeRelayRealm();
    const a = await realm.addAccount({ username: "alpha" });
    let syncCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/cgi-bin/gettoken")) {
          return Promise.resolve(
            new Response(JSON.stringify({ errcode: 0, access_token: "AT", expires_in: 7200 })),
          );
        }
        if (url.includes("/getcallbackip")) {
          return Promise.resolve(new Response(JSON.stringify({ errcode: 0, ip_list: [] })));
        }
        // sync_msg 报错（如 open_kfid 填错时的 95000）
        syncCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ errcode: 95000, errmsg: "invalid open_kfid" })),
        );
      }),
    );

    await postEvent(realm);

    // 拉取是异步的：轮询到状态真的变成 error（固定 sleep 不可靠）
    /** 读一次 wecom 那组。 */
    const read = async (): Promise<{
      state?: string;
      lastError?: string;
      lastErrorAt?: string;
    }> => {
      const r = await a.inject({ method: "GET", url: "/api/router" });
      // 响应形状由 shared 契约给定（RouterAccountView）
      const body = r.json<{
        channels: Array<{ kind: string; state?: string; lastError?: string; lastErrorAt?: string }>;
      }>();
      return body.channels.find((c) => c.kind === "wecom") ?? {};
    };
    let snapshot = await read();
    const deadline = Date.now() + 2000;
    while (snapshot.state !== "error" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      snapshot = await read();
    }

    expect(syncCalls).toBeGreaterThan(0); // 先确认拉取真的发生了（否则断言状态是空的因）
    expect(snapshot.state).toBe("error");
    expect(snapshot.lastError).toContain("95000");
    expect(snapshot.lastErrorAt).toBeDefined();
  });
});

describe("Router · 回调来源白名单（D-132）", () => {
  it("白名单就绪后：微信网段内的回调放行，网段外的 403", async () => {
    // 官方 getcallbackip 明确「IP 段会变，建议每天拉」——所以白名单必须从接口取，
    // 且按 CIDR 匹配（官方返回的可能是网段）。
    const realm = await makeRelayRealm();
    stubWecomFetch([], ["203.0.113.0/24"]);
    await realm.router?.stop(); // 让 start 重跑（拉一次 IP）
    await realm.router?.start();

    expect(await postEvent(realm, "kf_msg_or_event", "203.0.113.7")).toBe(200);
    expect(await postEvent(realm, "kf_msg_or_event", "198.51.100.1")).toBe(403);
  });

  it("URL 验证也受白名单约束（不是只有事件推送才查）", async () => {
    const realm = await makeRelayRealm();
    stubWecomFetch([], ["203.0.113.0/24"]);
    await realm.router?.stop();
    await realm.router?.start();

    const echo = encryptForTest("echo-x", CORP_ID);
    const res = await realm.app.inject({
      method: "GET",
      url: `/relay/wecom/callback?${callbackQuery(echo)}&echostr=${encodeURIComponent(echo)}`,
      remoteAddress: "198.51.100.1",
    });
    expect(res.statusCode).toBe(403);
  });

  it("IP 段拉不到 → 放行（白名单是第二道闸，验签仍是主防线；不能静默断流）", async () => {
    const realm = await makeRelayRealm();
    // getcallbackip 直接失败
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/cgi-bin/gettoken")) {
          return Promise.resolve(
            new Response(JSON.stringify({ errcode: 0, access_token: "AT", expires_in: 7200 })),
          );
        }
        if (url.includes("/cgi-bin/getcallbackip")) {
          return Promise.resolve(
            new Response(JSON.stringify({ errcode: 50001, errmsg: "no scope" })),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ errcode: 0, has_more: 0, msg_list: [] })),
        );
      }),
    );
    await realm.router?.stop();
    await realm.router?.start();

    // 界面回 200：链路不该因为白名单拉不到而断
    expect(await postEvent(realm, "kf_msg_or_event", "198.51.100.1")).toBe(200);
  });
});

describe("Router · 一对多投递", () => {
  it("两个客户绑到两个账户 → 各进各的库，零串位", async () => {
    const realm = await makeRelayRealm();
    const a = await realm.addAccount({ username: "alpha" });
    const b = await realm.addAccount({ username: "beta" });
    bindWecom(realm, "cust-A", a.space.uid);
    bindWecom(realm, "cust-B", b.space.uid);
    stubWecomFetch([
      {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "给A的" },
        send_time: "1790000000",
      },
      {
        msgid: "m2",
        open_kfid: "kf1",
        external_userid: "cust-B",
        origin: 3,
        msgtype: "text",
        text: { content: "给B的" },
        send_time: "1790000001",
      },
    ]);

    await postEvent(realm);
    // 投递是异步的（回调先 200）；等两个账户的信源各自收到本客户那条，再强制封批
    await until(
      () => realm.delivered.includes("cust-A") && realm.delivered.includes("cust-B"),
      "两条消息各自到达两个账户",
    );
    await a.space.stop();
    await b.space.stop();

    const aRaws = a.db.$client.prepare("SELECT content FROM raw_inputs").all() as Array<{
      content: string;
    }>;
    const bRaws = b.db.$client.prepare("SELECT content FROM raw_inputs").all() as Array<{
      content: string;
    }>;
    expect(aRaws.map((r) => r.content).join()).toContain("给A的");
    expect(aRaws.map((r) => r.content).join()).not.toContain("给B的");
    expect(bRaws.map((r) => r.content).join()).toContain("给B的");
    expect(bRaws.map((r) => r.content).join()).not.toContain("给A的");
  });

  it("未绑定客户 → 回绑定码（码就是 external_userid 原文），且消息不落任何库", async () => {
    const realm = await makeRelayRealm();
    const a = await realm.addAccount({ username: "alpha" });
    const { sent } = stubWecomFetch([
      {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-X",
        origin: 3,
        msgtype: "text",
        text: { content: "我是谁" },
        send_time: "1790000000",
      },
    ]);

    await postEvent(realm);
    await until(() => sent.length > 0, "未绑定回执发出");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("cust-X"); // 绑定码 = external_userid 原文
    const raws = a.db.$client.prepare("SELECT content FROM raw_inputs").all();
    expect(raws).toHaveLength(0);
  });

  it("已绑定客户收到消息 → 回「信息已收到」", async () => {
    const realm = await makeRelayRealm();
    const a = await realm.addAccount({ username: "alpha" });
    bindWecom(realm, "cust-A", a.space.uid);
    const { sent } = stubWecomFetch([
      {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "你好" },
        send_time: "1790000000",
      },
    ]);

    await postEvent(realm);
    await until(() => sent.length > 0, "回执发出");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("信息已收到");
  });

  it("同一客户连发多条 → 只回一次（回执在 Router 按客户节流）", async () => {
    const realm = await makeRelayRealm();
    const a = await realm.addAccount({ username: "alpha" });
    bindWecom(realm, "cust-A", a.space.uid);
    const { sent } = stubWecomFetch([
      {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "你好" },
        send_time: "1790000000",
      },
      {
        msgid: "m2",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "在吗" },
        send_time: "1790000005",
      },
    ]);

    await postEvent(realm);
    await until(() => sent.length > 0, "回执发出");
    await new Promise((r) => setTimeout(r, 50)); // 再等一会儿：若会重复回，这段时间就该出现

    expect(sent).toHaveLength(1);
  });

  it("回执发送失败**不占**节流窗口：下一条消息还能再试（95018 会话被接手的真实场景）", async () => {
    // 病根（用户实测）：「每次开启对话第一条消息会回来一个 95018，然后再怎么发都不会有反应了」——
    // 节流窗口在发送**之前**就占上了，而 95018（会话已被人工接手）每次必失败，
    // 于是整个窗口内所有回执都被静默吃掉，表现为「发消息毫无反应」。
    const realm = await makeRelayRealm();
    const a = await realm.addAccount({ username: "alpha" });
    bindWecom(realm, "cust-A", a.space.uid);

    const attempts: string[] = [];
    let msgList: unknown[] = [
      {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "第一条" },
        send_time: "1790000000",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/cgi-bin/gettoken")) {
          return Promise.resolve(
            new Response(JSON.stringify({ errcode: 0, access_token: "AT", expires_in: 7200 })),
          );
        }
        if (u.includes("/cgi-bin/getcallbackip")) {
          return Promise.resolve(new Response(JSON.stringify({ errcode: 0, ip_list: [] })));
        }
        if (u.includes("/cgi-bin/kf/send_msg")) {
          attempts.push(typeof init?.body === "string" ? init.body : "");
          // 会话已被人工接手 —— 每次都失败
          return Promise.resolve(
            new Response(JSON.stringify({ errcode: 95018, errmsg: "session status invalid" })),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ errcode: 0, has_more: 0, msg_list: msgList })),
        );
      }),
    );

    await postEvent(realm);
    await until(() => attempts.length > 0, "第一次回执尝试");

    // 同一客户再发一条 → 仍应尝试回执（若被失败的占位挡住，这里就永远是 1）
    msgList = [
      {
        msgid: "m2",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "第二条" },
        send_time: "1790000005",
      },
    ];
    await postEvent(realm);
    await until(() => attempts.length >= 2, "失败后仍会再次尝试回执");

    expect(attempts.length).toBeGreaterThanOrEqual(2);
  });

  it("回执前先接管会话：未处理(0) → 转智能助手接待(1)，再发消息", async () => {
    // 「通过 API 管理客服账号」意味着微信不再帮我们分配会话（官方：接待规则不生效），
    // 新消息会停在「待接入池排队中」——那个状态禁止发消息。所以必须自己接管。
    const realm = await makeRelayRealm();
    const a = await realm.addAccount({ username: "alpha" });
    bindWecom(realm, "cust-A", a.space.uid);

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/cgi-bin/gettoken")) {
          calls.push("gettoken");
          return Promise.resolve(
            new Response(JSON.stringify({ errcode: 0, access_token: "AT", expires_in: 7200 })),
          );
        }
        if (u.includes("/cgi-bin/getcallbackip")) {
          return Promise.resolve(new Response(JSON.stringify({ errcode: 0, ip_list: [] })));
        }
        if (u.includes("/service_state/get")) {
          calls.push("state/get");
          return Promise.resolve(new Response(JSON.stringify({ errcode: 0, service_state: 0 })));
        }
        if (u.includes("/service_state/trans")) {
          const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
          const state =
            typeof body === "object" && body !== null && "service_state" in body
              ? body.service_state
              : "?";
          calls.push(`state/trans:${String(state)}`);
          return Promise.resolve(new Response(JSON.stringify({ errcode: 0 })));
        }
        if (u.includes("/kf/send_msg")) {
          calls.push("send_msg");
          return Promise.resolve(new Response(JSON.stringify({ errcode: 0 })));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              errcode: 0,
              has_more: 0,
              msg_list: [
                {
                  msgid: "m1",
                  open_kfid: "kf1",
                  external_userid: "cust-A",
                  origin: 3,
                  msgtype: "text",
                  text: { content: "你好" },
                  send_time: "1790000000",
                },
              ],
            }),
          ),
        );
      }),
    );

    await postEvent(realm);
    await until(() => calls.includes("send_msg"), "回执发出");

    // 顺序：先查状态 → 再转 1 → 最后发消息
    const transAt = calls.indexOf("state/trans:1");
    const sendAt = calls.indexOf("send_msg");
    expect(calls).toContain("state/get");
    expect(transAt).toBeGreaterThan(-1);
    expect(transAt).toBeLessThan(sendAt);
  });

  it("会话卡在排队(2) → 走 2→3→4 重置，本次不回、不撞 95018", async () => {
    // 用户实测出来的可行链路（2026-10-23）：2 只能转 3，3 才能结束到 4；
    // 2→1 与 2→4 都会报 95016。重置后客户下条消息会重新接入（状态 0），那时才回。
    const realm = await makeRelayRealm();
    const a = await realm.addAccount({ username: "alpha" });
    bindWecom(realm, "cust-A", a.space.uid);

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/cgi-bin/gettoken")) {
          return Promise.resolve(
            new Response(JSON.stringify({ errcode: 0, access_token: "AT", expires_in: 7200 })),
          );
        }
        if (u.includes("/cgi-bin/getcallbackip")) {
          return Promise.resolve(new Response(JSON.stringify({ errcode: 0, ip_list: [] })));
        }
        if (u.includes("/kf/servicer/list")) {
          calls.push("servicer/list");
          return Promise.resolve(
            new Response(
              JSON.stringify({ errcode: 0, servicer_list: [{ userid: "ZhuChenRui", status: 0 }] }),
            ),
          );
        }
        if (u.includes("/service_state/get")) {
          calls.push("state/get");
          return Promise.resolve(new Response(JSON.stringify({ errcode: 0, service_state: 2 })));
        }
        if (u.includes("/service_state/trans")) {
          const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
          const st =
            typeof body === "object" && body !== null && "service_state" in body
              ? String(body.service_state)
              : "?";
          calls.push(`state/trans:${st}`);
          return Promise.resolve(new Response(JSON.stringify({ errcode: 0 })));
        }
        if (u.includes("/kf/send_msg")) {
          calls.push("send_msg");
          return Promise.resolve(new Response(JSON.stringify({ errcode: 0 })));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              errcode: 0,
              has_more: 0,
              msg_list: [
                {
                  msgid: "m1",
                  open_kfid: "kf1",
                  external_userid: "cust-A",
                  origin: 3,
                  msgtype: "text",
                  text: { content: "你好" },
                  send_time: "1790000000",
                },
              ],
            }),
          ),
        );
      }),
    );

    await postEvent(realm);
    await until(() => calls.includes("state/trans:4"), "走到结束会话");

    // 顺序：查状态 → 取接待人员 → 转 3（人工）→ 转 4（结束）
    expect(calls.indexOf("servicer/list")).toBeLessThan(calls.indexOf("state/trans:3"));
    expect(calls.indexOf("state/trans:3")).toBeLessThan(calls.indexOf("state/trans:4"));
    // 本轮**不**发消息（会话刚结束，发也发不出去，避免撞 95018）
    expect(calls).not.toContain("send_msg");
  });

  it("节流设为 0 → 每条都回（不合并）", async () => {
    const realm = await makeRelayRealm();
    const a = await realm.addAccount({ username: "alpha" });
    bindWecom(realm, "cust-A", a.space.uid);
    writeRouterSetting(realm.registry, "wecom.replyThrottleMinutes", "0");

    const { sent } = stubWecomFetch([
      {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "一" },
        send_time: "1790000000",
      },
      {
        msgid: "m2",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "二" },
        send_time: "1790000001",
      },
      {
        msgid: "m3",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "三" },
        send_time: "1790000002",
      },
    ]);

    await postEvent(realm);
    await until(() => sent.length >= 3, "三条各回一次");

    expect(sent).toHaveLength(3);
  });

  it("不同客户各回各的（节流按客户，不是全局）", async () => {
    const realm = await makeRelayRealm();
    const a = await realm.addAccount({ username: "alpha" });
    bindWecom(realm, "cust-A", a.space.uid);
    bindWecom(realm, "cust-B", a.space.uid);
    const { sent } = stubWecomFetch([
      {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "你好" },
        send_time: "1790000000",
      },
      {
        msgid: "m2",
        open_kfid: "kf1",
        external_userid: "cust-B",
        origin: 3,
        msgtype: "text",
        text: { content: "在吗" },
        send_time: "1790000005",
      },
    ]);

    await postEvent(realm);
    await until(() => sent.length >= 2, "两个客户各收到回执");

    expect(sent).toHaveLength(2);
  });

  it("客服自己发的消息不回执（只对客户的消息回）", async () => {
    const realm = await makeRelayRealm();
    const a = await realm.addAccount({ username: "alpha" });
    bindWecom(realm, "cust-A", a.space.uid);
    const { sent } = stubWecomFetch([
      {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 5,
        servicer_userid: "zhangsan",
        msgtype: "text",
        text: { content: "您好，请讲" },
        send_time: "1790000000",
      },
    ]);

    await postEvent(realm);
    await until(() => realm.delivered.includes("cust-A"), "拉取完成");
    await new Promise((r) => setTimeout(r, 50)); // 再等一会儿：客服消息若会回执，这段时间就该出现

    expect(sent).toHaveLength(0);
  });

  it("回执发失败（会话转人工/配额满）不抛、不影响消息入批", async () => {
    const realm = await makeRelayRealm();
    const a = await realm.addAccount({ username: "alpha" });
    bindWecom(realm, "cust-A", a.space.uid);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/cgi-bin/gettoken")) {
          return Promise.resolve(
            new Response(JSON.stringify({ errcode: 0, access_token: "AT", expires_in: 7200 })),
          );
        }
        if (url.includes("/cgi-bin/kf/send_msg")) {
          // 官方：会话被人工接待时发送失败
          return Promise.resolve(
            new Response(JSON.stringify({ errcode: 95001, errmsg: "not allow" })),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              errcode: 0,
              has_more: 0,
              msg_list: [
                {
                  msgid: "m1",
                  open_kfid: "kf1",
                  external_userid: "cust-A",
                  origin: 3,
                  msgtype: "text",
                  text: { content: "你好" },
                  send_time: "1790000000",
                },
              ],
            }),
          ),
        );
      }),
    );

    await postEvent(realm);
    await until(() => realm.delivered.includes("cust-A"), "消息到达账户");
    await a.space.stop();

    const raws = a.db.$client.prepare("SELECT content FROM raw_inputs").all() as Array<{
      content: string;
    }>;
    expect(raws.map((r) => r.content).join()).toContain("你好");
  });

  it("账户已**停用** → 视为未绑定，回码；且消息**不进**停用账户的库", async () => {
    // 停用是管理通道的终态（user:disable）。投递必须查 status——只用 hub.ensure 的话，
    // 停用账户照样被装配、消息写进它的库、还用它的 key 消化（review 逮出的真洞）。
    const realm = await makeRelayRealm();
    const a = await realm.addAccount({ username: "alpha" });
    bindWecom(realm, "cust-Off", a.space.uid);
    setAccountStatus(realm.registry, a.space.uid, "disabled");
    // 先把空间从 hub 里清掉，逼投递走「重新取空间」那条路（否则命中缓存看不出差异）
    await realm.hub.closeAll();

    const { sent } = stubWecomFetch([
      {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-Off",
        origin: 3,
        msgtype: "text",
        text: { content: "还有人吗" },
        send_time: "1790000000",
      },
    ]);

    await postEvent(realm);
    await until(() => sent.length > 0, "回码");

    // ⚠️ 断言回的是**绑定码**而不是「信息已收到」：后者意味着消息真的进了停用账户。
    // 两条文案里都含客户 id，只查 id 抓不住这个洞（实测过）；判据取两者唯一的差别：
    // 未绑定那句带「绑定码是」，已接收那句只有「信息已收到」。
    expect(sent[0]).toContain("绑定码是");
    const raws = a.db.$client.prepare("SELECT content FROM raw_inputs").all();
    expect(raws).toHaveLength(0); // 一个字都没写进停用账户
  });

  it("账户不存在（绑定指向已删号）→ 当作未绑定，回码", async () => {
    const realm = await makeRelayRealm();
    bindWecom(realm, "cust-Ghost", "uid-ghost");
    const { sent } = stubWecomFetch([
      {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-Ghost",
        origin: 3,
        msgtype: "text",
        text: { content: "还有人吗" },
        send_time: "1790000000",
      },
    ]);

    await postEvent(realm);
    await until(() => sent.length > 0, "回执发出");
    await new Promise((r) => setTimeout(r, 50)); // 再等一会儿：若会重复回，这段时间就该出现

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("cust-Ghost");
  });

  it("/api/ingest 借不到部署级取图能力（部署凭据不能由请求体的 source 借走）", async () => {
    // 病根：Router 把自己的取字节能力（握部署 corp secret）塞进账户的媒体表，
    // 而 `/api/ingest` 的 source 是调用方随便填的——合成一张表 = 任何登录用户都能
    // 用部署凭据去取**别人**的 media_id。修法：部署级那张表单独放，`/api/ingest` 只读信源自己声明的。
    const realm = await makeRelayRealm();
    const a = await realm.addAccount({ username: "alpha" });
    bindWecom(realm, "cust-A", a.space.uid);

    // 先让 Router 投递一次（它会在目标账户上装好 relay 那份）
    stubWecomFetch([
      {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "你好" },
        send_time: "1790000000",
      },
    ]);
    await postEvent(realm);
    await until(() => realm.delivered.includes("cust-A"), "投递完成");

    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/cgi-bin/gettoken")) {
          return Promise.resolve(
            new Response(JSON.stringify({ errcode: 0, access_token: "AT", expires_in: 7200 })),
          );
        }
        if (url.includes("/cgi-bin/media/get")) {
          fetched.push(String(url));
          return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ errcode: 0, has_more: 0, msg_list: [] })),
        );
      }),
    );

    // 借部署凭据去取「别人的」media_id
    const res = await a.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        source: "wecom",
        identity: { displayName: "伪造" },
        content: "[图片](wecom-media:SOMEONE-ELSES-MEDIA)",
        eventTime: null,
      },
    });
    expect(res.statusCode).toBe(202); // 进站本身允许（正文占位是合法文本）
    await new Promise((r) => setTimeout(r, 120));

    expect(fetched).toEqual([]); // 关键：**没有**用部署凭据去下载
  });

  it("目标账户没启用这个信源 → 回「暂不可用」，不抛", async () => {
    const realm = await makeRelayRealm([]); // 账户里没有任何信源
    const a = await realm.addAccount({ username: "alpha" });
    bindWecom(realm, "cust-A", a.space.uid);
    const { sent } = stubWecomFetch([
      {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "你好" },
        send_time: "1790000000",
      },
    ]);

    await postEvent(realm);
    await until(() => sent.length > 0, "回执发出");
    await new Promise((r) => setTimeout(r, 50)); // 再等一会儿：若会重复回，这段时间就该出现

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("暂不可用");
  });

  it("一个客户投递失败不影响同批其他客户", async () => {
    const realm = await makeRelayRealm();
    const a = await realm.addAccount({ username: "alpha" });
    bindWecom(realm, "cust-A", a.space.uid);
    // cust-B 绑到不存在的账户
    bindWecom(realm, "cust-B", "uid-ghost");
    stubWecomFetch([
      {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "cust-B",
        origin: 3,
        msgtype: "text",
        text: { content: "先到的" },
        send_time: "1790000000",
      },
      {
        msgid: "m2",
        open_kfid: "kf1",
        external_userid: "cust-A",
        origin: 3,
        msgtype: "text",
        text: { content: "后到的" },
        send_time: "1790000001",
      },
    ]);

    await postEvent(realm);
    await until(() => realm.delivered.includes("cust-A"), "后到的消息到达 A");
    await a.space.stop();

    const raws = a.db.$client.prepare("SELECT content FROM raw_inputs").all() as Array<{
      content: string;
    }>;
    expect(raws.map((r) => r.content).join()).toContain("后到的");
  });
});
