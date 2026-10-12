import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { cleanupAllTestAccounts, makeTestRealm } from "./helpers/app";
import * as repo from "../storage/repo";
import { setAccountStatus } from "../storage/registry";
import type { SourceAdapter } from "../sources/types";
import { FakeLlm } from "./helpers/fakeLlm";

// 信源网关套件（006 T030 / FR-008）：令牌定向 / 错停令牌 401 零落库 / 未登记 404 / 轮换即废。
// 替身源走**推型路径**（webhook 收——与 nc 同构但不带定时器/白名单，聚焦网关行为）。

afterEach(cleanupAllTestAccounts);

/** 极简推型源：POST /ingest 把 body.content 直投 ctx.ingest。 */
function makeEchoAdapter(): SourceAdapter {
  return {
    name: "echo",
    register(ctx, router) {
      router.post("/ingest", async (req, reply) => {
        const body = z.object({ content: z.string().min(1) }).parse(req.body);
        const r = ctx.ingest({
          content: body.content,
          sourceType: "echo",
          sourceIdentity: { sourceLabel: "回声源" },
          eventTime: null,
        });
        return reply.code(r.ok ? 202 : 500).send(r);
      });
    },
  };
}

/** 造一个挂了回声源、两账户各配零变更消化脚本的实例。 */
async function makeGatewayRealm() {
  const realm = await makeTestRealm({ adapters: [makeEchoAdapter] });
  const llmA = new FakeLlm();
  llmA.push({ content: '{"changes":[]}' });
  const llmB = new FakeLlm();
  llmB.push({ content: '{"changes":[]}' });
  const a = await realm.addAccount({ username: "alice", llm: llmA });
  const b = await realm.addAccount({ username: "bob", llm: llmB });
  return { realm, a, b };
}

describe("令牌定向（SC-001 信源面）", () => {
  it("GET /api/sources 下发 hookPath（含账户令牌——前端零拼接）；轮换后随之更新", async () => {
    const { a } = await makeGatewayRealm();
    const list = await a.inject({ method: "GET", url: "/api/sources" });
    const [echo] = z
      .array(z.object({ name: z.string(), hookPath: z.string().nullable() }))
      .parse(list.json());
    if (!echo) throw new Error("信源列表为空");
    expect(echo.hookPath).toBe(`/hook/${a.sourceToken}/echo/ingest`); // 由后端算好（源自己的路径形状）

    // 轮换令牌 → hookPath 用新令牌（说明它取的是实时值，不是快照）
    const rot = await a.inject({ method: "POST", url: "/api/auth/source-token/rotate" });
    const next = rot.json<{ sourceToken: string }>().sourceToken;
    const list2 = await a.inject({ method: "GET", url: "/api/sources" });
    const [echo2] = z.array(z.object({ hookPath: z.string().nullable() })).parse(list2.json());
    expect(echo2?.hookPath).toBe(`/hook/${next}/echo/ingest`);
  });

  it("A/B 各凭自己的令牌投递 → 各落各库；互不串", async () => {
    const { a, b } = await makeGatewayRealm();

    const ra = await a.app.inject({
      method: "POST",
      url: a.hookUrl("echo", "/ingest"),
      payload: { content: "A 的消息" },
    });
    expect(ra.statusCode).toBe(202);
    const rb = await b.app.inject({
      method: "POST",
      url: b.hookUrl("echo", "/ingest"),
      payload: { content: "B 的消息" },
    });
    expect(rb.statusCode).toBe(202);

    await vi.waitFor(() => {
      expect(repo.listRawInputsByState(a.db, "digested")).toHaveLength(1);
      expect(repo.listRawInputsByState(b.db, "digested")).toHaveLength(1);
    });
    expect(repo.listRawInputsByState(a.db, "digested")[0]?.content).toBe("A 的消息");
    expect(repo.listRawInputsByState(b.db, "digested")[0]?.content).toBe("B 的消息");
  });

  it("错 token / 未登记源或路径 → 401/404，且零落库", async () => {
    const { a } = await makeGatewayRealm();

    const wrongToken = await a.app.inject({
      method: "POST",
      url: "/hook/deadbeef/echo/ingest",
      payload: { content: "x" },
    });
    expect(wrongToken.statusCode).toBe(401);
    const ghostSource = await a.app.inject({
      method: "POST",
      url: a.hookUrl("ghost", "/ingest"),
      payload: { content: "x" },
    });
    expect(ghostSource.statusCode).toBe(404);
    const ghostPath = await a.app.inject({
      method: "POST",
      url: a.hookUrl("echo", "/other"),
      payload: { content: "x" },
    });
    expect(ghostPath.statusCode).toBe(404);
    expect(repo.listRawInputsByState(a.db, "pending")).toHaveLength(0);
    expect(repo.listRawInputsByState(a.db, "digested")).toHaveLength(0);
  });

  it("停用账户的令牌 → 401（先鉴权后路由，零落库）", async () => {
    const { realm, a } = await makeGatewayRealm();
    setAccountStatus(realm.registry, a.space.uid, "disabled");
    const res = await a.app.inject({
      method: "POST",
      url: a.hookUrl("echo", "/ingest"),
      payload: { content: "x" },
    });
    expect(res.statusCode).toBe(401);
    expect(repo.listRawInputsByState(a.db, "pending")).toHaveLength(0);
  });

  it("轮换令牌：旧地址即刻 401、新地址可用", async () => {
    const { a } = await makeGatewayRealm();
    const oldUrl = a.hookUrl("echo", "/ingest");

    const rotate = await a.inject({ method: "POST", url: "/api/auth/source-token/rotate" });
    expect(rotate.statusCode).toBe(200);
    const token = rotate.json<{ sourceToken: string }>().sourceToken;

    const withOld = await a.app.inject({ method: "POST", url: oldUrl, payload: { content: "x" } });
    expect(withOld.statusCode).toBe(401);
    const withNew = await a.app.inject({
      method: "POST",
      url: `/hook/${token}/echo/ingest`,
      payload: { content: "轮换后" },
    });
    expect(withNew.statusCode).toBe(202);
  });
});
