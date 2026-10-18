import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupAllTestAccounts, makeTestRealm } from "./helpers/app";
import { executeChanges } from "../executor/executor";
import * as repo from "../storage/repo";
import { setAccountStatus } from "../storage/registry";
import { FakeLlm } from "./helpers/fakeLlm";

// 隔离套件（006 T025/T031/T039）：双账户**同实例**构造级隔离——全走真实入口。
// SC-001（互不可见）/ SC-002（未登录全封锁）/ AI 归属 / 停用即时性。

afterEach(cleanupAllTestAccounts);

describe("双账户隔离（SC-001）", () => {
  it("A 走完信源→消化→流水；B 全链路不可见（含用 A 的 id 直猜 → 404）", async () => {
    const realm = await makeTestRealm();
    const llmA = new FakeLlm();
    llmA.push({ content: '{"changes":[]}' }); // 零变更合法
    const a = await realm.addAccount({ username: "alice", llm: llmA });
    const b = await realm.addAccount({ username: "bob" });

    const ingest = await a.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        content: "A 的作业通知：十月八日交",
        sourceType: "paste",
        sourceIdentity: { sourceLabel: "手机备忘录" },
        eventTime: null,
      },
    });
    expect(ingest.statusCode).toBe(202);
    const rawId = ingest.json<{ id: string }>().id;
    await vi.waitFor(() => {
      expect(repo.listRawInputsByState(a.db, "digested")).toHaveLength(1);
    });

    // A 可见；B 不可见（台账空 + 拿 A 的 id 查详情 → 404）
    const aRuns = await a.inject({ method: "GET", url: "/api/pipeline/runs" });
    expect(aRuns.json<{ runs: unknown[] }>().runs).toHaveLength(1);
    const bRuns = await b.inject({ method: "GET", url: "/api/pipeline/runs" });
    expect(bRuns.json<{ runs: unknown[] }>().runs).toHaveLength(0);
    const bPeek = await b.inject({ method: "GET", url: `/api/pipeline/runs/${rawId}` });
    expect(bPeek.statusCode).toBe(404);

    // 设置也各归各：A 配了群白名单，B 读到空
    await a.inject({
      method: "PUT",
      url: "/api/sources/nc/settings/groups",
      payload: { "123": "英语课官方群" },
    });
    const bSettings = await b.inject({ method: "GET", url: "/api/sources/nc/settings" });
    expect(bSettings.json()).toEqual({});
  });

  it("B 对 A 的事项 id 打全部写口 → 全 404（东西物理上不在 B 的库）", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });
    const b = await realm.addAccount({ username: "bob" });

    // A 直库造一个事项（走真实执行器——造数层）
    const raw = repo.insertRawInput(a.db, {
      content: "作业通知",
      sourceType: "paste",
      sourceIdentity: { sourceLabel: "s" },
      receivedAt: "2026-09-24T10:00:00",
      eventTime: null,
    });
    executeChanges(
      a.db,
      raw,
      [
        {
          action: "create_item",
          elements: [{ label: "name", text: "A 的作业", quotes: [] }],
          tags: [],
          doubtNote: null,
        },
      ],
      { actor: "agent0", model: "test" },
    );
    const item = repo.deriveItems(a.db)[0];
    if (!item) throw new Error("事项未建");

    const attempts = [
      { method: "GET" as const, url: `/api/items/${item.id}` },
      { method: "POST" as const, url: `/api/items/${item.id}/complete` },
      { method: "POST" as const, url: `/api/items/${item.id}/trash` },
      { method: "POST" as const, url: `/api/items/${item.id}/restore` },
      { method: "POST" as const, url: `/api/items/${item.id}/viewed` },
    ];
    for (const req of attempts) {
      const res = await b.inject(req);
      expect(res.statusCode).toBe(404);
    }

    // 列表面：B 的通知/回收站里不可能出现 A 的条目
    const bTrash = await b.inject({ method: "GET", url: "/api/trash" });
    expect(bTrash.json<{ rows: { item: { id: string } }[] }>().rows).toEqual([]);
    const bNotices = await b.inject({ method: "GET", url: "/api/notices" });
    expect(bNotices.json<{ notices: { item: { id: string } }[] }>().notices).toEqual([]);

    // A 删掉它 → B 的一键清理不得碰到 A 的回收站
    await a.inject({ method: "POST", url: `/api/items/${item.id}/trash` });
    const bPurge = await b.inject({ method: "POST", url: "/api/trash/purge" });
    expect(bPurge.statusCode).toBe(200);
    expect(bPurge.json<{ purged: number }>().purged).toBe(0);
    const aTrash = await a.inject({ method: "GET", url: "/api/trash" });
    expect(aTrash.json<{ rows: { item: { id: string } }[] }>().rows.map((r) => r.item.id)).toEqual([
      item.id,
    ]);

    // 对照：A 自己打得通
    const own = await a.inject({ method: "GET", url: `/api/items/${item.id}` });
    expect(own.statusCode).toBe(200);
  });

  it("未登录逐端点 401（SC-002）", async () => {
    const realm = await makeTestRealm();
    const probes = [
      { method: "GET" as const, url: "/api/board" },
      { method: "GET" as const, url: "/api/notices" },
      { method: "GET" as const, url: "/api/trash" },
      { method: "POST" as const, url: "/api/trash/purge" },
      { method: "GET" as const, url: "/api/settings/rejection-rules" },
      { method: "PUT" as const, url: "/api/settings/rejection-rules", payload: { rules: "x" } },
      { method: "POST" as const, url: "/api/items/x/trash" },
      { method: "POST" as const, url: "/api/items/x/restore" },
      { method: "GET" as const, url: "/api/chat/history" },
      { method: "POST" as const, url: "/api/chat", payload: { message: "hi", history: [] } },
      { method: "GET" as const, url: "/api/sources" },
      { method: "GET" as const, url: "/api/pipeline/runs" },
      { method: "GET" as const, url: "/api/settings/ai" },
      { method: "GET" as const, url: "/api/uncertain" },
      { method: "GET" as const, url: "/api/items/x" },
      { method: "GET" as const, url: "/api/auth/me" },
      {
        method: "POST" as const,
        url: "/api/ingest",
        payload: {
          content: "x",
          sourceType: "paste",
          sourceIdentity: { sourceLabel: "s" },
          eventTime: null,
        },
      },
    ];
    for (const req of probes) {
      const res = await realm.app.inject(req); // 无 cookie
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("AI 归属（T031）：key/客户端各归各", () => {
  it("A 改 AI 设置 → A 的 llmRef 换新；B 的引用纹丝不动", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });
    const b = await realm.addAccount({ username: "bob" });
    const bBefore = b.space.llmRef.current;

    const put = await a.inject({
      method: "PUT",
      url: "/api/settings/ai",
      payload: { baseUrl: "http://127.0.0.1:9/v1", model: "a-model" },
    });
    expect(put.statusCode).toBe(200);
    expect(a.space.llmRef.current.modelTag).toBe("a-model");
    expect(b.space.llmRef.current).toBe(bBefore); // 同一引用未换
  });
});

describe("停用即时性（T039/SC-005）", () => {
  it("停用 → 会话下一请求 401、webhook 令牌 401、登录 403；启用即恢复", async () => {
    const realm = await makeTestRealm();
    const a = await realm.addAccount({ username: "alice" });

    setAccountStatus(realm.registry, a.space.uid, "disabled");

    const session = await a.inject({ method: "GET", url: "/api/board" });
    expect(session.statusCode).toBe(401); // 既有会话下一请求即断
    const hook = await a.app.inject({
      method: "POST",
      url: a.hookUrl("nc", "/event"),
      payload: {},
    });
    expect(hook.statusCode).toBe(401); // 令牌即失效（网关先鉴权后路由）
    const login = await a.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "test-password-123" },
    });
    expect(login.statusCode).toBe(403);

    // 启用恢复：旧 cookie 的 tv 未变——立即可用
    setAccountStatus(realm.registry, a.space.uid, "active");
    const back = await a.inject({ method: "GET", url: "/api/board" });
    expect(back.statusCode).toBe(200);
  });
});
