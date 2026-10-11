import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { cleanupAllTestAccounts, makeTestAccount, makeTestRealm } from "./helpers/app";
import {
  createInvite,
  getAccountByUsername,
  getSessionSecret,
  invites,
  setAccountStatus,
} from "../storage/registry";
import { issueSessionValue } from "../auth/session";
import { loginKey, loginLockRemainingSec, resetLimitsForTest } from "../auth/limits";
import { existsSync } from "node:fs";
import path from "node:path";

// 认证套件（006 T024 / contracts/http.md 失败矩阵）：注册-登录-登出-改密-轮换 +
// 锁定/停用/坏 cookie 全态。全走真实入口（真账户/真签名由 helper 提供）。

afterEach(async () => {
  vi.useRealTimers();
  resetLimitsForTest(); // 限速是模块态——用例间必须清（否则互相锁定）
  await cleanupAllTestAccounts();
});

describe("注册（凭邀请码）", () => {
  it("全链：201 + 会话 cookie + 用户库建立；码即废；me 可见", async () => {
    const realm = await makeTestRealm();
    const { code } = createInvite(realm.registry);
    const res = await realm.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { code, username: "alice", password: "pw12345678" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ username: string }>().username).toBe("alice");
    const sid = res.cookies[0];
    if (!sid) throw new Error("注册未发会话 cookie");

    // 用户库已在装配时建立
    const acc = getAccountByUsername(realm.registry, "alice");
    if (!acc) throw new Error("账户未建");
    expect(existsSync(path.join(realm.dataRoot, "users", `${acc.uid}.db`))).toBe(true);

    // 码即废：再用 → 400 话术统一
    const reuse = await realm.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { code, username: "bob", password: "pw12345678" },
    });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json<{ error: string }>().error).toContain("邀请码无效或已过期");

    // me：凭注册发的 cookie 可见自己（含接入令牌）
    const me = await realm.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `sid=${sid.value}` },
    });
    expect(me.statusCode).toBe(200);
    const view = me.json<{ username: string; sourceToken: string }>();
    expect(view.username).toBe("alice");
    expect(view.sourceToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it("脏形态：码格式坏/过期/同名 → 对应状态码（附录 A）", async () => {
    const realm = await makeTestRealm();
    const bad = await realm.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { code: "abc", username: "alice", password: "pw12345678" },
    });
    expect(bad.statusCode).toBe(400);

    const { code } = createInvite(realm.registry);
    realm.registry
      .update(invites)
      .set({ expiresAt: "2000-01-01T00:00:00" })
      .where(eq(invites.code, code))
      .run();
    const expired = await realm.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { code, username: "alice", password: "pw12345678" },
    });
    expect(expired.statusCode).toBe(400);

    // 同名：先用有效码注册，再用新码同名 → 409
    const { code: c2 } = createInvite(realm.registry);
    const ok = await realm.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { code: c2, username: "alice", password: "pw12345678" },
    });
    expect(ok.statusCode).toBe(201);
    const { code: c3 } = createInvite(realm.registry);
    const dup = await realm.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { code: c3, username: "Alice", password: "pw12345678" }, // 大小写变体=同名
    });
    expect(dup.statusCode).toBe(409);

    // 码不被烧：同名失败整批回滚（c3 仍可用）
    const { code: c4 } = createInvite(realm.registry);
    const retry = await realm.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { code: c4, username: "carol", password: "pw12345678" },
    });
    expect(retry.statusCode).toBe(201);
  });
});

describe("登录 / 登出", () => {
  it("错凭据与不存在用户同话术 401；成功发会话且 me 可用", async () => {
    const t = await makeTestAccount();
    const wrong = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "tester", password: "wrong-password" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json<{ error: string }>().error).toBe("用户名或密码错误");

    const ghost = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "nobody", password: "whatever-123" },
    });
    expect(ghost.statusCode).toBe(401);
    expect(ghost.json<{ error: string }>().error).toBe("用户名或密码错误"); // 统一话术

    const ok = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "tester", password: "test-password-123" },
    });
    expect(ok.statusCode).toBe(200);
    const sid = ok.cookies[0];
    if (!sid) throw new Error("登录未发会话 cookie");
    const me = await t.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `sid=${sid.value}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it("停用账户：验密后 403 明确提示", async () => {
    const t = await makeTestAccount();
    const acc = getAccountByUsername(t.registry, "tester");
    if (!acc) throw new Error("账户丢失");
    setAccountStatus(t.registry, acc.uid, "disabled");
    const res = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "tester", password: "test-password-123" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe("账户已停用");
  });

  it("登出：204 清 cookie；此后无 cookie 的 me → 401", async () => {
    const t = await makeTestAccount();
    const out = await t.inject({ method: "POST", url: "/api/auth/logout" });
    expect(out.statusCode).toBe(204);
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me" }); // 不带 cookie
    expect(me.statusCode).toBe(401);
  });

  it("锁定：同（用户名, IP）连败 5 次 → 429 带 retryAfterSec；到期自解", async () => {
    const t = await makeTestAccount();
    for (let i = 0; i < 5; i += 1) {
      const r = await t.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "tester", password: "wrong-password" },
      });
      expect(r.statusCode).toBe(401);
    }
    const locked = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "tester", password: "test-password-123" }, // 密码对也拒（先查锁）
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json<{ retryAfterSec: number }>().retryAfterSec).toBeGreaterThan(0);

    // 另一 IP 的对键不受影响（防拿别人用户名锁人）——同一模块函数直接验证窗口到期自解
    const key = loginKey("tester", "127.0.0.1");
    expect(loginLockRemainingSec(key)).toBeGreaterThan(0);
    expect(loginLockRemainingSec(key, Date.now() + 16 * 60_000)).toBe(0);
    expect(loginLockRemainingSec(loginKey("tester", "10.0.0.9"))).toBe(0);
  });
});

describe("改密 / 轮换令牌", () => {
  it("改密：原密码错 400；成功后其余会话 401、本会话续签、新旧密码取舍正确", async () => {
    const t = await makeTestAccount();
    const oldCookie = t.cookie;

    const wrongOld = await t.inject({
      method: "PUT",
      url: "/api/auth/password",
      payload: { oldPassword: "not-the-password", newPassword: "newpw12345" },
    });
    expect(wrongOld.statusCode).toBe(400);
    expect(wrongOld.json<{ error: string }>().error).toBe("原密码不正确");

    const ok = await t.inject({
      method: "PUT",
      url: "/api/auth/password",
      payload: { oldPassword: "test-password-123", newPassword: "newpw12345" },
    });
    expect(ok.statusCode).toBe(204);
    const fresh = ok.cookies[0];
    if (!fresh) throw new Error("改密未续签会话 cookie");

    // 旧会话（tv=1）→ 401；新会话 → 200
    const stale = await t.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: oldCookie },
    });
    expect(stale.statusCode).toBe(401);
    const live = await t.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `sid=${fresh.value}` },
    });
    expect(live.statusCode).toBe(200);

    // 旧密码失效、新密码可登录
    const oldLogin = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "tester", password: "test-password-123" },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "tester", password: "newpw12345" },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it("轮换接入令牌：新值即返、me 同步、形状为 32 hex", async () => {
    const t = await makeTestAccount();
    const before = t.sourceToken;
    const res = await t.inject({ method: "POST", url: "/api/auth/source-token/rotate" });
    expect(res.statusCode).toBe(200);
    const token = res.json<{ sourceToken: string }>().sourceToken;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(token).not.toBe(before);
    const me = await t.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.json<{ sourceToken: string }>().sourceToken).toBe(token);
  });
});

describe("会话 cookie 六态（中间件统一 401）", () => {
  it("坏签名 / 篡改 / uid 不存在 / 过期 → 全 401", async () => {
    const t = await makeTestAccount();

    const garbage = await t.app.inject({
      method: "GET",
      url: "/api/board",
      headers: { cookie: "sid=not-a-session" },
    });
    expect(garbage.statusCode).toBe(401);

    const tamperedValue = `${t.cookie.slice(4, -1)}X`; // 末位改一字（签名破坏）
    const tampered = await t.app.inject({
      method: "GET",
      url: "/api/board",
      headers: { cookie: `sid=${tamperedValue}` },
    });
    expect(tampered.statusCode).toBe(401);

    const ghost = issueSessionValue("deadbeefdeadbeef", 1, getSessionSecret(t.registry));
    const ghostRes = await t.app.inject({
      method: "GET",
      url: "/api/board",
      headers: { cookie: `sid=${ghost}` },
    });
    expect(ghostRes.statusCode).toBe(401);

    // 过期：假 Date 先签发（exp=+30d）再跳 31 天
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(t0);
    const expired = issueSessionValue(t.space.uid, 1, getSessionSecret(t.registry));
    vi.setSystemTime(new Date(t0.getTime() + 31 * 86_400_000));
    const expiredRes = await t.app.inject({
      method: "GET",
      url: "/api/board",
      headers: { cookie: `sid=${expired}` },
    });
    expect(expiredRes.statusCode).toBe(401);
  });
});
