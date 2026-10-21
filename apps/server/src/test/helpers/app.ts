import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { errText } from "@summarizing/shared";
import { makeApp } from "../../app";
import { makeSpaceHub, type Space, type SpaceHub } from "../../spaces";
import {
  createAccount,
  getSessionSecret,
  makeRegistryDb,
  type RegistryDb,
} from "../../storage/registry";
import { hashPassword } from "../../auth/password";
import { issueSessionValue, SESSION_COOKIE } from "../../auth/session";
import type { Db } from "../../storage/db";
import type { SourceAdapter } from "../../sources/types";
import type { TaggedLlm } from "../../shared/llm";
import { FakeLlm } from "./fakeLlm";

// 测试装配唯一出处（006 R9）：造**真**实例（registry + hub + app）与真账户（真签名 cookie）——
// 断言走真实认证链（受保护作用域 preHandler 逐请求验签+读账户），不设测试后门（宪法 V）。
// 数据全落 mkdtemp 临时目录（每个实例自成一套 system.db + users/）。

/** 全部测试口令（各账户共用）。 */
const TEST_PASSWORD = "test-password-123";

let testPasswordHash: Promise<string> | null = null;

/** 取（惰性生成并缓存）测试口令哈希——scrypt ~50ms/次 × ~90 个建账户点纯属浪费（simplify/效率）；
 *  账户间共享盐对测试语义无影响（无任何用例断言盐）。 */
function getTestPasswordHash(): Promise<string> {
  testPasswordHash ??= hashPassword(TEST_PASSWORD);
  return testPasswordHash;
}

/** 每实例一条登记：临时目录 + 关停函数（单一清单——取代两份并列登记，免「两处 push 成对」）。 */
const realms: Array<{ dir: string; close: () => Promise<void> }> = [];

/** 清理本文件已建的全部测试实例：**先关全部句柄、再删全部目录**（各逐项容错——一个失败不拖累其余）。
 *  Windows 上句柄不关则删目录必挂 EPERM（SQLite 文件被打开）。建议各测试文件挂 afterEach。 */
export async function cleanupAllTestAccounts(): Promise<void> {
  const all = realms.splice(0);
  for (const { close } of all) {
    try {
      await close();
    } catch {
      // 尽力而为：单个关停失败不中断（残留可见于 %TEMP%）
    }
  }
  for (const { dir } of all) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (err) {
      process.stderr.write(`[test] 临时目录清理失败（残留 ${dir}）：${errText(err)}\n`);
    }
  }
}

/** 一个测试**实例**：app + 系统库 + 空间集线器；可在其中建多个账户（隔离类测试需要同实例多账户）。 */
export interface TestRealm {
  app: FastifyInstance;
  registry: RegistryDb;
  hub: SpaceHub;
  /** 临时数据目录（本实例全部账户共用）。 */
  dataRoot: string;
  /** 在本实例里新建一个已登录账户（默认用户名 tester / tester2 / …）。 */
  addAccount(args?: { username?: string; llm?: FakeLlm }): Promise<TestAccount>;
}

/** 一个测试账户的装配面：空间（含 db、llmRef）/ 会话 cookie / 自带 cookie 的 inject。 */
export interface TestAccount {
  app: FastifyInstance;
  registry: RegistryDb;
  /** 空间集线器（关停路径测试直接调 closeAll 时用）。 */
  hub: SpaceHub;
  /** 本账户空间——注入 FakeLlm 走 `space.llmRef.current = fake`（空间装配已建好）。 */
  space: Space;
  /** 该账户的用户库（断言直用；等价 space.db）。 */
  db: Db;
  /** `sid=<签名值>`——想手动拼 header 时用。 */
  cookie: string;
  /** 本账户的 webhook 接入令牌（拼 `/hook/<token>/<source>/<path>` 用）。 */
  sourceToken: string;
  /** webhook 可达地址构造（网关全路径；测试打信源入口用）。 */
  hookUrl(source: string, path: string): string;
  /** 自动带会话 cookie 的 inject；`opts.headers.cookie` 显式给值时优先（测未登录/坏签名用）。 */
  inject(opts: InjectOptions): Promise<LightMyRequestResponse>;
}

/** 造一个测试实例（见文件头注释）；`adapters` 缺省 = 生产注册表。
 *  `makeLlm` 用于让**空间装配期**就用上替身客户端（启动自动重试发生在装配里，D-116）——
 *  缺省沿用生产路径（按本库设置构建，未配置则为占位客户端）。 */
export async function makeTestRealm(
  args: {
    adapters?: Array<() => SourceAdapter>;
    makeLlm?: (db: Db) => TaggedLlm;
  } = {},
): Promise<TestRealm> {
  // 空间装配缺 env 时走「未配置占位」客户端（buildLlm，不抛）——无需环境修补；
  // 装配后由 addAccount 统一换成 FakeLlm，全程不发网络请求。
  const dir = mkdtempSync(path.join(os.tmpdir(), "summarizing-test-"));
  const registry = makeRegistryDb(path.join(dir, "system.db"));
  const hub = makeSpaceHub({
    registry,
    dataRoot: dir,
    adapters: args.adapters,
    makeLlm: args.makeLlm,
  });
  const app = makeApp({ registry, hub });
  const secret = getSessionSecret(registry);
  const spaces: Space[] = [];

  realms.push({
    dir,
    close: async () => {
      await app.close();
      await hub.closeAll();
      // 显式关 SQLite 句柄（Windows：删被打开的文件 = EPERM；重复 close 由 try 兜住）
      for (const s of spaces) {
        try {
          s.db.$client.close();
        } catch {
          // 已关或未开——忽略
        }
      }
      try {
        registry.$client.close();
      } catch {
        // 同上
      }
    },
  });

  let n = 0;
  return {
    app,
    registry,
    hub,
    dataRoot: dir,
    async addAccount(a = {}): Promise<TestAccount> {
      n += 1;
      const username = a.username ?? (n === 1 ? "tester" : `tester${n}`);
      const account = createAccount(registry, {
        username,
        passwordHash: await getTestPasswordHash(),
      });
      const space = await hub.ensure(account.uid);
      spaces.push(space);
      space.llmRef.current = a.llm ?? new FakeLlm();
      const cookie = `${SESSION_COOKIE}=${issueSessionValue(account.uid, account.tokenVersion, secret)}`;
      return {
        app,
        registry,
        hub,
        space,
        db: space.db,
        cookie,
        sourceToken: account.sourceToken,
        hookUrl: (source: string, p: string): string =>
          `/hook/${account.sourceToken}/${source}${p}`,
        inject: async (opts: InjectOptions): Promise<LightMyRequestResponse> =>
          app.inject({
            ...opts,
            headers: { cookie, ...(opts.headers ?? {}) },
          }),
      };
    },
  };
}

/** 造一个已登录的测试账户（单账户用例的便捷口；底层 = makeTestRealm().addAccount）。 */
export async function makeTestAccount(
  args: {
    username?: string;
    llm?: FakeLlm;
    adapters?: Array<() => SourceAdapter>;
    makeLlm?: (db: Db) => TaggedLlm;
  } = {},
): Promise<TestAccount> {
  const realm = await makeTestRealm({ adapters: args.adapters, makeLlm: args.makeLlm });
  return realm.addAccount(args);
}
