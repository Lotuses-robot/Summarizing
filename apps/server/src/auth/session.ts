import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getAccountByUid, type RegistryDb } from "../storage/registry";
import type { Space } from "../spaces";

// 会话（006 R1 / contracts/http.md）：无会话表的签名 cookie——载荷 {v,uid,tv,exp} + HMAC-SHA256。
// 撤销语义：改密/重置 → tokenVersion+1；停用 → status 逐请求校验（都在鉴权中间件里看最新值）。

export const SESSION_COOKIE = "sid";
const SESSION_TTL_MS = 30 * 86_400_000; // 30 天
const RENEW_BELOW_MS = 15 * 86_400_000; // 剩 <15 天随响应续签（滑动）

const SessionPayloadSchema = z.object({
  v: z.literal(1),
  uid: z.string().min(1),
  tv: z.number().int(),
  exp: z.number().int(),
});
type SessionPayload = z.infer<typeof SessionPayloadSchema>;

/** 签名：`base64url(JSON载荷) . HMAC-SHA256(同串) hex`。 */
function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("hex");
  return `${body}.${mac}`;
}

/** 验签 + 解析：签名用 timingSafeEqual 比对；任何格式/篡改问题返回 null（不抛）。 */
function parseSession(value: string, secret: string): SessionPayload | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const mac = Buffer.from(value.slice(dot + 1), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  try {
    const raw: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const parsed = SessionPayloadSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** cookie 属性（contracts/http.md）：httpOnly + SameSite=Lax + Path=/。
 *  Secure（评审修复）：按**请求协议**自动——https（Caddy/上线）必开；局域网 http（手机访问）则关，
 *  否则浏览器丢弃 cookie 且无从得知原因。env `SESSION_COOKIE_SECURE=1` 可显式强制开。 */
function cookieOpts(secure: boolean): {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** 签发会话凭据值（setSessionCookie 与测试装配共用——签名唯一出处）。 */
export function issueSessionValue(uid: string, tokenVersion: number, secret: string): string {
  return signSession({ v: 1, uid, tv: tokenVersion, exp: Date.now() + SESSION_TTL_MS }, secret);
}

/** 发会话 cookie（注册/登录/改密续签/滑动续签共用同一出处）。 */
export function setSessionCookie(
  reply: FastifyReply,
  uid: string,
  tokenVersion: number,
  secret: string,
): void {
  const secure = reply.request.protocol === "https" || process.env.SESSION_COOKIE_SECURE === "1";
  reply.setCookie(SESSION_COOKIE, issueSessionValue(uid, tokenVersion, secret), cookieOpts(secure));
}

/** 清会话 cookie（登出；幂等，未登录调用也 204）。 */
export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export interface SessionAuthDeps {
  registry: RegistryDb;
  secret: string;
  /** 解析（必要时惰性装配）uid 对应空间——由 SpaceHub 提供。 */
  ensureSpace: (uid: string) => Promise<Space>;
}

/** 受保护作用域的 preHandler：验 cookie → 读账户（存在 / active / tv 匹配）→ 装配空间 → 挂 request.space。
 *  失败一律 401「未登录」（**细分只进日志**：签名坏/uid 不存在=warn、停用=info；见 contracts/http.md 失败矩阵）。 */
export function makeSessionAuth(deps: SessionAuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    /** 六态统一拒绝（`deny` 单出处——话术只有一份，simplify 收敛）。 */
    const deny = (): FastifyReply => reply.code(401).send({ error: "未登录" });
    const raw = req.cookies[SESSION_COOKIE];
    if (raw === undefined) return deny();
    const payload = parseSession(raw, deps.secret);
    if (payload === null) {
      req.log.warn("会话 cookie 签名/格式非法（可能被篡改）");
      return deny();
    }
    if (payload.exp <= Date.now()) return deny();
    const account = getAccountByUid(deps.registry, payload.uid);
    if (account === undefined) {
      req.log.warn(`会话指向不存在的账户 uid=${payload.uid}`);
      return deny();
    }
    if (account.status !== "active") {
      req.log.info(`停用账户的会话被拒 uid=${payload.uid}`);
      return deny();
    }
    if (account.tokenVersion !== payload.tv) return deny();
    // 滑动续签：剩余不足半程时随本次响应重发（登录态不断线）
    if (payload.exp - Date.now() < RENEW_BELOW_MS) {
      setSessionCookie(reply, account.uid, account.tokenVersion, deps.secret);
    }
    req.space = await deps.ensureSpace(account.uid);
  };
}
