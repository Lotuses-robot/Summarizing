import { errText, IngestRequestSchema, SettingFieldSchema } from "@summarizing/shared";
import { withTimeout } from "../shared/timeout";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import { nowWallClock } from "../shared/time";
import { ingestBatch } from "../application/ingest";
import { makeAgentTools, type AgentTools } from "../agent0/tools";
import type { TaggedLlm } from "../shared/llm";
import { SOURCE_SCHEMA_KEY } from "../storage/repo";
import type {
  SourceAdapter,
  SourceBatch,
  SourceContext,
  SourceRouteHandler,
  SourceRouter,
  SourceState,
} from "./types";

// 信源宿主侧（D-88 三时机之②③；006 起**按空间**〔每账户〕各跑一次——原先住 app.ts 的
// 「启动一次」装配迁到这里并按 SpaceDeps 参数化）。makeApp 仍只装 core、不认识信源。

/** start() 的隔离超时：超过即按失败处理（标该信源 error、继续）——不给挂起的 start 拖垮整个空间。
 *  导出给测试 import（推进假时钟用同一来源，杜绝「改常量忘改测试」）。 */
export const START_TIMEOUT_MS = 10_000;

/** webhook 处理器：适配器经 SourceRouter 登记，core 网关按 (源名, method, 相对路径) 分发。 */
export interface WebhookRoute {
  /** 登记它的源（多源同空间时精确分发——两个源都可以有 "/event"）。 */
  source: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** 以 / 开头（如 "/event"）——实际可达 = `/hook/<账户令牌>/<源名><path>`。 */
  path: string;
  handler: SourceRouteHandler;
}

/** 空间侧依赖（装配一个账户的信源所需的一切；db/llmRef 都是**该空间**的）。 */
export interface SpaceDeps {
  db: Db;
  llmRef: { current: TaggedLlm };
  /** 信源状态表（空间私有；GET /api/sources 与 start 失败标记都从它读）。 */
  sourceStates: Map<string, SourceState>;
  /** webhook 处理器表（空间私有；core 网关先按令牌定空间、再按表分发）。 */
  webhookRoutes: WebhookRoute[];
  /** 本账户的图片媒体目录（009：信源图片进站即缓存——QQ 链接小时级过期）。 */
  mediaDir: string;
}

/** webhook 登记口：把适配器的 post/get/put/delete 收进本空间处理器表（附源名——网关按「源名+方法+路径」分发）。
 *  路径在**登记处**校验形状（纯字面段、以 `/` 开头——types.ts 已记录参数段边界）：违规走 `reportError`
 *  响亮落地（与设置声明校验同姿势）——静默收下一个永不匹配的路径 = 线上「这个源收不到消息」而无任何日志。 */
function makeSourceRouter(
  routes: WebhookRoute[],
  source: string,
  reportInvalid: (message: string) => void,
): SourceRouter {
  /** 合法路径：以 / 起始的纯字面段（字母/数字/._-；无参数段/通配）。 */
  const LEGAL_PATH = /^\/[A-Za-z0-9._-]+$/;
  /** 造某方法的登记函数（源名/收集表/报错口在闭包）；违规路径不落表、走 reportInvalid 响亮落地。 */
  const record =
    (method: WebhookRoute["method"]) =>
    (path: string, handler: WebhookRoute["handler"]): void => {
      if (!LEGAL_PATH.test(path)) {
        reportInvalid(`webhook 路径不合法（须为以 / 开头的纯字面段）：${path}`);
        return;
      }
      routes.push({ source, method, path, handler });
    };
  return {
    post: record("POST"),
    get: record("GET"),
    put: record("PUT"),
    delete: record("DELETE"),
  };
}

/** 造一个信源的 ctx（D-88 八件套）：进站走与 HTTP 路由同一条 ingestBatch；设置读写限定本源命名空间；
 *  日志统一前缀；清理/定时器登记进传入的登记表；错误写进本源的 state。
 *  刻意无 db——信源不摸数据库，core 只提供手段。 */
function makeSourceContext(
  deps: SpaceDeps,
  tools: AgentTools,
  name: string,
  cleanups: (() => void | Promise<void>)[],
  state: SourceState,
  declaredActivityKeys: ReadonlySet<string>,
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
          deps.mediaDir,
        );
        // 落地成功即恢复正常（reportError 置的 error 不能粘滞——「最近出错」语义要能翻篇）
        state.state = "ok";
        state.activity["ingest"] = nowWallClock(); // 保留键：成功落库是 core 自己的观测
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
      state.lastErrorAt = nowWallClock();
      process.stderr.write(
        `[source:${name}] reportError${opts?.fatal === true ? "（致命）" : ""}：${reason}\n`,
      );
    },
    markActivity(key: string): void {
      // 只认声明过的键：拼错的 key 不会被悄悄种进状态（下次读不到、也无从排查）——留痕后丢弃
      if (!declaredActivityKeys.has(key)) {
        process.stderr.write(
          `[source:${name}] 打点了未声明的活动信号 "${key}"（先在 activity() 里声明），已忽略\n`,
        );
        return;
      }
      state.activity[key] = nowWallClock();
    },
  };
}

/** 一个空间的信源装配句柄：start 与 stop（stop 在空间关停时调用）。 */
export interface SourceAssembly {
  /** 启动（三时机之③，**可异步**）：逐个 await `start?.()`，失败或**挂起**（超时）只把本信源标 error。 */
  start(): Promise<void>;
  /** 停止：逐信源 stop + 清理表反向撤销（逐项隔离——任一项失败只留痕继续，同原 onClose 语义）。 */
  stop(): Promise<void>;
}

/** 信源上岗（三时机之②，**同步、按空间**）：为每个信源造 ctx（登记其清理表 + 状态）、经 `SourceRouter`
 *  登记 webhook、把声明的 schema 落库 `__schema__`；返回 start/stop 句柄。
 *  重复名跳过（防注册表列重导致定时器/监听器叠加）。状态写进 `deps.sourceStates`（唯一通道）。 */
export function registerSources(deps: SpaceDeps, adapters: SourceAdapter[]): SourceAssembly {
  const tools = makeAgentTools(deps.db, deps.mediaDir);
  const states = deps.sourceStates;
  const stops: Array<() => Promise<void>> = [];
  /** 实际上岗的（适配器, 状态）对——start 只遍历它（simplify：取代「重查 states + 不可达 undefined 分支」，
   *  也顺带不再遍历被去重跳过的适配器）。 */
  const kept: Array<{ adapter: SourceAdapter; state: SourceState }> = [];
  for (const adapter of adapters) {
    if (states.has(adapter.name)) continue; // 防重复（P7）
    const signals = adapter.activity?.() ?? [];
    const declaredKeys = new Set(signals.map((s) => s.key));
    // 保留键 "ingest"：成功落库由 core 打点，重启后从库里恢复（「最近活动」不从零开始）。
    // 其余信号是本次进程运行期的观测——重启重新起算（01§4.19 已写明范围）。
    const restored = declaredKeys.has("ingest")
      ? repo.latestRawAtForSourceType(deps.db, adapter.name)
      : null;
    const state: SourceState = {
      state: "ok",
      activity: restored === null ? {} : { ingest: restored },
      signals,
      ...(adapter.guide === undefined ? {} : { guide: adapter.guide() }),
    };
    const cleanups: (() => void | Promise<void>)[] = [];
    const ctx = makeSourceContext(deps, tools, adapter.name, cleanups, state, declaredKeys);
    adapter.register(
      ctx,
      makeSourceRouter(deps.webhookRoutes, adapter.name, (message) =>
        ctx.reportError(new Error(message)),
      ),
    );
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
    // 单信源的收尾：先 stop（运行态收尾，如强制封批缓冲），再反向跑清理表（单源内后注册先撤销）。
    // ⚠️ 逐项隔离：任一项失败只留痕继续——一个信源收尾炸掉不得跳过自己的剩余清理。
    stops.push(async () => {
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
    kept.push({ adapter, state });
  }
  return {
    async start(): Promise<void> {
      for (const { adapter, state } of kept) {
        try {
          await startWithTimeout(adapter, START_TIMEOUT_MS);
          // 只清「因启动过程产生」的错误；无 start 的信源保持 register 期错误（如坏设置声明）可见
          if (adapter.start === undefined) continue;
          state.state = "ok";
          state.lastError = undefined;
          state.lastErrorAt = undefined;
        } catch (err) {
          const reason = errText(err);
          state.state = "error";
          state.lastError = reason;
          state.lastErrorAt = nowWallClock();
          process.stderr.write(`[source:${adapter.name}] 启动失败：${reason}\n`);
        }
      }
    },
    async stop(): Promise<void> {
      for (const fn of stops) await fn();
    },
  };
}

/** start() 的隔离超时：抛错与**永不 resolve**（如无超时 connect）同判为失败——
 *  否则一个挂起的 start 会让装配卡死，网关永久缺该源的处理器。 */
async function startWithTimeout(adapter: SourceAdapter, ms: number): Promise<void> {
  await withTimeout(
    Promise.resolve(adapter.start?.()),
    ms,
    `start 超时(${ms / 1000}s，按失败隔离)`,
  );
}
