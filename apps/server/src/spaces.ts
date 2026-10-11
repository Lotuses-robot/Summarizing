import path from "node:path";
import { makeDb, type Db } from "./storage/db";
import {
  getAccountByToken,
  getAccountByUid,
  listAccounts,
  type AccountRow,
  type RegistryDb,
} from "./storage/registry";
import { readStoredAi } from "./routes/settings";
import { envFromAiSettings, makeOpenAiLlm, type TaggedLlm } from "./shared/llm";
import { makeAgentTools, type AgentTools } from "./agent0/tools";
import { sweepOrphanPending } from "./agent0/digest";
import { errText } from "@summarizing/shared";
import { registerSources, type WebhookRoute } from "./sources/host";
import { allSourceAdapters } from "./sources/registry";
import type { SourceAdapter, SourceState } from "./sources/types";

// 空间（006 / specs/006 data-model）：每账户一个运行时容器——
// db（data/users/<uid>.db）+ 自己的 llm 引用 + 工具 + 信源实例与其 webhook 处理器表。
// **隔离由构造保证：全仓唯一打开用户库的调用点在本文件**（review 必查——绕过它的开库=事故形态）。

/** 一个账户的运行空间。 */
export interface Space {
  uid: string;
  db: Db;
  /** 本账户的 LLM 引用（由本库设置构建；设置路由热切换它）。 */
  llmRef: { current: TaggedLlm };
  tools: AgentTools;
  sourceStates: Map<string, SourceState>;
  /** 本空间的 webhook 处理器（适配器装配期登记；core 网关按令牌分发到这）。 */
  webhookRoutes: WebhookRoute[];
  /** 关停：各信源 stop + 清理表反向撤销（逐项隔离）。 */
  stop(): Promise<void>;
}

declare module "fastify" {
  interface FastifyRequest {
    /** 受保护作用域的 preHandler 挂上的本请求空间（auth/session.ts 写、路由处理器读）。 */
    space: Space;
  }
}

/** 装配一个账户的空间：开库（含启动清扫）→ 建 llm 引用（本库设置优先，回退 .env）→ 信源上岗并启动。
 *  `factories` 默认取生产注册表；测试注入替身适配器（不改生产路径）。 */
export async function assembleSpace(
  account: AccountRow,
  dataRoot: string,
  factories: Array<() => SourceAdapter> = allSourceAdapters(),
): Promise<Space> {
  const db = makeDb(path.join(dataRoot, "users", `${account.uid}.db`));
  sweepOrphanPending(db); // 上次中断的孤儿 pending 置「未处理」（与原单库启动清扫同语义，L11）

  const llmRef: { current: TaggedLlm } = { current: makeOpenAiLlm() };
  const storedAi = readStoredAi(db);
  if (storedAi !== null) {
    llmRef.current = makeOpenAiLlm(envFromAiSettings(storedAi));
  }

  const sourceStates = new Map<string, SourceState>();
  const webhookRoutes: WebhookRoute[] = [];
  const assembly = registerSources(
    { db, llmRef, sourceStates, webhookRoutes },
    factories.map((make) => make()),
  );
  await assembly.start();

  return {
    uid: account.uid,
    db,
    llmRef,
    tools: makeAgentTools(db),
    sourceStates,
    webhookRoutes,
    stop: () => assembly.stop(),
  };
}

/** 空间集线器：惰性装配（并发去重）+ 令牌索引 + 全量启停。 */
export interface SpaceHub {
  /** 取（必要时装配）uid 的空间——并发首访去重（promise map）。 */
  ensure(uid: string): Promise<Space>;
  /** 按接入令牌定空间（webhook 网关用）：仅 active 账户；无/错/停用 → undefined。 */
  byToken(token: string): Promise<Space | undefined>;
  /** 启动时全量装配：只遍历 **active** 账户（停用不装配——重新启用后首请求懒装配）。 */
  ensureAll(): Promise<void>;
  /** 关停全部空间（信源 stop + 清理表；超时隔离由调用方〔index.ts〕包）。 */
  closeAll(): Promise<void>;
}

/** 造空间集线器（registry 读账户、dataRoot 定位用户库目录；adapters 缺省取生产注册表）。 */
export function makeSpaceHub(args: {
  registry: RegistryDb;
  dataRoot: string;
  adapters?: Array<() => SourceAdapter>;
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
      const space = await assembleSpace(account, args.dataRoot, args.adapters);
      spaces.set(uid, space);
      return space;
    })().finally(() => pending.delete(uid));
    pending.set(uid, p);
    return p;
  }

  return {
    ensure,
    async byToken(token: string): Promise<Space | undefined> {
      const account = getAccountByToken(args.registry, token);
      if (account === undefined || account.status !== "active") return undefined;
      return ensure(account.uid);
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
      for (const space of spaces.values()) {
        try {
          await space.stop();
        } catch (err) {
          process.stderr.write(`[space] ${space.uid} 关停失败（继续）：${errText(err)}\n`);
        }
      }
      spaces.clear();
    },
  };
}

/** 关停全部空间并套超时兜底：挂起按 ms 放弃等待（与 app 的 gracefulClose 对称——任何一侧挂起
 *  都不许拖住 Ctrl-C）。永不 reject：失败/超时只留痕。index.ts 的 SIGINT 处理用它。 */
export async function closeSpacesWithTimeout(hub: SpaceHub, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      hub.closeAll(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`空间关停超时(${ms / 1000}s，保底退出)`)), ms);
        timer.unref(); // 进程活着只为等收尾——race 结束后它不许拖住退出
      }),
    ]);
  } catch (err) {
    process.stderr.write(`[shutdown] ${errText(err)}\n`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
