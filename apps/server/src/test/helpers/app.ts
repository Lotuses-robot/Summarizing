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
import { FakeLlm } from "./fakeLlm";

// 测试装配唯一出处（006 R9）：造**真**实例（registry + hub + app）与真账户（真签名 cookie）——
// 断言走真实认证链（受保护作用域 preHandler 逐请求验签+读账户），不设测试后门（宪法 V）。
// 数据全落 mkdtemp 临时目录（每个实例自成一套 system.db + users/）。

const createdDirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

/** 关闭本文件已建的全部测试实例：app.close + 空间 closeAll + **显式关 SQLite 句柄**
 *  （Windows 禁止删除被打开的文件——句柄不关，临时目录清理必挂 EPERM）。幂等（closers 一次性）。 */
export async function closeAllTestAccounts(): Promise<void> {
  for (const close of closers.splice(0)) {
    try {
      await close();
    } catch {
      // 尽力而为：清理阶段不因单个关停失败中断（残留可见于 %TEMP%）
    }
  }
}

/** 清理本文件已建的全部测试实例：**先关句柄、再删临时目录**（逐目录容错——一个失败不拖累其余）。
 *  建议各测试文件挂 `afterEach(cleanupAllTestAccounts)`（async 函数作 hook 会被 vitest 等待）。 */
export async function cleanupAllTestAccounts(): Promise<void> {
  await closeAllTestAccounts();
  for (const dir of createdDirs.splice(0)) {
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

/** 造一个测试实例（见文件头注释）；`adapters` 缺省 = 生产注册表。 */
export async function makeTestRealm(
  args: { adapters?: Array<() => SourceAdapter> } = {},
): Promise<TestRealm> {
  // 空间装配要建真 llm 客户端（缺 env 直接抛）——给占位值；随即被 FakeLlm 换掉，不发网络请求
  process.env.OPENAI_BASE_URL ??= "http://127.0.0.1:9/v1";
  process.env.OPENAI_MODEL ??= "test-model";

  const dir = mkdtempSync(path.join(os.tmpdir(), "summarizing-test-"));
  createdDirs.push(dir);
  const registry = makeRegistryDb(path.join(dir, "system.db"));
  const hub = makeSpaceHub({
    registry,
    dataRoot: dir,
    ...(args.adapters === undefined ? {} : { adapters: args.adapters }),
  });
  const app = makeApp({ registry, hub });
  const secret = getSessionSecret(registry);
  const spaces: Space[] = [];

  closers.push(async () => {
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
        passwordHash: await hashPassword("test-password-123"),
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
  args: { username?: string; llm?: FakeLlm; adapters?: Array<() => SourceAdapter> } = {},
): Promise<TestAccount> {
  const realm = await makeTestRealm(args.adapters === undefined ? {} : { adapters: args.adapters });
  return realm.addAccount({
    ...(args.username === undefined ? {} : { username: args.username }),
    ...(args.llm === undefined ? {} : { llm: args.llm }),
  });
}
