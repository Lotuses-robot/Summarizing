import type { FastifyInstance } from "fastify";
import type { IngestRequest, SettingField } from "@summarizing/shared";

// 信源适配器契约（D-84 立，D-88 重设计）：core 交出「八件套」手段，把变数全部留在信源内
// ——信源自己解释协议、自己打包、自己管设置；core 不感知任何具体源的协议，也**不知道有哪些信源**。
//
// 业界依据（HA / VS Code / Telegraf 横向对比，见 docs/10 §T0）：清理用**注册表**（容多资源、
// 单源内后注册先撤销），错误由 core 在边界兜底（无沙箱），启动钩子可异步可失败而不拖垮其它信源。

/** 信源投递的标准批次：契约同 IngestRequest + 可选 raw 归档（信源原始载荷留底，D-84）。 */
export type SourceBatch = IngestRequest & { raw?: unknown };

/** 信源运行状态（宿主侧，D-88 必备八件⑧）：`reportError`/`startSources` 失败时写入。
 *  前端据它显示「某源最近出错」——信源不需要自己维护状态面板。 */
export interface SourceState {
  state: "ok" | "error";
  lastError?: string;
  lastOkAt?: string;
}

// 设置项声明（SettingField 及其 schema）住在 packages/shared——跨边界契约（D-52 / D-89 上移）：
// 前端按它渲染通用表单。此处 re-export 类型，供信源适配器单一入口引用（`import type { SettingField } from "../types"`）。
export type { SettingField } from "@summarizing/shared";

/** core 交给信源的手段（八件套）。刻意无 db——信源不摸数据库（D-84 低耦合红线）；进站只经 ingest。 */
export interface SourceContext {
  /** 信源名——日志前缀、设置命名空间、错误归属共用。 */
  readonly name: string;
  /** 投递标准批次：core 落档 + 异步消化，与 POST /api/ingest 同一条管线。
   *  **给返回值**——信源要能感知「落地了没」（原 `void` 但实际会抛，D-88 P5）。 */
  ingest(batch: SourceBatch): { ok: true; id: string } | { ok: false; reason: string };
  /** 读写本信源命名空间下的设置（值任意 JSON；core 只序列化存取不解释内容）。
   *  读：未设置或坏 JSON 返回 undefined（调用方兜默认值）。 */
  getSetting(key: string): unknown;
  setSetting(key: string, value: unknown): void;
  /** 日志口——core 统一加 `[source:<name>]` 前缀（替代信源自己写 stderr，便于集中收集/过滤）。 */
  log: {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  /** 清理注册表：定时器/监听器/路由……都登记，core 在关闭时**反向撤销**（容多资源，D-88 必备八件③）。 */
  onCleanup(fn: () => void | Promise<void>): void;
  /** 定时器助手：自动登记进清理表（杜绝泄漏）。core 关闭时统一撤销，无需手动停。 */
  setInterval(fn: () => void, ms: number): void;
  /** 错误出口：无沙箱，信源不该靠抛污染主进程——报错给 core，core 记信源状态（D-88）。 */
  reportError(err: unknown, opts?: { fatal?: boolean }): void;
}

/** 信源适配器：一个源一个模块，注册表加一行（docs/07 接新源检查单）。 */
export interface SourceAdapter {
  /** 源的唯一短名——sourceType、信源设置命名空间、from 排障标记共用。 */
  readonly name: string;
  /** 上岗（装配期，**同步**）：挂路由、起定时器、存引用——不阻塞、不连外部。
   *  清理走 `ctx.onCleanup`（不再返回清理函数，D-88）。core 的 `registerSources` 调用。 */
  register(ctx: SourceContext, app: FastifyInstance): void;
  /** 启动（运行期，**可异步、可失败**，可选）：连外部、拉校验……core 的 `startSources` 在真正
   *  listen 前 await 它；失败只标记本信源 error，不拖垮别的。**不需要异步启动的信源不写**（如 nc）。 */
  start?(): void | Promise<void>;
  /** 停止（运行期，可选）：清自己的运行态（core 也会跑 ctx 的清理注册表）。 */
  stop?(): Promise<void>;
  /** 声明设置项（纯数据）。缺席 = 本信源无设置。core 落库 `__schema__` 并随 `GET /api/sources` 吐给前端。 */
  settings?(): SettingField[];
}
