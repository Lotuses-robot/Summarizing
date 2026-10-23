import type { FastifyInstance } from "fastify";
import {
  RouterBindingsInputSchema,
  RouterEnabledInputSchema,
  RouterAccountViewSchema,
} from "@summarizing/shared";
import { listBindings, removeBinding, setBinding } from "../router/bindings";
import { isDeliveryEnabled, setDeliveryEnabled } from "../router/switch";
import type { RegistryDb } from "../storage/registry";

// 账户侧的 Router 入口（D-130）：**只管两件事**——收不收、我的绑定码是什么。
//
// 凭据不在这（部署方的事，走 `npm run admin -- router:set`）。之所以账户侧还要一个自己的口子：
// 客户把绑定码给账户主人后，他得有个地方把它填进去；而「先别给我送」也得他自己能按。
//
// ⚠️ 绑定表是**部署级**的（一张表，全局唯一），所以这里做的是「改我这一份」——
// 请求只能影响 `req.space.uid` 自己的绑定，看不到别人的（列表按 uid 过滤，写入时 uid 由会话定，
// 不接受请求体指定归属）。

/** 注册 Router 的账户侧路由。
 *
 *  入参 `registry` = 系统库（绑定表与开关都是部署级的，不在 `req.space.db` 里）。
 */
export function registerRouterRoutes(app: FastifyInstance, deps: { registry: RegistryDb }): void {
  // 我的 Router 视图：开关 + 我名下的绑定码
  app.get("/api/router", async (req) => {
    const uid = req.space.uid;
    return RouterAccountViewSchema.parse({
      enabled: isDeliveryEnabled(deps.registry, uid),
      bindings: listBindings(deps.registry)
        .filter((b) => b.uid === uid)
        .map((b) => b.externalUserId)
        .sort(),
    });
  });

  // 整段覆盖我的绑定码：算增删 → 增的绑给我、删的解绑
  app.put("/api/router/bindings", async (req, reply) => {
    const parsed = RouterBindingsInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "请求体不合法" });
    const uid = req.space.uid;
    const next = new Set(parsed.data.bindings);
    const current = listBindings(deps.registry).filter((b) => b.uid === uid);

    // 先解绑：把一个码从「我这儿」拿走，再（如果是别人转给的我）绑过来
    for (const b of current) {
      if (!next.has(b.externalUserId)) removeBinding(deps.registry, b.externalUserId);
    }
    // 再绑定：**别人的码**转过来了就改绑（后写为准，绑定表自己会留痕）
    for (const code of next) setBinding(deps.registry, code, uid);

    return { ok: true };
  });

  // 分发开关（关掉时 Router 回「暂不可用」，不删绑定——语义见 router/switch.ts）
  app.put("/api/router/enabled", async (req, reply) => {
    const parsed = RouterEnabledInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "请求体不合法" });
    setDeliveryEnabled(deps.registry, req.space.uid, parsed.data.enabled);
    return { ok: true };
  });
}
