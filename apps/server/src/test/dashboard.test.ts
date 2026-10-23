import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { DashboardSnapshotSchema } from "@summarizing/shared";
import { cleanupAllTestAccounts, makeTestRealm } from "./helpers/app";
import { executeChanges } from "../executor/executor";
import { readUserDbStats } from "../storage/stats";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";
import { setAccountStatus } from "../storage/registry";
import { nowWallClock } from "../shared/time";

// 公开状态面板（011）：公开可读、白名单、聚合正确、只读不改库、降级与排行。
// 断言一律走真实入口（inject）——不偷看内部对象；唯一直接读库的场景是「没有写库」的证明。

afterEach(cleanupAllTestAccounts);

/** 仓库根（CHANGELOG 在根，cwd 会随 `npm -w` / 直接跑文件而变——按本文件位置推出，与 cwd 无关）。 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** 「今天」的北京墙钟戳：夹具用它造今日批次——写死日期会随日历日流逝过期（2026-10-22 事故）。 */
const today = (): string => nowWallClock();

/** 临时目录（脏形状用例造库文件用；afterEach 清）。 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  dirs.length = 0;
});

/** 造一个空临时目录。 */
function tmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "summarizing-dashboard-"));
  dirs.push(d);
  return d;
}

/** 造一条原始批次（时间可指定；缺省 = 现在——「今天」的用例不会随日历日流逝过期）。 */
function seedRaw(db: ReturnType<typeof makeDb>, content: string, receivedAt?: string) {
  return repo.insertRawInput(db, {
    content,
    source: "paste",
    identity: { displayName: "s" },
    receivedAt: receivedAt ?? today(),
    eventTime: null,
  });
}

/** 经真实执行器造事项（与 board.test 同一路径）。 */
function createItem(
  db: ReturnType<typeof makeDb>,
  raw: ReturnType<typeof seedRaw>,
  args: { name: string; kind?: "task" | "notice"; status?: "todo" | "done" | "trashed" },
): string {
  executeChanges(
    db,
    raw,
    [
      {
        action: "create_item",
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        elements: [{ label: "name", text: args.name, quotes: [] }],
        tags: [],
        doubtNote: null,
      },
    ],
    { actor: "agent0", model: "test" },
  );
  const found = repo.deriveItems(db).find((i) => i.elements.some((e) => e.text === args.name));
  if (!found) throw new Error("事项未创建");
  if (args.status !== undefined && args.status !== "todo") {
    repo.appendItemVersion(db, {
      itemId: found.id,
      action: args.status === "trashed" ? "trash_item" : "complete_item",
      detail: "夹具",
      snapshot: { ...found, status: args.status },
      by: { actor: "agent0", model: "test" },
    });
  }
  return found.id;
}

/** 落一行 token 用量（时间 = 现在，保证落在「今日」）。 */
function seedUsage(
  db: ReturnType<typeof makeDb>,
  prompt: number,
  completion: number,
  cached: number | null,
): void {
  repo.insertLlmUsage(db, {
    actor: "agent0",
    model: "test",
    promptTokens: prompt,
    completionTokens: completion,
    cachedTokens: cached,
  });
}

/** 取快照（公开面，不登录取）；解析成 schema 类型——白名单断言在 parse 边界。 */
async function getSnapshot(app: FastifyInstance) {
  const res = await app.inject({ method: "GET", url: "/api/dashboard" });
  expect(res.statusCode).toBe(200);
  return DashboardSnapshotSchema.parse(res.json());
}

describe("公开可读与白名单（US1/US3）", () => {
  it("未登录（无 cookie）GET /api/dashboard → 200，键集合与 schema 完全一致", async () => {
    const realm = await makeTestRealm();
    await realm.addAccount({ username: "alice" });
    const res = await realm.app.inject({ method: "GET", url: "/api/dashboard" });
    expect(res.statusCode).toBe(200);
    const snap = DashboardSnapshotSchema.parse(res.json());
    // 顶层键逐键断言（新增字段必须显式过这关）
    expect(Object.keys(snap).sort()).toEqual(
      [
        "accounts",
        "cached",
        "databases",
        "degraded",
        "disk",
        "failedRawInputs",
        "generatedAt",
        "items",
        "media",
        "memory",
        "now",
        "queue",
        "startedAt",
        "today",
        "tokenRanking",
        "tokens",
        "uptimeSec",
        "version",
      ].sort(),
    );
    expect(res.headers["x-robots-tag"]).toBe("noindex");
    expect(res.headers["cache-control"]).toBe("public, max-age=30");
  });

  it("响应体不含造进去的内容、来源名与 uid", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });
    const raw = seedRaw(a.db, "机密作业：周三交到明理楼303");
    createItem(a.db, raw, { name: "机密作业" });

    const res = await realm.app.inject({ method: "GET", url: "/api/dashboard" });
    const body = res.body;
    expect(body).not.toContain("机密作业");
    expect(body).not.toContain("明理楼");
    expect(body).not.toContain(a.space.uid);
    expect(body).not.toContain("手机备忘录");
  });

  it("带坏 cookie 也照常返回（公开面无认证）", async () => {
    const realm = await makeTestRealm();
    const res = await realm.app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { cookie: "sid=garbage" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /dashboard 返回自包含页面：含 noindex，不含任何内容", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });
    const raw = seedRaw(a.db, "不会出现在页面里的正文");
    createItem(a.db, raw, { name: "页面不该出现的标题" });

    const res = await realm.app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["x-robots-tag"]).toBe("noindex");
    expect(res.body).toContain('name="robots" content="noindex"');
    expect(res.body).not.toContain("页面不该出现的标题");
    expect(res.body).not.toContain("不会出现在页面里的正文");
    // 自包含：无外链脚本/样式/字体
    expect(res.body).not.toMatch(/<script[^>]+src=/);
    expect(res.body).not.toMatch(/<link[^>]+stylesheet/);
  });
});

describe("聚合正确（US2）", () => {
  it("两个账户的事项/通知/回收站/图片/token 逐项汇总", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });
    const b = await realm.addAccount({ username: "bob" });

    const rawA = seedRaw(a.db, "A 的原文");
    createItem(a.db, rawA, { name: "A 的事项" });
    createItem(a.db, rawA, { name: "A 的通知", kind: "notice" });
    createItem(a.db, rawA, { name: "A 删掉的", status: "trashed" });
    repo.insertMedia(a.db, {
      id: "a".repeat(64),
      mime: "image/png",
      sizeBytes: 1000,
      createdAt: "2026-10-21T10:00:00",
      expiresAt: "2026-11-01T10:00:00",
      originUrl: null,
    });
    seedUsage(a.db, 1000, 200, 800);

    const rawB = seedRaw(b.db, "B 的原文");
    createItem(b.db, rawB, { name: "B 的事项" });
    repo.insertMedia(b.db, {
      id: "b".repeat(64),
      mime: "image/jpeg",
      sizeBytes: 500,
      createdAt: "2026-10-21T10:00:00",
      expiresAt: "2026-11-01T10:00:00",
      originUrl: null,
    });
    seedUsage(b.db, 500, 100, null);

    const snap = await getSnapshot(realm.app);
    expect(snap.items).toEqual({ tasks: 2, notices: 1, trashed: 1 });
    expect(snap.media).toEqual({ count: 2, bytes: 1500 });
    expect(snap.today.llmCalls).toBe(2);
    // 未命中 = Σ(prompt − cached) = (1000−800) + 500 = 700；输出 300；缓存 800
    expect(snap.tokens.today).toEqual({
      inputTokens: 700,
      completionTokens: 300,
      cachedTokens: 800,
    });
    expect(snap.tokens.today.inputTokens + snap.tokens.today.completionTokens + 800).toBe(1800);
    expect(snap.accounts).toEqual({ total: 2, active: 2 });
    expect(snap.databases.total).toBe(2);
    expect(snap.databases.failed).toBe(0);
    expect(snap.degraded).toBe(false);
  });

  it("今日进站按北京墙钟日历日；昨天的不计入", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });
    seedRaw(a.db, "今天", undefined);
    seedRaw(a.db, "上个月", "2026-09-01T10:00:00");
    const snap = await getSnapshot(realm.app);
    expect(snap.today.rawBatches).toBe(1);
  });

  it("队列：pending/digesting/failed 各归各位", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });
    const r1 = seedRaw(a.db, "一");
    const r2 = seedRaw(a.db, "二");
    const r3 = seedRaw(a.db, "三");
    repo.setDigestState(a.db, r2.id, "digesting");
    repo.setDigestState(a.db, r3.id, "failed");
    const snap = await getSnapshot(realm.app);
    expect(snap.queue).toEqual({ pending: 1, digesting: 1 });
    expect(snap.failedRawInputs).toBe(1);
    expect(r1.id).toBeTruthy();
  });

  it("已消化 / 失败按今日进站批次的当前状态计（重试旧批次不串味）", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });
    const r1 = seedRaw(a.db, "今天的，消化完成");
    const r2 = seedRaw(a.db, "今天的，未处理");
    const r3 = seedRaw(a.db, "今天的，还在排队");
    repo.setDigestState(a.db, r1.id, "digested");
    repo.setDigestState(a.db, r2.id, "failed");

    // 重试一条**昨天**的旧批次、今天完成——不能算进「今日已消化」（否则出现「今日进站 0 · 已消化 5」）
    const old = seedRaw(a.db, "昨天的", "2026-09-01T10:00:00");
    repo.setDigestState(a.db, old.id, "digested");
    repo.appendPipelineEvent(a.db, {
      rawInputId: old.id,
      action: "digest_done",
      detail: "重试后今天完成",
      by: { actor: "agent0", model: "test" },
    });

    const snap = await getSnapshot(realm.app);
    expect(snap.today.rawBatches).toBe(3);
    expect(snap.today.digested).toBe(1);
    expect(snap.today.digestFailed).toBe(1);
    expect(snap.queue).toEqual({ pending: 1, digesting: 0 });
    expect(r3.id).toBeTruthy();
  });

  it("「今日」以北京墙钟为准，不随机器时区漂移（固定时刻直接对聚合数学）", async () => {
    // 23:59:59 与跨天 00:00:01 是两天（用固定日期直接调 collect，绕过当前时间）
    const { collectDashboardSnapshot } = await import("../application/dashboard");
    const dir = mkdtempSync(path.join(os.tmpdir(), "summarizing-dashboard-tz-"));
    dirs.push(dir);
    const { makeRegistryDb, createAccount } = await import("../storage/registry");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(dir, "users"), { recursive: true });
    const registry = makeRegistryDb(path.join(dir, "system.db"));
    const account = createAccount(registry, { username: "tz", passwordHash: "x" });
    const db = makeDb(path.join(dir, "users", `${account.uid}.db`));
    seedRaw(db, "昨夜", "2026-10-20T23:59:59");
    seedRaw(db, "今晨", "2026-10-21T00:00:01");
    db.$client.close();

    const snap = collectDashboardSnapshot({
      registry,
      dataRoot: dir,
      // 北京 2026-10-21 12:00 = UTC 04:00
      now: new Date("2026-10-21T04:00:00Z"),
    });
    expect(snap.today.rawBatches).toBe(1);
    registry.$client.close();
  });
});

describe("只读与降级", () => {
  it("聚合不改库：user_version 不变、不建表", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });
    seedRaw(a.db, "x");
    const file = path.join(realm.dataRoot, "users", `${a.space.uid}.db`);
    const before = new Database(file, { readonly: true });
    const versionBefore = before.pragma("user_version", { simple: true });
    const tablesBefore = before
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    before.close();

    await getSnapshot(realm.app);

    const after = new Database(file, { readonly: true });
    expect(after.pragma("user_version", { simple: true })).toBe(versionBefore);
    expect(
      after.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
    ).toEqual(tablesBefore);
    after.close();
  });

  it("损坏的库 → 200 且 degraded=true，其它账户数字仍正确", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });
    seedRaw(a.db, "好的");
    // 模拟「库文件在盘上损坏」：账户存在、库文件存在但内容不是 SQLite。
    // （不能覆写已打开账户的库——WAL 里还有一份完整数据，只读连接会照常读到；那是另一个形态。）
    const { createAccount } = await import("../storage/registry");
    const broken = createAccount(realm.registry, { username: "broken", passwordHash: "x" });
    writeFileSync(path.join(realm.dataRoot, "users", `${broken.uid}.db`), "not a sqlite file");

    const res = await realm.app.inject({ method: "GET", url: "/api/dashboard" });
    expect(res.statusCode).toBe(200);
    const snap = DashboardSnapshotSchema.parse(res.json());
    expect(snap.degraded).toBe(true);
    expect(snap.databases.failed).toBe(1);
    expect(snap.databases.opened).toBe(1);
    expect(snap.today.rawBatches).toBe(1);
  });

  it("从未登录的账户没有库文件 → 跳过且不算故障", async () => {
    const realm = await makeTestRealm();
    await realm.addAccount({ username: "alice" });
    // 直接建一个从未装配过空间的账户（无库文件）
    const { createAccount } = await import("../storage/registry");
    createAccount(realm.registry, { username: "ghost", passwordHash: "x" });

    const snap = await getSnapshot(realm.app);
    expect(snap.accounts).toEqual({ total: 2, active: 2 });
    expect(snap.databases.total).toBe(1); // 只有 alice 的库存在
    expect(snap.databases.failed).toBe(0);
    expect(snap.degraded).toBe(false);
  });
});

describe("token 排行（US4）", () => {
  it("三个账户 → 全部入榜（上限 10），按累计降序（服务端截断）", async () => {
    const realm = await makeTestRealm();
    const big = await realm.addAccount({ username: "big" });
    const mid = await realm.addAccount({ username: "mid" });
    const small = await realm.addAccount({ username: "small" });
    seedUsage(big.db, 120_000, 0, null);
    seedUsage(mid.db, 3_000, 0, null);
    seedUsage(small.db, 1_000, 0, null);

    const snap = await getSnapshot(realm.app);
    // 名字只露前两字（用户 2026-10-21：publicRankName 在服务端截断）
    expect(snap.tokenRanking).toEqual([
      { name: "bi…", tokens: 120_000 },
      { name: "mi…", tokens: 3_000 },
      { name: "sm…", tokens: 1_000 },
    ]);
    // 响应体里不能出现完整用户名（截断是服务端做的，不靠前端藏）
    const res = await realm.app.inject({ method: "GET", url: "/api/dashboard" });
    expect(res.body).not.toContain("big");
    expect(res.body).not.toContain("mid");
    expect(res.body).not.toContain("small");
  });

  it("超过 10 个账户 → 服务端只出前 10 名", async () => {
    const realm = await makeTestRealm();
    for (let i = 0; i < 12; i += 1) {
      const acc = await realm.addAccount({ username: `user${String(i).padStart(2, "0")}` });
      seedUsage(acc.db, (i + 1) * 100, 0, null);
    }
    const snap = await getSnapshot(realm.app);
    expect(snap.tokenRanking).toHaveLength(10);
    // 降序：第 11、12 名（100 / 200 token）被截掉
    expect(snap.tokenRanking[0]?.tokens).toBe(1_200);
    expect(snap.tokenRanking[9]?.tokens).toBe(300);
  });

  it("并列按用户名升序稳定", async () => {
    const realm = await makeTestRealm();
    const c = await realm.addAccount({ username: "charlie" });
    const a = await realm.addAccount({ username: "alice" });
    const b = await realm.addAccount({ username: "bob" });
    seedUsage(c.db, 500, 0, null);
    seedUsage(a.db, 500, 0, null);
    seedUsage(b.db, 500, 0, null);

    const snap = await getSnapshot(realm.app);
    expect(snap.tokenRanking.map((r) => r.name)).toEqual(["al…", "bo…", "ch…"]);
  });

  it("两个字以内的用户名原样显示（不画蛇添足加省略号）", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "阿明" });
    seedUsage(a.db, 100, 0, null);
    const snap = await getSnapshot(realm.app);
    expect(snap.tokenRanking.map((r) => r.name)).toEqual(["阿明"]);
  });

  it("停用账户不上榜，但历史仍计入全站总量", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });
    const b = await realm.addAccount({ username: "bob" });
    seedUsage(a.db, 10_000, 0, null);
    seedUsage(b.db, 100, 0, null);
    setAccountStatus(realm.registry, a.space.uid, "disabled");

    const snap = await getSnapshot(realm.app);
    expect(snap.tokenRanking.map((r) => r.name)).toEqual(["bo…"]);
    expect(snap.tokens.total.inputTokens).toBe(10_100); // 停用账户历史仍是全站总量的一部分
    expect(snap.accounts).toEqual({ total: 2, active: 1 });
  });

  it("0 token 的账户不上榜（没调用过不是「第二名」）", async () => {
    const realm = await makeTestRealm();
    const used = await realm.addAccount({ username: "alice" });
    await realm.addAccount({ username: "bob" }); // 从未调用
    seedUsage(used.db, 500, 100, null);

    const snap = await getSnapshot(realm.app);
    expect(snap.tokenRanking).toEqual([{ name: "al…", tokens: 600 }]);
    // 全站总量照常是 0 token 账户贡献的 0（不因不上榜而消失）
    expect(snap.accounts.active).toBe(2);
  });

  it("所有账户都是 0 token → 空榜（页面显示「暂无数据」）", async () => {
    const realm = await makeTestRealm();
    await realm.addAccount({ username: "alice" });
    await realm.addAccount({ username: "bob" });

    const snap = await getSnapshot(realm.app);
    expect(snap.tokenRanking).toEqual([]);
  });
});

describe("只读聚合的脏形态（stats 层）", () => {
  it("缺表（旧 schema）按 0，不判整库失败", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "old.db");
    const db = new Database(file);
    // 只有 v1 的核心表，没有 llm_usage / media
    db.exec(`
      CREATE TABLE raw_inputs (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL,
        identity_json TEXT NOT NULL, received_at TEXT NOT NULL, event_time TEXT,
        digest_state TEXT NOT NULL DEFAULT 'pending', raw TEXT,
        tokens TEXT, identity_tokens TEXT);
      CREATE TABLE item_versions (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, action TEXT NOT NULL,
        detail TEXT NOT NULL, snapshot TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL, revoked_by TEXT);
    `);
    db.close();

    const stats = readUserDbStats(file, "2026-10-21T00:00:00");
    expect(stats.mediaCount).toBe(0);
    expect(stats.usageTotal).toEqual({ promptTokens: 0, completionTokens: 0, cachedTokens: null });
    expect(stats.rawToday).toBe(0);
  });

  it("空文件/非用户库 → 抛错（上层记 failed）", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "empty.db");
    writeFileSync(file, "");
    expect(() => readUserDbStats(file, "2026-10-21T00:00:00")).toThrow();
  });

  it("cached 全 NULL → null；混合 NULL/有值 → 只加非 NULL", async () => {
    // 缓存 60 秒 + 首次请求即聚合：这个用例需要「写一行 → 取快照」立刻可见（两次），
    // 用应用层服务直取（同一套聚合，绕过 HTTP 缓存窗口）。
    const { collectDashboardSnapshot } = await import("../application/dashboard");
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });
    /** 直接采一次快照（无缓存）。 */
    const collectNow = () =>
      collectDashboardSnapshot({
        registry: realm.registry,
        dataRoot: realm.dataRoot,
        now: new Date(),
      });

    seedUsage(a.db, 100, 10, null);
    let snap = collectNow();
    expect(snap.tokens.today.cachedTokens).toBeNull();
    expect(snap.tokens.today.inputTokens).toBe(100);

    seedUsage(a.db, 200, 20, 150);
    snap = collectNow();
    expect(snap.tokens.today.cachedTokens).toBe(150);
    expect(snap.tokens.today.inputTokens).toBe(150); // (100−0) + (200−150)
    expect(snap.tokens.today.completionTokens).toBe(30);
  });

  it("prompt < cached（服务商怪异）→ 未命中夹到 0，不传播负数", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });
    seedUsage(a.db, 10, 5, 100);
    const snap = await getSnapshot(realm.app);
    expect(snap.tokens.today.inputTokens).toBe(0);
    expect(snap.tokens.today.cachedTokens).toBe(100);
  });

  it("最后版本快照非法 JSON / kind 不在枚举 → 计入 degraded，不猜归类", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });
    a.db.$client
      .prepare(
        `INSERT INTO item_versions (id, item_id, action, detail, snapshot, at, by)
         VALUES ('v1', 'x1', 'create_item', 'd', '{坏JSON', '2026-10-21T10:00:00', '{"actor":"a","model":null}')`,
      )
      .run();
    const snap = await getSnapshot(realm.app);
    expect(snap.degraded).toBe(true);
    expect(snap.items).toEqual({ tasks: 0, notices: 0, trashed: 0 });
  });
});

describe("缓存、单飞与限流", () => {
  it("60 秒内重复请求 cached=true；过后重新聚合", async () => {
    const realm = await makeTestRealm();
    await realm.addAccount({ username: "alice" });
    const first = await getSnapshot(realm.app);
    expect(first.cached).toBe(false);
    const second = await getSnapshot(realm.app);
    expect(second.cached).toBe(true);
    expect(second.generatedAt).toBe(first.generatedAt);
  });

  it("并发 20 个请求共享同一次聚合（单飞）", async () => {
    const realm = await makeTestRealm();
    await realm.addAccount({ username: "alice" });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => realm.app.inject({ method: "GET", url: "/api/dashboard" })),
    );
    const stamps = new Set(results.map((r) => DashboardSnapshotSchema.parse(r.json()).generatedAt));
    expect(stamps.size).toBe(1);
    // 只有一个未缓存（第一个发起聚合的），其余都是缓存
    const uncached = results.filter(
      (r) => DashboardSnapshotSchema.parse(r.json()).cached === false,
    );
    expect(uncached).toHaveLength(1);
  });

  it("同一 IP 第 61 次 → 429（响应不带内部信息）", async () => {
    const realm = await makeTestRealm();
    await realm.addAccount({ username: "alice" });
    for (let i = 0; i < 60; i += 1) {
      const res = await realm.app.inject({ method: "GET", url: "/api/dashboard" });
      expect(res.statusCode).toBe(200);
    }
    const over = await realm.app.inject({ method: "GET", url: "/api/dashboard" });
    expect(over.statusCode).toBe(429);
    expect(Object.keys(over.json<Record<string, unknown>>())).toEqual(["error"]);
  });
});

describe("版本号", () => {
  it("开发态无构建注入 → dev；构建脚本能从 CHANGELOG 读出当前版本", async () => {
    const { appVersion } = await import("../shared/version");
    expect(appVersion()).toBe("dev");
    const changelog = readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
    const versionMatch = /^## \[v(\d+\.\d+\.\d+)\]/m.exec(changelog);
    expect(versionMatch?.[1]).toBeTruthy();
  });
});
