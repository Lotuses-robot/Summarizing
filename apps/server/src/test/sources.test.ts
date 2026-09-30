import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  gracefulClose,
  makeApp,
  registerSources,
  SHUTDOWN_TIMEOUT_MS,
  START_TIMEOUT_MS,
  startSources,
  type AppDeps,
} from "../app";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";
import type { SourceAdapter, SourceBatch, SourceContext } from "../sources/types";
import { FakeLlm } from "./helpers/fakeLlm";

// 信源底座（D-84/D-88）：SourceContext 手段（ingest 返回值 / 设置 KV / 日志 / 清理）+ 通用设置 HTTP 口。
// 测试替身源挂自己的路由验证「上岗仪式」——core 只交手段与场地，信源自主运转。

/** 测试替身源：emit 路由直投 ctx.ingest；kv 路由读写 ctx 设置（core HTTP 口交叉可见）。 */
function makeTestAdapter(): SourceAdapter & { emitted: SourceBatch[] } {
  const emitted: SourceBatch[] = [];
  const KvParams = z.object({ key: z.string().min(1) });
  return {
    name: "testsrc",
    emitted,
    settings: () => [
      { key: "mode", type: "select", label: "模式", options: ["a", "b"], default: "a" },
      { key: "limit", type: "number", label: "上限", default: 10 },
    ],
    register(ctx, app: FastifyInstance) {
      app.post("/api/sources/testsrc/emit", async (req, reply) => {
        const body = z
          .object({ content: z.string().min(1), eventTime: z.string().nullable().default(null) })
          .parse(req.body);
        const batch: SourceBatch = {
          content: body.content,
          sourceType: "testsrc",
          sourceIdentity: { sourceLabel: "测试源" },
          eventTime: body.eventTime,
        };
        emitted.push(batch);
        ctx.ingest(batch);
        return reply.code(202).send();
      });
      app.put("/api/sources/testsrc/kv/:key", async (req, reply) => {
        const { key } = KvParams.parse(req.params);
        ctx.setSetting(key, req.body);
        return reply.code(204).send();
      });
      app.get("/api/sources/testsrc/kv/:key", async (req) => {
        const { key } = KvParams.parse(req.params);
        return ctx.getSetting(key) ?? null;
      });
      app.post("/api/sources/testsrc/emit-and-report", async (_req, reply) => {
        const result = ctx.ingest({
          content: "看返回值",
          sourceType: "testsrc",
          sourceIdentity: { sourceLabel: "测试源" },
          eventTime: null,
        });
        return reply.code(200).send(result);
      });
    },
  };
}

/** 造一个挂了替身源的 app + 配套内存库。 */
function makeAppWithSource(llm: FakeLlm, source: SourceAdapter) {
  const db = makeDb(":memory:");
  const deps: AppDeps = { db, llmRef: { current: llm } };
  const app = makeApp(deps);
  registerSources(app, deps, [source]);
  return { db, app };
}

describe("信源设置 HTTP 口（core 只存取不解释）", () => {
  it("PUT 单键 → GET 全键值；值是任意 JSON（对象/标量/null 都收）", async () => {
    const { app } = makeAppWithSource(new FakeLlm(), makeTestAdapter());
    // inject 的 payload 类型只收对象/串——标量与 null 用 JSON 串 + json 头投递（等价 curl -d '5'）
    /** 投递原始 JSON 串作为请求体（标量/null 场景）。 */
    const putRaw = (url: string, json: string) =>
      app.inject({
        method: "PUT",
        url,
        payload: json,
        headers: { "content-type": "application/json" },
      });

    await app.inject({
      method: "PUT",
      url: "/api/sources/nc/settings/groups",
      payload: { "123": "英语课官方群" },
    });
    await putRaw("/api/sources/nc/settings/windowMinutes", "5");
    await putRaw("/api/sources/nc/settings/flag", "null");

    const res = await app.inject({ method: "GET", url: "/api/sources/nc/settings" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      groups: { "123": "英语课官方群" },
      windowMinutes: 5,
      flag: null,
    });
  });

  it("未知信源 = 空对象（不 404——空设置是合法状态）", async () => {
    const { app } = makeAppWithSource(new FakeLlm(), makeTestAdapter());
    const res = await app.inject({ method: "GET", url: "/api/sources/ghost/settings" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });

  it("PUT 覆盖旧值（UPSERT）；DELETE 删键；无 body → 400", async () => {
    const { app } = makeAppWithSource(new FakeLlm(), makeTestAdapter());

    await app.inject({ method: "PUT", url: "/api/sources/p/settings/k", payload: { v: "v1" } });
    await app.inject({ method: "PUT", url: "/api/sources/p/settings/k", payload: { v: "v2" } });
    let res = await app.inject({ method: "GET", url: "/api/sources/p/settings" });
    expect(res.json()).toEqual({ k: { v: "v2" } });

    const del = await app.inject({ method: "DELETE", url: "/api/sources/p/settings/k" });
    expect(del.statusCode).toBe(204);
    res = await app.inject({ method: "GET", url: "/api/sources/p/settings" });
    expect(res.json()).toEqual({});

    const bad = await app.inject({ method: "PUT", url: "/api/sources/p/settings/k" });
    expect(bad.statusCode).toBe(400);
  });
});

describe("SourceContext（信源视角）", () => {
  it("ctx.ingest：信源投递走与 HTTP 路由同一条管线（落档 + 异步消化）", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' }); // 消化轮：零变更合法
    const source = makeTestAdapter();
    const { db, app } = makeAppWithSource(llm, source);

    const res = await app.inject({
      method: "POST",
      url: "/api/sources/testsrc/emit",
      payload: { content: "群里说的作业通知", eventTime: null },
    });
    expect(res.statusCode).toBe(202);
    expect(source.emitted).toHaveLength(1);

    // 落档走的是信源自己填的元数据；消化是异步的——轮询等 digested 后再断言
    await vi.waitFor(
      () => {
        expect(repo.listRawInputsByState(db, "digested")).toHaveLength(1);
      },
      { timeout: 3000 },
    );
    const digested = repo.listRawInputsByState(db, "digested");
    const first = digested[0];
    if (!first) throw new Error("信源投递未落档");
    expect(first.sourceType).toBe("testsrc");
    expect(first.sourceIdentity).toEqual({ sourceLabel: "测试源" });
    expect(first.content).toBe("群里说的作业通知");
    // 零变更留痕（与手动源同一消化语义）
    expect(repo.listRawAudit(db, first.id).some((n) => n.detail.includes("零变更"))).toBe(true);
  });

  it("ctx.ingest 给返回值：成功 { ok:true, id }（信源能感知落地）", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' });
    const { db, app } = makeAppWithSource(llm, makeTestAdapter());

    const res = await app.inject({ method: "POST", url: "/api/sources/testsrc/emit-and-report" });
    expect(res.statusCode).toBe(200);
    const body = z.object({ ok: z.literal(true), id: z.string() }).parse(res.json());
    // 返回值里的 id 是真实落档的批次 id（消化可能已完成或失败，故三态合查）
    const all = [
      ...repo.listRawInputsByState(db, "pending"),
      ...repo.listRawInputsByState(db, "digested"),
      ...repo.listRawInputsByState(db, "failed"),
    ];
    expect(all.some((r) => r.id === body.id)).toBe(true);
  });

  it("ctx.setSetting/getSetting：信源自己的路由经 ctx 读写，core HTTP 口交叉可见", async () => {
    const { app } = makeAppWithSource(new FakeLlm(), makeTestAdapter());

    const put = await app.inject({
      method: "PUT",
      url: "/api/sources/testsrc/kv/groups",
      payload: ["456"],
    });
    expect(put.statusCode).toBe(204);

    // 信源视角读回
    const own = await app.inject({ method: "GET", url: "/api/sources/testsrc/kv/groups" });
    expect(own.json()).toEqual(["456"]);

    // core 通用口读到同一份（命名空间 = 适配器名）
    const core = await app.inject({ method: "GET", url: "/api/sources/testsrc/settings" });
    expect(core.json()).toEqual({ groups: ["456"] });
  });

  it("ctx.getSetting：未设置返回 null（信源兜默认值），坏 JSON 不炸只警告", async () => {
    const { db, app } = makeAppWithSource(new FakeLlm(), makeTestAdapter());
    // 直接往库里塞坏值（模拟手改/损坏）
    repo.setSourceSetting(db, "testsrc", "broken", "{不是JSON");

    const own = await app.inject({ method: "GET", url: "/api/sources/testsrc/kv/broken" });
    expect(own.json()).toBeNull();

    const missing = await app.inject({ method: "GET", url: "/api/sources/testsrc/kv/absent" });
    expect(missing.json()).toBeNull();
  });
});

describe("信源设置 schema（D-88 T3：声明 → 落库 → GET /api/sources）", () => {
  it("registerSources 落库 __schema__；GET /api/sources 吐 { name, state, settings }", async () => {
    const { db, app } = makeAppWithSource(new FakeLlm(), makeTestAdapter());

    // schema 已落库（重启不失）
    const stored = repo.getSourceSetting(db, "testsrc", "__schema__");
    expect(stored).not.toBeNull();

    const res = await app.inject({ method: "GET", url: "/api/sources" });
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
    const { app } = makeAppWithSource(new FakeLlm(), makeTestAdapter());
    const res = await app.inject({ method: "GET", url: "/api/sources/testsrc/settings" });
    expect(res.json()).toEqual({}); // 只有 __schema__ 时，设置值为空
  });

  it("__schema__ 坏形（手改/旧版）→ GET /api/sources 里 settings 为空数组，不炸", async () => {
    const { db, app } = makeAppWithSource(new FakeLlm(), makeTestAdapter());
    repo.setSourceSetting(db, "testsrc", "__schema__", "{坏JSON");

    const res = await app.inject({ method: "GET", url: "/api/sources" });
    expect(res.statusCode).toBe(200);
    const list = z
      .array(z.object({ name: z.string(), settings: z.array(z.unknown()) }))
      .parse(res.json());
    expect(list.find((s) => s.name === "testsrc")?.settings).toEqual([]);
  });
});

describe("生命周期隔离（D-88：单源故障不得扩散）", () => {
  it("gracefulClose：stop 抛错不阻断 close——留痕后清理表照跑、整体不 reject", async () => {
    let cleaned = false;
    const bad: SourceAdapter = {
      name: "badstop",
      register(ctx) {
        ctx.onCleanup(() => {
          cleaned = true;
        });
      },
      async stop() {
        throw new Error("stop 炸了");
      },
    };
    const llm = new FakeLlm();
    const db = makeDb(":memory:");
    const deps: AppDeps = { db, llmRef: { current: llm } };
    const app = makeApp(deps);
    registerSources(app, deps, [bad]);

    await expect(gracefulClose(app)).resolves.toBeUndefined(); // close 失败被接住，永不 reject
    expect(cleaned).toBe(true); // stop 炸了之后清理表仍被执行
  });

  it("onClose 逐项隔离：清理表某项抛错 → 剩余清理照跑、close 不 reject", async () => {
    const ran: string[] = [];
    const src: SourceAdapter = {
      name: "badcleanup",
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
    const llm = new FakeLlm();
    const db = makeDb(":memory:");
    const deps: AppDeps = { db, llmRef: { current: llm } };
    const app = makeApp(deps);
    registerSources(app, deps, [src]);

    await expect(gracefulClose(app)).resolves.toBeUndefined(); // 不 reject
    expect(ran).toEqual(["reg3", "reg2", "reg1"]); // 反向撤销，炸的之后照跑
  });

  it("gracefulClose：挂起的 stop（永不 settle）按关停超时兜底，不无限等待", async () => {
    const hanging: SourceAdapter = {
      name: "hangstop",
      register() {},
      stop() {
        return new Promise<void>(() => {}); // 永不 settle（如 SSE 连接关不掉）
      },
    };
    const llm = new FakeLlm();
    const db = makeDb(":memory:");
    const deps: AppDeps = { db, llmRef: { current: llm } };
    const app = makeApp(deps);
    registerSources(app, deps, [hanging]);

    // 关停墙钟用假时钟推进——常量直接 import（单一来源，改常量不必改这里）
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const done = gracefulClose(app);
      vi.advanceTimersByTime(SHUTDOWN_TIMEOUT_MS);
      await expect(done).resolves.toBeUndefined(); // 超时后照常返回（exitAfter 负责退出）
    } finally {
      vi.useRealTimers();
    }
  });

  it("startSources：一个 start 抛错只标该源 error，另一个照常启动、整体 resolve", async () => {
    const llm = new FakeLlm();
    const db = makeDb(":memory:");
    const deps: AppDeps = { db, llmRef: { current: llm } };
    const app = makeApp(deps);
    const bad: SourceAdapter = {
      name: "badstart",
      register() {},
      async start() {
        throw new Error("连不上");
      },
    };
    const good: SourceAdapter = {
      name: "goodstart",
      register() {},
      start() {
        return Promise.resolve();
      },
    };
    registerSources(app, deps, [bad, good]);
    await expect(startSources(app, [bad, good])).resolves.toBeUndefined();
    expect(app.sourceStates.get("badstart")?.state).toBe("error");
    expect(app.sourceStates.get("badstart")?.lastError).toContain("连不上");
    expect(app.sourceStates.get("goodstart")?.state).toBe("ok");
  });

  it("startSources：start 挂起（永不 resolve）按超时判失败，不卡死整体", async () => {
    const llm = new FakeLlm();
    const db = makeDb(":memory:");
    const deps: AppDeps = { db, llmRef: { current: llm } };
    const app = makeApp(deps);
    const hanging: SourceAdapter = {
      name: "hangstart",
      register() {},
      start() {
        return new Promise<void>(() => {}); // 永不 resolve（如无超时 connect）
      },
    };
    registerSources(app, deps, [hanging]);

    // 超时墙钟用假时钟推进——常量直接 import（单一来源，改常量不必改这里）
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const done = startSources(app, [hanging]);
      vi.advanceTimersByTime(START_TIMEOUT_MS);
      await expect(done).resolves.toBeUndefined();
      expect(app.sourceStates.get("hangstart")?.state).toBe("error");
      expect(app.sourceStates.get("hangstart")?.lastError).toContain("超时");
    } finally {
      vi.useRealTimers();
    }
  });

  it("error 状态不粘滞：reportError 后 ingest 成功即恢复 ok（lastError 留供展示）", async () => {
    const llm = new FakeLlm();
    llm.push({ content: '{"changes":[]}' }); // 消化轮
    const db = makeDb(":memory:");
    const deps: AppDeps = { db, llmRef: { current: llm } };
    const app = makeApp(deps);
    // register 时捕获 ctx（reportError 要从信源侧触发）——用对象属性承载，规避 let 的never 收窄
    const holder: { ctx: SourceContext | null } = { ctx: null };
    const flappy: SourceAdapter = {
      name: "flappy",
      register(ctx, app) {
        holder.ctx = ctx;
        app.post("/api/sources/flappy/emit", async (_req, reply) => {
          const result = ctx.ingest({
            content: "恢复测试",
            sourceType: "flappy",
            sourceIdentity: { sourceLabel: "易抖源" },
            eventTime: null,
          });
          return reply.code(200).send(result);
        });
      },
    };
    registerSources(app, deps, [flappy]);
    const flappyCtx = holder.ctx;
    if (flappyCtx === null) throw new Error("register 未执行");

    flappyCtx.reportError(new Error("抖了一下"));
    const res = await app.inject({ method: "POST", url: "/api/sources/flappy/emit" });
    expect(res.statusCode).toBe(200);

    // 断言走真实入口 GET /api/sources（前端同一口），不偷看内部 Map
    const list = await app.inject({ method: "GET", url: "/api/sources" });
    const entry = z
      .object({
        name: z.string(),
        state: z.string(),
        lastError: z.string().optional(),
      })
      .array()
      .parse(list.json())
      .find((s) => s.name === "flappy");
    if (!entry) throw new Error("GET /api/sources 缺 flappy");
    expect(entry.state).toBe("ok"); // ingest 成功翻篇
    expect(entry.lastError).toContain("抖了一下"); // 最近出错仍可查
  });
});

describe("设置声明落库前校验（simplify 轮根修 + 终轮验证 M1）", () => {
  it("坏声明 → 不落库、删陈旧 __schema__、走 reportError（错误不被 startSources 抹掉）", async () => {
    const llm = new FakeLlm();
    const db = makeDb(":memory:");
    const deps: AppDeps = { db, llmRef: { current: llm } };
    const app = makeApp(deps);
    // 先有「上一次的旧声明」落库（模拟改坏之前的正常状态）
    repo.setSourceSetting(
      db,
      "badschema",
      "__schema__",
      JSON.stringify([{ key: "old", type: "record", label: "旧字段" }]),
    );
    const bad: SourceAdapter = {
      name: "badschema",
      register() {},
      // 空键 = 类型合法（string）但 schema 非法（min(1)）——未类型化的 JS 作者会踩的坑
      settings: () => [{ key: "", type: "text", label: "坏键" }],
    };
    registerSources(app, deps, [bad]);

    // 陈旧声明被删（不让旧表单继续供货），新声明不落库
    expect(repo.getSourceSetting(db, "badschema", "__schema__")).toBeNull();
    expect(app.sourceStates.get("badschema")?.state).toBe("error");
    expect(app.sourceStates.get("badschema")?.lastError).toContain("设置声明不合法");

    // startSources：无 start 的信源不得清掉 register 期错误（M1 修正点）
    await startSources(app, [bad]);
    expect(app.sourceStates.get("badschema")?.state).toBe("error");
    expect(app.sourceStates.get("badschema")?.lastError).toContain("设置声明不合法");
  });
});
