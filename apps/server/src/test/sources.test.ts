import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SHUTDOWN_TIMEOUT_MS } from "../app";
import { registerSources, START_TIMEOUT_MS, type SpaceDeps } from "../sources/host";
import { closeSpacesWithTimeout, type Space, type SpaceHub } from "../spaces";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";
import type { SourceAdapter, SourceBatch, SourceContext, WebhookRegistrar } from "../sources/types";
import { cleanupAllTestAccounts, makeTestAccount } from "./helpers/app";
import { FakeLlm } from "./helpers/fakeLlm";
import { makeMediaDir } from "../routes/media";

// 信源底座（D-84/D-88；006 起按空间装配 + `/hook` 网关）：SourceContext 手段（ingest 返回值 /
// 设置 KV / 日志 / 清理）+ 通用设置 HTTP 口。测试替身源经 **WebhookRegistrar** 登记 webhook——
// core 只交手段与场地（网关内的命名空间），信源自主运转。

afterEach(cleanupAllTestAccounts);

/** makeSpaceDeps 建的临时媒体目录（afterEach 统一删——免得 %TEMP% 攒垃圾）。 */
const srcDirs: string[] = [];
afterEach(() => {
  for (const d of srcDirs) rmSync(d, { recursive: true, force: true });
  srcDirs.length = 0;
});

/** 测试替身源：emit 路由直投 ctx.ingest；kv 路由读写 ctx 设置（core HTTP 口交叉可见）。
 *  006 起路由经 WebhookRegistrar 登记（可达 = /hook/<令牌>/testsrc/...），不再认识 Fastify 实例。 */
function makeTestAdapter(): SourceAdapter & { emitted: SourceBatch[] } {
  const emitted: SourceBatch[] = [];
  const KvQuerySchema = z.object({ key: z.string().min(1) });
  return {
    name: "testsrc",
    emitted,
    accept: () => ({ ok: true }),
    settings: () => [
      { key: "mode", type: "select", label: "模式", options: ["a", "b"], default: "a" },
      { key: "limit", type: "number", label: "上限", default: 10 },
    ],
    register(ctx, router: WebhookRegistrar) {
      router.post("/emit", async (req, reply) => {
        const body = z
          .object({ content: z.string().min(1), eventTime: z.string().nullable().default(null) })
          .parse(req.body);
        const batch: SourceBatch = {
          content: body.content,
          source: "testsrc",
          identity: { displayName: "测试源" },
          eventTime: body.eventTime,
        };
        emitted.push(batch);
        ctx.ingest(batch);
        return reply.code(202).send();
      });
      router.put("/kv", async (req, reply) => {
        const { key } = KvQuerySchema.parse(req.query);
        ctx.setSetting(key, req.body);
        return reply.code(204).send();
      });
      router.get("/kv", async (req) => {
        const { key } = KvQuerySchema.parse(req.query);
        return ctx.getSetting(key) ?? null;
      });
      router.post("/emit-and-report", async (_req, reply) => {
        const result = ctx.ingest({
          content: "看返回值",
          source: "testsrc",
          identity: { displayName: "测试源" },
          eventTime: null,
        });
        return reply.code(200).send(result);
      });
    },
  };
}

/** 空间侧依赖（纯 host 层——不过 HTTP/账户；生命周期类用例用）。 */
function makeSpaceDeps(llm: FakeLlm = new FakeLlm()): SpaceDeps {
  const root = mkdtempSync(path.join(os.tmpdir(), "summarizing-src-"));
  srcDirs.push(root);
  return {
    db: makeDb(":memory:"),
    llmRef: { current: llm },
    sourceStates: new Map(),
    webhookRoutes: [],
    mediaDir: makeMediaDir(root, "u1"),
    mediaFetchers: new Map(),
    relayMediaFetchers: new Map(),
  };
}

describe("信源设置 HTTP 口（core 只存取不解释）", () => {
  it("PUT 单键 → GET 全键值；值是任意 JSON（对象/标量/null 都收）", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm(), adapters: [makeTestAdapter] });
    // inject 的 payload 类型只收对象/串——标量与 null 用 JSON 串 + json 头投递（等价 curl -d '5'）
    /** 投递原始 JSON 串作为请求体（标量/null 场景）。 */
    const putRaw = (url: string, json: string) =>
      t.inject({
        method: "PUT",
        url,
        payload: json,
        headers: { "content-type": "application/json" },
      });

    await t.inject({
      method: "PUT",
      url: "/api/sources/nc/settings/groups",
      payload: { "123": "英语课官方群" },
    });
    await putRaw("/api/sources/nc/settings/windowMinutes", "5");
    await putRaw("/api/sources/nc/settings/flag", "null");

    const res = await t.inject({ method: "GET", url: "/api/sources/nc/settings" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      groups: { "123": "英语课官方群" },
      windowMinutes: 5,
      flag: null,
    });
  });

  it("未知信源 = 空对象（不 404——空设置是合法状态）", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm(), adapters: [makeTestAdapter] });
    const res = await t.inject({ method: "GET", url: "/api/sources/ghost/settings" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });

  it("PUT 覆盖旧值（UPSERT）；DELETE 删键；无 body → 400", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm(), adapters: [makeTestAdapter] });

    await t.inject({ method: "PUT", url: "/api/sources/p/settings/k", payload: { v: "v1" } });
    await t.inject({ method: "PUT", url: "/api/sources/p/settings/k", payload: { v: "v2" } });
    let res = await t.inject({ method: "GET", url: "/api/sources/p/settings" });
    expect(res.json()).toEqual({ k: { v: "v2" } });

    const del = await t.inject({ method: "DELETE", url: "/api/sources/p/settings/k" });
    expect(del.statusCode).toBe(204);
    res = await t.inject({ method: "GET", url: "/api/sources/p/settings" });
    expect(res.json()).toEqual({});

    const bad = await t.inject({ method: "PUT", url: "/api/sources/p/settings/k" });
    expect(bad.statusCode).toBe(400);
  });
});

describe("SourceContext（信源视角，webhook 经网关）", () => {
  it("ctx.ingest：信源投递走与 HTTP 路由同一条管线（落档 + 异步消化）", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' }); // 消化轮：零变更合法
    const source = makeTestAdapter();
    const t = await makeTestAccount({ llm, adapters: [() => source] });

    const res = await t.app.inject({
      method: "POST",
      url: t.hookUrl("testsrc", "/emit"),
      payload: { content: "群里说的作业通知", eventTime: null },
    });
    expect(res.statusCode).toBe(202);
    expect(source.emitted).toHaveLength(1);

    // 落档走的是信源自己填的元数据；消化是异步的——轮询等 digested 后再断言
    await vi.waitFor(
      () => {
        expect(repo.listRawInputsByState(t.db, "digested")).toHaveLength(1);
      },
      { timeout: 3000 },
    );
    const digested = repo.listRawInputsByState(t.db, "digested");
    const first = digested[0];
    if (!first) throw new Error("信源投递未落档");
    expect(first.source).toBe("testsrc");
    expect(first.identity).toEqual({ displayName: "测试源" });
    expect(first.content).toBe("群里说的作业通知");
    // 零变更留痕（与手动源同一消化语义）
    expect(repo.listPipelineEvents(t.db, first.id).some((n) => n.detail.includes("零变更"))).toBe(
      true,
    );
  });

  it("ctx.ingest 给返回值：成功 { ok:true, id }（信源能感知落地）", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    const t = await makeTestAccount({ llm, adapters: [makeTestAdapter] });

    const res = await t.app.inject({
      method: "POST",
      url: t.hookUrl("testsrc", "/emit-and-report"),
    });
    expect(res.statusCode).toBe(200);
    const body = z.object({ ok: z.literal(true), id: z.string() }).parse(res.json());
    // 返回值里的 id 是真实落档的批次 id（消化可能已完成或失败，故四态合查）
    const all = [
      ...repo.listRawInputsByState(t.db, "pending"),
      ...repo.listRawInputsByState(t.db, "digesting"),
      ...repo.listRawInputsByState(t.db, "digested"),
      ...repo.listRawInputsByState(t.db, "failed"),
    ];
    expect(all.some((r) => r.id === body.id)).toBe(true);
  });

  it("ctx.setSetting/getSetting：信源自己的路由经 ctx 读写，core HTTP 口交叉可见", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm(), adapters: [makeTestAdapter] });

    const put = await t.app.inject({
      method: "PUT",
      url: t.hookUrl("testsrc", "/kv?key=groups"),
      payload: ["456"],
    });
    expect(put.statusCode).toBe(204);

    // 信源视角读回
    const own = await t.app.inject({ method: "GET", url: t.hookUrl("testsrc", "/kv?key=groups") });
    expect(own.json()).toEqual(["456"]);

    // core 通用口读到同一份（命名空间 = 适配器名）
    const core = await t.inject({ method: "GET", url: "/api/sources/testsrc/settings" });
    expect(core.json()).toEqual({ groups: ["456"] });
  });

  it("ctx.getSetting：未设置返回 null（信源兜默认值），坏 JSON 不炸只警告", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm(), adapters: [makeTestAdapter] });
    // 直接往库里塞坏值（模拟手改/损坏）
    repo.setSourceSetting(t.db, "testsrc", "broken", "{不是JSON");

    const own = await t.app.inject({ method: "GET", url: t.hookUrl("testsrc", "/kv?key=broken") });
    expect(own.json()).toBeNull();

    const missing = await t.app.inject({
      method: "GET",
      url: t.hookUrl("testsrc", "/kv?key=absent"),
    });
    expect(missing.json()).toBeNull();
  });
});

describe("信源设置 schema（D-88 T3：声明 → 落库 → GET /api/sources）", () => {
  it("registerSources 落库 __schema__；GET /api/sources 吐 { name, state, settings }", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm(), adapters: [makeTestAdapter] });

    // schema 已落库（重启不失）
    const stored = repo.getSourceSetting(t.db, "testsrc", "__schema__");
    expect(stored).not.toBeNull();

    const res = await t.inject({ method: "GET", url: "/api/sources" });
    expect(res.statusCode).toBe(200);
    const list = z
      .array(z.object({ name: z.string(), state: z.string(), settings: z.array(z.unknown()) }))
      .parse(res.json());
    expect(list).toHaveLength(1);
    const first = list[0];
    if (!first) throw new Error("列表为空");
    expect(first.name).toBe("testsrc");
    expect(first.state).toBe("ok");
    expect(first.settings).toEqual([
      { key: "mode", type: "select", label: "模式", options: ["a", "b"], default: "a" },
      { key: "limit", type: "number", label: "上限", default: 10 },
    ]);
  });

  it("设置的读口不吐 __schema__（schema 不是设置值）", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm(), adapters: [makeTestAdapter] });
    const res = await t.inject({ method: "GET", url: "/api/sources/testsrc/settings" });
    expect(res.json()).toEqual({}); // 只有 __schema__ 时，设置值为空
  });

  it("__schema__ 坏形（手改/旧版）→ GET /api/sources 里 settings 为空数组，不炸", async () => {
    const t = await makeTestAccount({ llm: new FakeLlm(), adapters: [makeTestAdapter] });
    repo.setSourceSetting(t.db, "testsrc", "__schema__", "{坏JSON");

    const res = await t.inject({ method: "GET", url: "/api/sources" });
    expect(res.statusCode).toBe(200);
    const list = z
      .array(z.object({ name: z.string(), settings: z.array(z.unknown()) }))
      .parse(res.json());
    expect(list.find((s) => s.name === "testsrc")?.settings).toEqual([]);
  });
});

describe("生命周期隔离（D-88：单源故障不得扩散；006 起按空间/host 层）", () => {
  it("stop 抛错不阻断收尾——留痕后清理表照跑、整体不 reject", async () => {
    let cleaned = false;
    const bad: SourceAdapter = {
      name: "badstop",
      accept: () => ({ ok: true }),
      register(ctx) {
        ctx.onCleanup(() => {
          cleaned = true;
        });
      },
      async stop() {
        throw new Error("stop 炸了");
      },
    };
    const asm = registerSources(makeSpaceDeps(), [bad]);

    await expect(asm.stop()).resolves.toBeUndefined(); // stop 失败被接住，永不 reject
    expect(cleaned).toBe(true); // stop 炸了之后清理表仍被执行
  });

  it("清理表逐项隔离：某项抛错 → 剩余清理照跑、整体不 reject", async () => {
    const ran: string[] = [];
    const src: SourceAdapter = {
      name: "badcleanup",
      accept: () => ({ ok: true }),
      register(ctx) {
        ctx.onCleanup(() => {
          ran.push("reg1");
        });
        ctx.onCleanup(() => {
          ran.push("reg2");
          throw new Error("清理炸了"); // 挂在中间——证明它后面的 reg1 照跑
        });
        ctx.onCleanup(() => {
          ran.push("reg3");
        });
      },
    };
    const asm = registerSources(makeSpaceDeps(), [src]);

    await expect(asm.stop()).resolves.toBeUndefined(); // 不 reject
    expect(ran).toEqual(["reg3", "reg2", "reg1"]); // 反向撤销，炸的之后照跑
  });

  it("关停超时兜底：挂起的空间 closeAll（永不 settle）按超时放弃等待，不无限等待", async () => {
    const hangingHub: SpaceHub = {
      dataRoot: os.tmpdir(),
      ensure: () => new Promise<Space>(() => {}),
      byToken: () => new Promise<Space | undefined>(() => {}),
      forDelivery: () => new Promise<Space | undefined>(() => {}),
      ensureAll: async () => {},
      closeAll: () => new Promise<void>(() => {}), // 永不 settle（如某信源 stop 关不掉）
    };
    // 关停墙钟用假时钟推进——常量直接 import（单一来源，改常量不必改这里）
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const done = closeSpacesWithTimeout(hangingHub, SHUTDOWN_TIMEOUT_MS);
      vi.advanceTimersByTime(SHUTDOWN_TIMEOUT_MS);
      await expect(done).resolves.toBeUndefined(); // 超时后照常返回（exitAfter 负责退出）
    } finally {
      vi.useRealTimers();
    }
  });

  it("空间启动：一个 start 抛错只标该源 error，另一个照常启动、整体 resolve", async () => {
    const deps = makeSpaceDeps();
    const bad: SourceAdapter = {
      name: "badstart",
      accept: () => ({ ok: true }),
      register() {},
      async start() {
        throw new Error("连不上");
      },
    };
    const good: SourceAdapter = {
      name: "goodstart",
      accept: () => ({ ok: true }),
      register() {},
      start() {
        return Promise.resolve();
      },
    };
    const asm = registerSources(deps, [bad, good]);
    await expect(asm.start()).resolves.toBeUndefined();
    expect(deps.sourceStates.get("badstart")?.state).toBe("error");
    expect(deps.sourceStates.get("badstart")?.lastError).toContain("连不上");
    expect(deps.sourceStates.get("goodstart")?.state).toBe("ok");
  });

  it("空间启动：start 挂起（永不 resolve）按超时判失败，不卡死整体", async () => {
    const deps = makeSpaceDeps();
    const hanging: SourceAdapter = {
      name: "hangstart",
      accept: () => ({ ok: true }),
      register() {},
      start() {
        return new Promise<void>(() => {}); // 永不 resolve（如无超时 connect）
      },
    };
    const asm = registerSources(deps, [hanging]);

    // 超时墙钟用假时钟推进——常量直接 import（单一来源，改常量不必改这里）
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const done = asm.start();
      vi.advanceTimersByTime(START_TIMEOUT_MS);
      await expect(done).resolves.toBeUndefined();
      expect(deps.sourceStates.get("hangstart")?.state).toBe("error");
      expect(deps.sourceStates.get("hangstart")?.lastError).toContain("超时");
    } finally {
      vi.useRealTimers();
    }
  });

  it("error 状态不粘滞：reportError 后 ingest 成功即恢复 ok（lastError 留供展示）", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' }); // 消化轮
    // register 时捕获 ctx（reportError 要从信源侧触发）——用对象属性承载，规避 let 的 never 收窄
    const holder: { ctx: SourceContext | null } = { ctx: null };
    const flappy: SourceAdapter = {
      name: "flappy",
      accept: () => ({ ok: true }),
      activity: () => [
        { key: "event", label: "收到" },
        { key: "ingest", label: "入库" },
      ],
      register(ctx, router) {
        holder.ctx = ctx;
        router.post("/emit", async (_req, reply) => {
          ctx.markActivity("event"); // 适配器自己的观测口径（core 不再替它猜）
          const result = ctx.ingest({
            content: "恢复测试",
            source: "flappy",
            identity: { displayName: "易抖源" },
            eventTime: null,
          });
          return reply.code(200).send(result);
        });
      },
    };
    const t = await makeTestAccount({ llm, adapters: [() => flappy] });
    const flappyCtx = holder.ctx;
    if (flappyCtx === null) throw new Error("register 未执行");

    flappyCtx.reportError(new Error("抖了一下"));
    const res = await t.app.inject({ method: "POST", url: t.hookUrl("flappy", "/emit") });
    expect(res.statusCode).toBe(200);

    // 断言走真实入口 GET /api/sources（前端同一口），不偷看内部 Map
    const list = await t.inject({ method: "GET", url: "/api/sources" });
    const entry = z
      .object({
        name: z.string(),
        state: z.string(),
        lastError: z.string().optional(),
        lastErrorAt: z.string().optional(),
        activity: z.array(z.object({ label: z.string(), at: z.string().optional() })),
      })
      .array()
      .parse(list.json())
      .find((s) => s.name === "flappy");
    if (!entry) throw new Error("GET /api/sources 缺 flappy");
    expect(entry.state).toBe("ok"); // ingest 成功翻篇
    expect(entry.lastError).toContain("抖了一下"); // 最近出错仍可查
    // 「最近活动」（2026-10-21）：信号由适配器声明、顺序即声明顺序；两个时刻都已打点
    expect(entry.activity.map((a) => a.label)).toEqual(["收到", "入库"]);
    expect(entry.activity.every((a) => a.at !== undefined)).toBe(true);
    expect(entry.lastErrorAt).toBeDefined();
  });
});

describe("设置声明落库前校验（simplify 轮根修 + 终轮验证 M1）", () => {
  it("坏声明 → 不落库、删陈旧 __schema__、走 reportError（错误不被启动清理抹掉）", async () => {
    const deps = makeSpaceDeps();
    // 先有「上一次的旧声明」落库（模拟改坏之前的正常状态）
    repo.setSourceSetting(
      deps.db,
      "badschema",
      "__schema__",
      JSON.stringify([{ key: "old", type: "record", label: "旧字段" }]),
    );
    const bad: SourceAdapter = {
      name: "badschema",
      accept: () => ({ ok: true }),
      register() {},
      // 空键 = 类型合法（string）但 schema 非法（min(1)）——未类型化的 JS 作者会踩的坑
      settings: () => [{ key: "", type: "text", label: "坏键" }],
    };
    const asm = registerSources(deps, [bad]);

    // 陈旧声明被删（不让旧表单继续供货），新声明不落库
    expect(repo.getSourceSetting(deps.db, "badschema", "__schema__")).toBeNull();
    expect(deps.sourceStates.get("badschema")?.state).toBe("error");
    expect(deps.sourceStates.get("badschema")?.lastError).toContain("设置声明不合法");

    // 启动：无 start 的信源不得清掉 register 期错误（M1 修正点）
    await asm.start();
    expect(deps.sourceStates.get("badschema")?.state).toBe("error");
    expect(deps.sourceStates.get("badschema")?.lastError).toContain("设置声明不合法");
  });
});
