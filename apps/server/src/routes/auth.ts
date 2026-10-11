import type { FastifyInstance } from "fastify";
import {
  AuthOkSchema,
  ChangePasswordRequestSchema,
  errText,
  LoginRequestSchema,
  MeViewSchema,
  RegisterRequestSchema,
  RotateTokenResponseSchema,
} from "@summarizing/shared";
import {
  clearLoginFailures,
  loginIpRateLimited,
  loginKey,
  loginLockRemainingSec,
  recordLoginFailure,
  registerRateLimited,
} from "../auth/limits";
import { hashPassword, verifyDummy, verifyPassword } from "../auth/password";
import { clearSessionCookie, setSessionCookie } from "../auth/session";
import {
  getAccountByUid,
  getAccountByUsername,
  redeemInviteAndCreateAccount,
  rollbackRegistration,
  rotateSourceToken,
  setPasswordHashAndBumpTokenVersion,
  type RegistryDb,
} from "../storage/registry";
import type { SpaceHub } from "../spaces";

// 认证路由（006 / contracts/http.md）：
// 公开面 = register / login / logout（deploy 面之外唯一无需会话的 /api 口）；
// 受保护面 = me / 改密 / 轮换令牌（挂在受保护作用域内，preHandler 已挂 req.space）。

/** 公开面依赖（register 要 hub 以装配新账户的空间）。 */
export interface AuthPublicDeps {
  registry: RegistryDb;
  hub: SpaceHub;
  secret: string;
}

/** 受保护面依赖（me / 改密 / 轮换令牌只碰 registry 与会话签名）。 */
export interface AuthSessionDeps {
  registry: RegistryDb;
  secret: string;
}

/** 注册认证公开端点（register/login/logout）。 */
export function registerAuthPublicRoutes(app: FastifyInstance, deps: AuthPublicDeps): void {
  // 注册（凭邀请码）：限速 → 原子核销+建账户 → 装配空间 → 自动登录（FR-002）
  app.post("/api/auth/register", async (req, reply) => {
    if (registerRateLimited(req.ip)) {
      return reply.code(429).send({ error: "注册过于频繁，请稍后再试" });
    }
    const parsed = RegisterRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "请求体不合法", issues: parsed.error.issues });
    }
    const { code, username, password } = parsed.data;
    const passwordHash = await hashPassword(password);
    // 核销与建账户同一事务：码不可用或用户名被占整批回滚——绝不烧码
    const result = redeemInviteAndCreateAccount(deps.registry, { code, username, passwordHash });
    if (!result.ok) {
      return result.reason === "username"
        ? reply.code(409).send({ error: "用户名已被占用" })
        : reply.code(400).send({ error: "邀请码无效或已过期" });
    }
    try {
      await deps.hub.ensure(result.account.uid); // 空间就绪（新用户库开在此刻）
    } catch (err) {
      // 装配失败 → 撤回注册（退邀请码，不当一次性码吞掉——评审修复），如实 500
      req.log.error(`注册后装配空间失败，已撤回：${errText(err)}`);
      try {
        rollbackRegistration(deps.registry, result.account.uid, code);
      } catch (rollbackErr) {
        req.log.error(`注册撤回失败（需人工核对）：${errText(rollbackErr)}`);
      }
      return reply.code(500).send({ error: "服务器暂时不可用，请稍后重试" });
    }
    setSessionCookie(reply, result.account.uid, result.account.tokenVersion, deps.secret);
    return reply.code(201).send(AuthOkSchema.parse({ username: result.account.username }));
  });

  // 登录：IP 总量限速（防刷 scrypt）→ 对键锁定 → 查账户（无此人做哑哈希——不泄露存在性）
  // → 验密 → 状态 → 发会话
  app.post("/api/auth/login", async (req, reply) => {
    if (loginIpRateLimited(req.ip)) {
      return reply.code(429).send({ error: "尝试过于频繁，请稍后再试" });
    }
    const parsed = LoginRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "请求体不合法", issues: parsed.error.issues });
    }
    const { username, password } = parsed.data;
    const key = loginKey(username, req.ip);
    const locked = loginLockRemainingSec(key);
    if (locked > 0) {
      return reply.code(429).send({ error: "尝试过于频繁，请稍后再试", retryAfterSec: locked });
    }
    const account = getAccountByUsername(deps.registry, username);
    if (account === undefined) {
      await verifyDummy(password);
      recordLoginFailure(key);
      return reply.code(401).send({ error: "用户名或密码错误" });
    }
    if (!(await verifyPassword(password, account.passwordHash))) {
      recordLoginFailure(key);
      return reply.code(401).send({ error: "用户名或密码错误" });
    }
    if (account.status !== "active") {
      // 验密之后才说「停用」——不凭用户名泄露账户状态
      return reply.code(403).send({ error: "账户已停用" });
    }
    clearLoginFailures(key);
    await deps.hub.ensure(account.uid);
    setSessionCookie(reply, account.uid, account.tokenVersion, deps.secret);
    return reply.send(AuthOkSchema.parse({ username: account.username }));
  });

  // 登出：清 cookie（幂等，无需已登录）
  app.post("/api/auth/logout", async (_req, reply) => {
    clearSessionCookie(reply);
    return reply.code(204).send();
  });
}

/** 注册认证受保护端点（me / 改密 / 轮换接入令牌）。 */
export function registerAuthSessionRoutes(app: FastifyInstance, deps: AuthSessionDeps): void {
  // 当前账户视图：用户名 + 接入令牌（设置区渲染完整接入地址用）
  app.get("/api/auth/me", async (req, reply) => {
    const account = getAccountByUid(deps.registry, req.space.uid);
    if (account === undefined) return reply.code(401).send({ error: "未登录" }); // 理论不可达（preHandler 已查）
    return reply.send(
      MeViewSchema.parse({ username: account.username, sourceToken: account.sourceToken }),
    );
  });

  // 改密（FR-004）：验原密 → 换哈希 + tv+1（全端下线）→ 本会话按新 tv 续签
  app.put("/api/auth/password", async (req, reply) => {
    const parsed = ChangePasswordRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "请求体不合法", issues: parsed.error.issues });
    }
    const account = getAccountByUid(deps.registry, req.space.uid);
    if (account === undefined) return reply.code(401).send({ error: "未登录" });
    if (!(await verifyPassword(parsed.data.oldPassword, account.passwordHash))) {
      return reply.code(400).send({ error: "原密码不正确" });
    }
    const hash = await hashPassword(parsed.data.newPassword);
    setPasswordHashAndBumpTokenVersion(deps.registry, account.uid, hash);
    setSessionCookie(reply, account.uid, account.tokenVersion + 1, deps.secret);
    return reply.code(204).send();
  });

  // 轮换接入令牌（FR-008）：旧值即刻作废——全部旧接入地址 401
  app.post("/api/auth/source-token/rotate", async (req, reply) => {
    const token = rotateSourceToken(deps.registry, req.space.uid);
    return reply.send(RotateTokenResponseSchema.parse({ sourceToken: token }));
  });
}
