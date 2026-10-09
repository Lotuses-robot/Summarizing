import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ChatRequestSchema,
  errText,
  IngestRequestSchema,
  SettingFieldSchema,
} from "@summarizing/shared";
import type { Db } from "./storage/db";
import * as repo from "./storage/repo";
import { nowLocalWallClock } from "./shared/time";
import { retryRawInput } from "./agent0/digest";
import { sweepUncertainLibrary } from "./agent0/sweep";
import { makeAgentTools, type AgentTools } from "./agent0/tools";
import { ingestBatch } from "./application/ingest";
import { handleChat } from "./application/chat";
import { buildBoard } from "./application/board";
import { registerItemRoutes } from "./routes/items";
import { registerSourceRoutes, SOURCE_SCHEMA_KEY } from "./routes/sources";
import { registerSettingsRoutes } from "./routes/settings";
import { registerUncertainRoutes } from "./routes/uncertain";
import type { TaggedLlm } from "./shared/llm";
import type { SourceAdapter, SourceBatch, SourceContext, SourceState } from "./sources/types";

// Fastify 实例上的信源状态表（D-88）：makeApp 挂空表、registerSources 填、GET /api/sources 读。
declare module "fastify" {
  interface FastifyInstance {
    sourceStates: Map<string, SourceState>;
  }
}

/** 应用装配的窄依赖——**不含信源**（D-88 三时机分离）：makeApp 只装 core，信源由 registerSources 上岗。 */
export interface AppDeps {
  db: Db;
  /** 可换客户端的委托引用（05§五 热切换）：路由逐请求解构取 llm+modelTag，禁止 makeApp 时缓存——
   *  否则切换后 modelTag 依旧值进 agent0: 署名，审计说谎。 */
  llmRef: { current: TaggedLlm };
}

/** URL 路径里的批次 id 参数（重试口）。与 shared 的 GetItemArgsSchema 分开是刻意的：
 *  那是 get_item 工具的跨边界契约（住 shared），这只是 server 内部 HTTP 细节——schema 住在使用它的边界。 */
const RawIdParamsSchema = z.object({ id: z.string() });

/** start() 的隔离超时：超过即按失败处理（标该信源 error、继续 listen），不给挂起的 start 拖垮整服的机会。
 *  导出给测试 import（推进假时钟用同一来源，杜绝「改常量忘改测试」）。 */
export const START_TIMEOUT_MS = 10_000;

/** 关停超时：close（含各信源 stop 与清理表）挂起时按超时继续走保底退出——
 *  与 start 路径的 START_TIMEOUT_MS 对称：任何一侧挂起都不许拖住 Ctrl-C。 */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** 对话历史查询参数（L16）：limit = 回填多少轮，默认 50、上限 200。 */
const ChatHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** 造一个信源的 ctx（D-88 八件套）：进站走与 HTTP 路由同一条 ingestBatch；设置读写限定本源命名空间；
 *  日志统一前缀；清理/定时器登记进传入的登记表；错误写进本源的 state。
 *  刻意无 db——信源不摸数据库，core 只提供手段。 */
function makeSourceContext(
  deps: AppDeps,
  tools: AgentTools,
  name: string,
  cleanups: (() => void | Promise<void>)[],
  state: SourceState,
): SourceContext {
  /** 统一日志前缀（信源不再自己写 stderr；core 一处收集/过滤）。 */
  const log =
    (level: string) =>
    (msg: string): void => {
      process.stderr.write(`[source:${name}] ${level} ${msg}\n`);
    };
  return {
    name,
    ingest(batch: SourceBatch): { ok: true; id: string } | { ok: false; reason: string } {
      try {
        // 适配器组装的批次在边界过同一份 schema——信源 bug 在此响亮表达（降级可观测），不静默落库
        const parsed = IngestRequestSchema.parse(batch);
        const { raw } = ingestBatch(
          deps.db,
          deps.llmRef,
          tools,
          { ...parsed, raw: batch.raw },
          `source:${name}`,
        );
        // 落地成功即恢复正常（reportError 置的 error 不能粘滞——「最近出错」语义要能翻篇）
        state.state = "ok";
        state.lastOkAt = nowLocalWallClock();
        return { ok: true, id: raw.id };
      } catch (err) {
        // 不抛（D-88）：信源要能感知「落地失败」，自己决定重试/丢弃；抛出去只会污染主进程
        return { ok: false, reason: errText(err) };
      }
    },
    setSetting(key: string, value: unknown): void {
      repo.setSourceSetting(deps.db, name, key, JSON.stringify(value));
    },
    getSetting(key: string): unknown {
      const raw = repo.getSourceSetting(deps.db, name, key);
      if (raw === null) return undefined;
      try {
        const value: unknown = JSON.parse(raw);
        return value;
      } catch {
        process.stderr.write(`[source:${name}] 设置 ${key} 不是合法 JSON，按未设置处理\n`);
        return undefined;
      }
    },
    log: {
      debug: log("debug"),
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
    },
    onCleanup(fn: () => void | Promise<void>): void {
      cleanups.push(fn);
    },
    setInterval(fn: () => void, ms: number): void {
      const timer = setInterval(fn, ms);
      cleanups.push(() => clearInterval(timer));
    },
    reportError(err: unknown, opts?: { fatal?: boolean }): void {
      const reason = errText(err);
      state.state = "error";
      state.lastError = reason;
      process.stderr.write(
        `[source:${name}] reportError${opts?.fatal === true ? "（致命）" : ""}：${reason}\n`,
      );
    },
  };
}

/** 装配 HTTP 应用：ingest（先落盘后异步消化）/ chat（前台）/ board 走此文件；
 *  items / settings / sources 三组资源路由在 routes/（D-73：第二资源组即拆）。
 *  **只装 core**——不含信源（D-88）；信源由 `registerSources` 上岗、`startSources` 启动。 */
export function makeApp(deps: AppDeps) {
  const app = Fastify({ logger: true });
  const tools = makeAgentTools(deps.db);

  // 信源状态表（D-88）：core 装配期先挂空表，registerSources 上岗时填充——GET /api/sources 读它。
  // 挂在 app 上而非模块级，防多实例（测试）串状态。
  const sourceStates = new Map<string, SourceState>();
  app.decorate("sourceStates", sourceStates);

  app.post("/api/ingest", async (req, reply) => {
    const parsed = IngestRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "请求体不合法", issues: parsed.error.issues });
    }
    // 进站装配唯一出处（application/ingest.ts）：先落盘后异步消化
    const { raw, digestState } = ingestBatch(
      deps.db,
      deps.llmRef,
      tools,
      parsed.data,
      "ingest-api",
      (msg) => req.log.error(msg),
    );
    // digestState 来自 kickDigest 的置位结果——不报发射前快照（七轮评审）
    return reply.code(202).send({ id: raw.id, digestState });
  });

  app.get("/api/board", async () => buildBoard(deps.db));

  // 对话历史回填（L16）：持久化的轮次，前端启动时拉回——解「刷新/换设备对话即失」。
  app.get("/api/chat/history", async (req) => {
    const { limit } = ChatHistoryQuerySchema.parse(req.query);
    return { turns: repo.listRecentChatTurns(deps.db, limit) };
  });

  app.post("/api/chat", async (req, reply) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "请求体不合法", issues: parsed.error.issues });
    }
    const client = deps.llmRef.current;
    return handleChat(
      deps.db,
      client,
      client.modelTag,
      parsed.data.message,
      parsed.data.history,
      parsed.data.mentions,
    );
  });

  // 失败批次重试（D-71）：领域函数拥有 failed→pending 跃迁与「仅 failed」前置；
  // 路由只做参数解析与状态码映射（404 不存在 / 409 非 failed / 202 受理）。
  app.post("/api/raw/:id/retry", async (req, reply) => {
    const { id } = RawIdParamsSchema.parse(req.params);
    const client = deps.llmRef.current;
    const result = retryRawInput(deps.db, client, tools, client.modelTag, id);
    if (!result.ok) {
      return result.reason === "not_found"
        ? reply.code(404).send({ error: "批次不存在" })
        : reply.code(409).send({ error: "只有「未处理」批次可以重试" });
    }
    // digestState 来自 kickDigest 的置位结果——不报发射前快照（七轮评审）
    return reply.code(202).send({ id, digestState: result.digestState });
  });

  registerItemRoutes(app, { db: deps.db });
  registerSettingsRoutes(app, { db: deps.db, llmRef: deps.llmRef });
  registerSourceRoutes(app, { db: deps.db, sourceStates });
  registerUncertainRoutes(app, {
    db: deps.db,
    sweep: () =>
      sweepUncertainLibrary(deps.db, deps.llmRef.current, deps.llmRef.current.modelTag, "api"),
  });

  return app;
}

/** 信源上岗（D-88 三时机之②，**同步**）：为每个信源造 ctx（登记其清理表 + 状态）、调一次 `register`
 *  挂路由/定时器，并把 `stop` 与清理表挂到 `onClose`（app.close() 时反向撤销）；有 `settings()` 则
 *  把声明的 schema 落库 `__schema__`（前端经 `GET /api/sources` 拿它渲染通用表单）。
 *  只有 index.ts 调用——makeApp 不认识信源。重复名跳过（防一实例注册两次导致定时器/监听器叠加）。
 *  状态写进 app.sourceStates（唯一通道——GET /api/sources 与 startSources 都从它读）。 */
export function registerSources(
  app: FastifyInstance,
  deps: AppDeps,
  adapters: SourceAdapter[],
): void {
  const tools = makeAgentTools(deps.db);
  const states = app.sourceStates;
  for (const adapter of adapters) {
    if (states.has(adapter.name)) continue; // 防重复（P7）
    const state: SourceState = { state: "ok", lastOkAt: nowLocalWallClock() };
    const cleanups: (() => void | Promise<void>)[] = [];
    const ctx = makeSourceContext(deps, tools, adapter.name, cleanups, state);
    adapter.register(ctx, app);
    if (adapter.settings !== undefined) {
      // 声明在**产生处**校验：坏声明启动即响（走「最近出错」通道可见），
      // 不让它静默穿过到 GET 时才被逐条丢弃（altitude 根修；parseSchema 退化为手改库兜底）
      const parsed = SettingFieldSchema.array().safeParse(adapter.settings());
      if (parsed.success) {
        repo.setSourceSetting(
          deps.db,
          adapter.name,
          SOURCE_SCHEMA_KEY,
          JSON.stringify(parsed.data),
        );
      } else {
        // 坏声明：删陈旧 __schema__（不让上一次的旧表单继续对外供货——评审 M1），并走「最近出错」
        repo.deleteSourceSetting(deps.db, adapter.name, SOURCE_SCHEMA_KEY);
        const first = parsed.error.issues[0];
        ctx.reportError(
          new Error(
            `设置声明不合法，已忽略：${first ? `${first.path.join(".")} ${first.message}` : "未知问题"}`,
          ),
        );
      }
    }
    app.addHook("onClose", async () => {
      // 先 stop（信源的运行态收尾，如强制封批缓冲），再反向跑清理表（单源内后注册先撤销）。
      // ⚠️ 逐项隔离：任一项失败只留痕继续——一个信源收尾炸掉不得跳过自己的剩余清理、
      // 更不得让 close 整体 reject（否则 index 的保底退出之外，其它信源的清理也被跳过）。
      try {
        await adapter.stop?.();
      } catch (err) {
        process.stderr.write(`[source:${adapter.name}] stop 失败（继续清理表）：${errText(err)}\n`);
      }
      for (const fn of [...cleanups].reverse()) {
        try {
          await fn();
        } catch (err) {
          process.stderr.write(`[source:${adapter.name}] 清理失败（继续）：${errText(err)}\n`);
        }
      }
    });
    states.set(adapter.name, state);
  }
}

/** 信源启动（D-88 三时机之③，**可异步**）：逐个 await `start?.()`，失败或**挂起**（超时）只把
 *  本信源标 error，不拖垮其它信源、不影响 listen。只有 index.ts 调用。 */
export async function startSources(app: FastifyInstance, adapters: SourceAdapter[]): Promise<void> {
  const states = app.sourceStates;
  for (const adapter of adapters) {
    try {
      await startWithTimeout(adapter, START_TIMEOUT_MS);
      // 只清「因启动过程产生」的错误；无 start 的信源保持 register 期错误（如坏设置声明）可见
      if (adapter.start === undefined) continue;
      const state = states.get(adapter.name);
      if (state !== undefined) {
        state.state = "ok";
        state.lastError = undefined;
        state.lastOkAt = nowLocalWallClock();
      }
    } catch (err) {
      const reason = errText(err);
      const state = states.get(adapter.name);
      if (state !== undefined) {
        state.state = "error";
        state.lastError = reason;
      }
      process.stderr.write(`[source:${adapter.name}] 启动失败：${reason}\n`);
    }
  }
}

/** start() 的隔离超时：抛错与**永不 resolve**（如无超时 connect）同判为失败——
 *  否则一个挂起的 start 会让 await startSources 卡死，listen 永不执行，整个服务起不来。 */
async function startWithTimeout(adapter: SourceAdapter, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(adapter.start?.()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`start 超时(${ms / 1000}s，按失败隔离)`)), ms);
        timer.unref(); // 进程活着只为等 start——race 结束后它不许拖住退出
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 关停收尾（D-88「SIGINT 归 core」的可测内核）：**永不无限等待、永不 reject**——
 *  close 失败只留痕；挂起（某信源 stop/清理项永不 settle）按 SHUTDOWN_TIMEOUT_MS 判超时。
 *  退出保证由 `exitAfter` 兜底。index.ts 的 SIGINT 处理 = `exitAfter(gracefulClose(app))`。 */
export async function gracefulClose(app: FastifyInstance): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      // close 中途失败时 Fastify 不再跑剩余 onClose hook——留痕可见，但仍要退出（见 exitAfter）
      app
        .close()
        .catch((err) =>
          process.stderr.write(`[shutdown] app.close 失败（尽力退出）：${errText(err)}\n`),
        ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`关停超时(${SHUTDOWN_TIMEOUT_MS / 1000}s，保底退出)`)),
          SHUTDOWN_TIMEOUT_MS,
        );
        timer.unref(); // 进程活着只为等收尾——race 结束后它不许拖住退出
      }),
    ]);
  } catch (err) {
    process.stderr.write(`[shutdown] ${errText(err)}\n`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 保底退出：无论收尾成败，最终都 exit(0)——process.on("SIGINT") 一旦注册就覆盖 Node 默认
 *  「收到即退出」，这里不退出 = Ctrl-C 停不掉进程（评审 C1 的回归守卫就在这条上）。 */
export function exitAfter(p: Promise<void>): Promise<void> {
  return p.finally(() => process.exit(0));
}
