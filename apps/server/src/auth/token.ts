import type { FastifyReply, FastifyRequest } from "fastify";
import { getAccountByToken, type RegistryDb } from "../storage/registry";
import type { Space } from "../spaces";

// 对外接口（v1）的令牌鉴权（D-139）：`Authorization: Bearer <接入令牌>`。
//
// 为什么**不**复用会话 cookie 的 `makeSessionAuth`：会话 hook 覆盖整个 `/api/*`，
// 一旦令牌能过那道闸，拿到进站地址的人就能顺手读 `GET /api/settings/ai`（明文 AI key）、
// 调 `POST /api/auth/source-token/rotate` 把你自己锁在门外。所以 v1 走**独立作用域**，
// 只挂它自己的一条白名单路由组——设置面与认证面永远不在其中。
//
// 令牌只走 header、不进 URL：日志与浏览器历史里都不会留（webhook 网关是反例，那边只能进路径）。

export interface TokenAuthDeps {
  registry: RegistryDb;
  /** 解析（必要时惰性装配）uid 对应空间——由 SpaceHub 提供。 */
  ensureSpace: (uid: string) => Promise<Space>;
}

/** 从 Authorization 头取 Bearer 令牌；形状不对返回 null（不抛）。 */
function bearerOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** 受保护 v1 作用域的 onRequest：验 Bearer → 查账户（存在 / active）→ 装配空间 → 挂 request.space。
 *  失败一律 401「接入令牌无效」——不区分「没有这个令牌」与「账户已停用」（不泄露账户状态）。 */
export function makeTokenAuth(deps: TokenAuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    /** 统一拒绝（话术只有一份）。 */
    const deny = (): FastifyReply => reply.code(401).send({ error: "接入令牌无效" });
    const token = bearerOf(req.headers.authorization);
    if (token === null) return deny();
    // 按值精确查询即校验：查不到 = 令牌不对。用 SQLite 索引查找，不做逐字符比对。
    const account = getAccountByToken(deps.registry, token);
    if (account === undefined) {
      req.log.warn("v1 接入令牌无效（无匹配账户）");
      return deny();
    }
    if (account.status !== "active") {
      req.log.info(`停用账户的 v1 请求被拒 uid=${account.uid}`);
      return deny();
    }
    req.space = await deps.ensureSpace(account.uid);
  };
}
