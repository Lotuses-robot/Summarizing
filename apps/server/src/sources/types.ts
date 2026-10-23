import type { FastifyRequest, FastifyReply } from "fastify";
import type { IngestRequest, SettingField } from "@summarizing/shared";

// 信源适配器契约（D-84 立，D-88 重设计）：core 交出「八件套」手段，把变数全部留在信源内
// ——信源自己解释协议、自己打包、自己管设置；core 不感知任何具体源的协议，也**不知道有哪些信源**。
//
// 业界依据（HA / VS Code / Telegraf / Obsidian 横向对比，决策见台账 D-88）：清理用**注册表**（容多资源、
// 单源内后注册先撤销），错误由 core 在边界兜底（无沙箱），启动钩子可异步可失败而不拖垮其它信源。

/** 信源投递的标准批次：契约同 IngestRequest + 可选 raw 归档（信源原始载荷留底，D-84）。 */
export type SourceBatch = IngestRequest & { raw?: unknown };

/** 信源运行状态（宿主侧，D-88 必备八件⑧）：`reportError`/`startSources` 失败时写入。
 *  前端据它显示「某源最近出错」——信源不需要自己维护状态面板。 */
export interface SourceState {
  state: "ok" | "error";
  /** 最近一次错误的人话原因（`state=error` 时显示在设置卡上）。 */
  lastError?: string;
  /** 最近一次出错时刻（北京墙钟）——让「最近出错」能回答「多久以前」。 */
  lastErrorAt?: string;
  /** 活动信号时刻表：key → 北京墙钟。**键与含义由适配器 `activity()` 声明**——
   *  core 只按声明取值与展示，不认识任何具体 key（D-115）。 */
  activity: Record<string, string>;
  /** 该源声明的活动信号（装配期从 `adapter.activity()` 抄一份，`GET /api/sources` 原样吐给前端）。 */
  signals: ActivitySignal[];
  /** 该源声明的接入引导（装配期从 `adapter.guide()` 抄；缺席 = 不显示引导行）。 */
  guide?: string;
}

/** 「最近活动」信号声明（纯数据）：本源会在什么时候更新活动时刻。
 *  - `key`：core 的存储键（适配器自定；保留键 `"ingest"` 由 core 在成功落库时自动打点、
 *    并在重启时从库恢复——写进声明列表才会展示）。
 *  - `label`：给人看的短名（如「收到」「入库」）；卡片按**声明顺序**展示。 */
export interface ActivitySignal {
  key: string;
  label: string;
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
  /** 打点一个活动信号（key 必须是 `activity()` 声明过的键；未声明的 key core 忽略并留痕）。
   *  只记「这个 key 最近一次发生」的时刻——何时算发生，是适配器自己的知识
   *  （nc 在 webhook 命中时打 `"event"`；保留键 `"ingest"` 由 core 在成功落库时自动打）。 */
  markActivity(key: string): void;
}

/** 信源 handler 的请求类型：**无 `space`**（webhook 网关在受保护作用域之外）——读了直接编译错，
 *  防「类型宣称有、运行时没有」的埋伏（评审修复）。 */
type SourceRouteRequest = Omit<FastifyRequest, "space">;

/** 路由处理体：形态对齐 Fastify——可 `return reply.code(204).send()`（返回值作响应载荷）或只调用
 *  reply；网关按原样透传返回值，不解释。 */
export type SourceRouteHandler = (req: SourceRouteRequest, reply: FastifyReply) => unknown;

/** `accept` 的结果：失败带原因（Router 留痕用），不抛异常。
 *  `reason` 是给日志/排障看的一句话，不是给终端用户看的文案。 */
export type AcceptResult = { ok: true } | { ok: false; reason: string };

/** 信源 webhook 登记口（006 收窄，D-96）：只在本源命名空间内登记 HTTP 入口——
 *  **可达地址 = `/hook/<账户令牌>/<源名>/<path>`**（core 网关统一鉴权路由）。
 *  路径为**纯字面段**（不支持 `:param`——需要参数走 query/body；参数段支持等真有源需要再加）。
 *  收窄理由：①Fastify listen 后不能再注册路由 → 运行中新账户必须走网关；②信源不得挂全局路由
 *  （多用户下=鉴权旁路，直接排除）。拉型源（SSE 等出站客户端）不用它——走 `start()`。 */
export interface WebhookRegistrar {
  post(path: string, handler: SourceRouteHandler): void;
  get(path: string, handler: SourceRouteHandler): void;
  put(path: string, handler: SourceRouteHandler): void;
  delete(path: string, handler: SourceRouteHandler): void;
}

/** 信源适配器：一个源一个模块，注册表加一个**工厂**（每空间各造一份实例——私有态天然隔离）。 */
export interface SourceAdapter {
  /** 源的唯一短名——source、信源设置命名空间、from 排障标记共用。 */
  readonly name: string;
  /** 接收一条原始消息（D-130）。**两个调用方**：
   *  · Router（部署级）——一个回调服务多个账户时，由它查明归属后转发；
   *  · 信源自己的 webhook（nc）——地址天然带账户令牌，进来就知道归属。
   *
   *  解协议、算分组键、组装 identity **全部在这里**：Router 不认识协议字段，
   *  它只把 `raw` 原样交过来。`receivedAt` 是到达时刻（拉取型源由 Router 记，
   *  push 型源自己记）——闸门用它，不用消息自带时刻（补推的旧消息会带偏闸门）。
   *
   *  入参 `raw` = 原始消息（形状由本信源自己 zod 解析）；`receivedAt` = 到达时刻（北京墙钟）。
   *  失败**不抛**——Router 据此留痕，抛错会污染 webhook 网关的响应。
   */
  accept(input: { raw: unknown; receivedAt: string }): AcceptResult;
  /** 上岗（装配期，**同步**）：登记 webhook（`registrar`）、起定时器、存引用——不阻塞、不连外部。
   *  ⚠️ 006 起装配按**空间**（每账户）各跑一次。清理走 `ctx.onCleanup`（不再返回清理函数，D-88）。 */
  register(ctx: SourceContext, registrar: WebhookRegistrar): void;
  /** 启动（运行期，**可异步、可失败**，可选）：连外部、拉校验……core 的 `startSources` 在真正
   *  listen 前 await 它；失败只标记本信源 error，不拖垮别的。**不需要异步启动的信源不写**（如 nc）。 */
  start?(): void | Promise<void>;
  /** 停止（运行期，可选）：清自己的运行态（core 也会跑 ctx 的清理注册表）。 */
  stop?(): Promise<void>;
  /** 声明设置项（纯数据）。缺席 = 本信源无设置。core 落库 `__schema__` 并随 `GET /api/sources` 吐给前端。 */
  settings?(): SettingField[];
  /** 取回一个**媒体占位**背后的字节（可选，D-128）。
   *
   *  为什么这属于信源而不属于 core：媒体占位的形状是信源定的，取字节的方式也只有信源知道。
   *  两种现实形态：①公开 URL（QQ 图片）——core 用通用下载器就能取，信源不必声明本方法；
   *  ②**私有凭据才能取**（企业微信的 media_id 要带 access_token）——只有信源自己会换 token。
   *  core 的图片缓存环节遇到「不是 http(s) 的占位」时调它；信源不实现 = 该源的这类占位不缓存
   *  （正文里仍逐字保留占位，不静默改写——01§5.3）。
   *
   *  @param placeholder 占位里的那段（`[图片](X)` 的 X，逐字）
   *  @returns 字节 + 声明的 content-type（可缺）；取不到返回 null（core 留痕后跳过，不重试）
   */
  fetchMedia?(
    placeholder: string,
  ): Promise<{ bytes: Uint8Array; contentType: string | null } | null>;
  /** 接入引导（纯数据，可选）：告诉用户在**本信源自己的**那个系统里怎么把 webhook 指过来
   *  （如 nc 的「网络配置 → HTTP 服务器 → 反向 WebSocket / HTTP 上报」）。缺席 = 不显示引导行。
   *  ⚠️ 这是**源自己的知识**，写在适配器里——core 与前端只做展示，不解析内容（D-115）。 */
  guide?(): string;
  /** 声明「最近活动」信号（纯数据，可选）：本源会在哪些时机更新活动时刻、各叫什么。
   *  只声明 key + 短名，**不声明「这些时刻怎么来的」**——打点由适配器自己调 `ctx.markActivity`，
   *  core 不认识任何具体 key（保留键 `"ingest"` 由 core 在成功落库时自动打点并在重启时从库恢复）。 */
  activity?(): ActivitySignal[];
}
