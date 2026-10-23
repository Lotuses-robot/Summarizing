import path from "node:path";
import { makeDb, type Db } from "./storage/db";
import {
  getAccountByToken,
  getAccountByUid,
  listAccounts,
  type AccountRow,
  type RegistryDb,
} from "./storage/registry";
import { readStoredAi } from "./storage/repo";
import { makeOpenAiLlm, makeUnconfiguredLlm, type TaggedLlm } from "./shared/llm";
import { makeAgentTools, type AgentTools } from "./agent0/tools";
import { makeMediaDir } from "./routes/media";
import { startMediaSweeper } from "./application/media";
import { retryInterruptedOnStartup, sweepOrphanPending } from "./agent0/digest";
import { errText } from "@summarizing/shared";
import { withTimeout } from "./shared/timeout";
import { registerSources, type WebhookRoute } from "./sources/host";
import { allSourceAdapters } from "./sources/registry";
import type { SourceAdapter, SourceState } from "./sources/types";

// 空间（006 / specs/006 data-model）：每账户一个运行时容器——
// db（data/users/<uid>.db）+ 自己的 llm 引用 + 工具 + 信源实例与其 webhook 处理器表。
// **隔离由构造保证：全仓唯一打开用户库的调用点在本文件**（review 必查——绕过它的开库=事故形态）。

/** 一个账户的运行空间。 */
export interface Space {
  uid: string;
  /** 本账户 webhook 接入令牌（网关定向与接入地址拼装用——GET /api/sources 的 hookPath 现填）。 */
  sourceToken: string;
  db: Db;
  /** 本账户的 LLM 引用（由本库设置构建；设置路由热切换它）。 */
  llmRef: { current: TaggedLlm };
  tools: AgentTools;
  sourceStates: Map<string, SourceState>;
  /** 本空间的 webhook 处理器（适配器装配期登记；core 网关按令牌分发到这）。 */
  webhookRoutes: WebhookRoute[];
  /** 本账户的图片媒体目录 `data/media/<uid>/`（009；装配期 mkdir，上传/清理都走它）。 */
  mediaDir: string;
  /** 信源**自己声明**的「媒体占位 → 字节」实现（D-128；键 = 信源名）。
   *  图片缓存按批次的 source 查它——只有「占位不是公开 URL」的信源会登记。
   *  ⚠️ 这张表 `/api/ingest` 也读得到，别往里放部署级的凭据（见 `relayMediaFetchers`）。 */
  mediaFetchers: Map<string, NonNullable<SourceAdapter["fetchMedia"]>>;
  /** **部署级**（Router）注入的「媒体占位 → 字节」实现（D-130；键 = 信源名）。
   *  只给同名信源的 `ctx.ingest` 用——不暴露给 `/api/ingest`（那会把部署凭据借给任何登录用户）。 */
  relayMediaFetchers: Map<string, NonNullable<SourceAdapter["fetchMedia"]>>;
  /** 按名字取本账户已上岗的信源（D-130：Router 投递用）。未启用返回 undefined。 */
  source(name: string): SourceAdapter | undefined;
  /** 关停：各信源 stop + 清理表反向撤销（逐项隔离）。 */
  stop(): Promise<void>;
}

declare module "fastify" {
  interface FastifyRequest {
    /** 受保护作用域的 preHandler 挂上的本请求空间（auth/session.ts 写、路由处理器读）。 */
    space: Space;
  }
}

/** 本库 AI 客户端：**只认本账户自己的设置**（多用户 = 每人自带 key，006 用户走查——不再回退
 *  .env：那会让全站共享一把 key）。未配 / 构造失败 → 未配置占位（服务照常起，用到时明确报未配置）。
 *  构造失败的真因写 stderr（留痕可见——无声吞错会让「尚未配置」这句提示可能不实）。 */
function buildLlm(db: Db): TaggedLlm {
  const stored = readStoredAi(db);
  if (stored === null) return makeUnconfiguredLlm();
  try {
    return makeOpenAiLlm({
      baseUrl: stored.baseUrl,
      model: stored.model,
      ...(stored.apiKey === undefined ? {} : { apiKey: stored.apiKey }),
    });
  } catch (err) {
    process.stderr.write(`[space] AI 客户端构造失败，按未配置处理：${errText(err)}\n`);
    return makeUnconfiguredLlm();
  }
}

/** 装配一个账户的空间：开库（含启动清扫 + 被打断批次的自动重试）→ 建 llm 引用（只认本账户设置）→ 信源上岗并启动。
 *  `factories` 默认取生产注册表；测试注入替身适配器（不改生产路径）。
 *  `makeLlm` 默认从本库设置构建真实客户端；测试注入 FakeLlm（启动自动重试也走它，不连网）。 */
async function assembleSpace(
  account: AccountRow,
  dataRoot: string,
  factories: Array<() => SourceAdapter> = allSourceAdapters(),
  makeLlm: (db: Db) => TaggedLlm = buildLlm,
): Promise<Space> {
  const db = makeDb(path.join(dataRoot, "users", `${account.uid}.db`));
  try {
    // 上次中断的孤儿 pending 置「未处理」（L11）；返回值 = 本次扫出的被打断批次，
    // 装配完成后据此自动重试（D-116）——只认这批，历史 failed 不碰。
    const interrupted = sweepOrphanPending(db);

    const llmRef: { current: TaggedLlm } = { current: makeLlm(db) };

    const sourceStates = new Map<string, SourceState>();
    const webhookRoutes: WebhookRoute[] = [];
    const mediaDir = makeMediaDir(dataRoot, account.uid);
    const tools = makeAgentTools(db, mediaDir);
    /** 信源自带的媒体取字节实现（D-128）——core 的图片缓存按批次的 source 查它。
     *  放在 registerSources 之前建好、由它填充；随 space 一起交出去。 */
    const mediaFetchers = new Map<string, NonNullable<SourceAdapter["fetchMedia"]>>();
    const relayMediaFetchers = new Map<string, NonNullable<SourceAdapter["fetchMedia"]>>();
    const assembly = registerSources(
      { db, llmRef, sourceStates, webhookRoutes, mediaDir, mediaFetchers, relayMediaFetchers },
      factories.map((make) => make()),
    );
    await assembly.start();

    // 过期图片清理器（009）：启动即清一次 + 每小时一次；随空间关停撤掉
    const stopMediaSweep = startMediaSweeper(db, mediaDir);

    // 启动自动重试（D-116）：只重试本次清扫扫出的被打断批次——fire-and-forget，不阻塞启动。
    // 放在装配完成之后：llm/tools/媒体目录都已就绪，重试走的是与手动重试完全相同的管线。
    const client = llmRef.current;
    retryInterruptedOnStartup(db, client, tools, client.modelTag, interrupted, mediaDir, (source) =>
      // 启动重试发生在装配期：Router 还没投递过，`relayMediaFetchers` 通常是空的；
      // 本源自己声明的实现已在 registerSources 里填好，这里查得到就够。
      mediaFetchers.get(source),
    );

    return {
      uid: account.uid,
      sourceToken: account.sourceToken,
      db,
      llmRef,
      tools,
      sourceStates,
      webhookRoutes,
      mediaDir,
      mediaFetchers,
      relayMediaFetchers,
      source: (name: string) => assembly.source(name),
      stop: async () => {
        stopMediaSweep();
        await assembly.stop();
      },
    };
  } catch (err) {
    // 半装机不留句柄（评审修复）：装配失败关库再抛——ensure 的调用方自会重试装配
    try {
      db.$client.close();
    } catch {
      // 已关或未开——忽略
    }
    throw err;
  }
}

/** 空间集线器：惰性装配（并发去重）+ 令牌索引 + 全量启停。 */
export interface SpaceHub {
  /** 数据根目录（system.db 与 users/ 的所在处；公开状态面板只读遍历账户库用）。 */
  readonly dataRoot: string;
  /** 取（必要时装配）uid 的空间——并发首访去重（promise map）。 */
  ensure(uid: string): Promise<Space>;
  /** 按接入令牌定空间（webhook 网关用）：仅 active 账户；无/错/停用 → undefined。 */
  byToken(token: string): Promise<Space | undefined>;
  /** 按 uid 取**可接收**的空间（Router 投递用）：账户不存在或已停用 → undefined。
   *
   *  为什么不复用 `ensure`：`ensure` 只查「账户存在」，停用账户照样会被装配——
   *  那会让已停用的人继续收消息、用他自己的 key 消化（D-130 投递必须查 status）。
   *  为什么不复用 `byToken`：Router 手上没有令牌，只有 uid。 */
  forDelivery(uid: string): Promise<Space | undefined>;
  /** 启动时全量装配：只遍历 **active** 账户（停用不装配——重新启用后首请求懒装配）。 */
  ensureAll(): Promise<void>;
  /** 关停全部空间（信源 stop + 清理表；超时隔离由调用方〔index.ts〕包）。 */
  closeAll(): Promise<void>;
}

/** 造空间集线器（registry 读账户、dataRoot 定位用户库目录；adapters 缺省取生产注册表）。
 *  `makeLlm` 缺省从各账户自己的设置构建；测试注入替身（启动自动重试也用它，不连网）。 */
export function makeSpaceHub(args: {
  registry: RegistryDb;
  dataRoot: string;
  adapters?: Array<() => SourceAdapter>;
  makeLlm?: (db: Db) => TaggedLlm;
}): SpaceHub {
  const spaces = new Map<string, Space>();
  const pending = new Map<string, Promise<Space>>();

  /** 取（必要时装配）uid 的空间——命中缓存直接回；装配中则拼车同一 promise。 */
  async function ensure(uid: string): Promise<Space> {
    const existing = spaces.get(uid);
    if (existing !== undefined) return existing;
    const inflight = pending.get(uid);
    if (inflight !== undefined) return inflight;
    const p = (async (): Promise<Space> => {
      const account = getAccountByUid(args.registry, uid);
      if (account === undefined) throw new Error(`空间装配失败：账户不存在 uid=${uid}`);
      const space = await assembleSpace(account, args.dataRoot, args.adapters, args.makeLlm);
      spaces.set(uid, space);
      return space;
    })().finally(() => pending.delete(uid));
    pending.set(uid, p);
    return p;
  }

  return {
    dataRoot: args.dataRoot,
    ensure,
    async byToken(token: string): Promise<Space | undefined> {
      const account = getAccountByToken(args.registry, token);
      if (account === undefined || account.status !== "active") return undefined;
      return ensure(account.uid);
    },
    async forDelivery(uid: string): Promise<Space | undefined> {
      const account = getAccountByUid(args.registry, uid);
      // 停用的账户 = 不该再往它库里写东西（管理通道的「停用」必须真的停）
      if (account === undefined || account.status !== "active") return undefined;
      return ensure(uid);
    },
    async ensureAll(): Promise<void> {
      for (const account of listAccounts(args.registry)) {
        if (account.status !== "active") continue;
        try {
          await ensure(account.uid);
        } catch (err) {
          // 单账户装配失败不拖垮其余（与信源 start 同款隔离语义）——留痕继续
          process.stderr.write(`[space] 账户 ${account.username} 装配失败：${errText(err)}\n`);
        }
      }
    },
    async closeAll(): Promise<void> {
      // 并行关停（simplify）：串行时一个挂起的 stop 会吃掉整批的 10s 预算、其余空间永久不清理
      const all = [...spaces.values()];
      spaces.clear();
      await Promise.allSettled(
        all.map(async (space) => {
          try {
            await space.stop();
          } catch (err) {
            process.stderr.write(`[space] ${space.uid} 关停失败（继续）：${errText(err)}\n`);
          }
        }),
      );
    },
  };
}

/** 关停全部空间并套超时兜底：挂起按 ms 放弃等待（与 app 的 gracefulClose 对称——任何一侧挂起
 *  都不许拖住 Ctrl-C）。永不 reject：失败/超时只留痕。index.ts 的 SIGINT 处理用它。 */
export async function closeSpacesWithTimeout(hub: SpaceHub, ms: number): Promise<void> {
  try {
    await withTimeout(hub.closeAll(), ms, `空间关停超时(${ms / 1000}s，保底退出)`);
  } catch (err) {
    process.stderr.write(`[shutdown] ${errText(err)}\n`);
  }
}
