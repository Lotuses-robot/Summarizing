import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  RouterBindingsInputSchema,
  RouterEnabledInputSchema,
  RouterAccountViewSchema,
} from "@summarizing/shared";
import type { RegistryDb } from "../storage/registry";
import type { RelayIngress } from "../router";

// 账户侧的 Router 入口（D-130 / D-134）：**每个接入一组**——收不收、我的绑定码是什么。
//
// 凭据不在这（部署方的事，走 `npm run admin -- router:set`）。之所以账户侧还要一个自己的口子：
// 客户把绑定码给账户主人后，他得有个地方把它填进去；而「先别给我送」也得他自己能按。
//
// ⚠️ 这一层**不认识任何具体的接入**：分组、标题、说明、绑定表、开关全部来自
// `router.ingresses()` 的声明。加一个新接入（校内新闻…）时本文件一行都不用改——
// 这正是 D-134 要的低耦合。
//
// ⚠️ 绑定表是**部署级**的（每个接入一张，全局唯一），所以这里做的是「改我这一份」——
// 请求只能影响 `req.space.uid` 自己的绑定，看不到别人的（列表按 uid 过滤，写入时 uid 由会话定，
// 不接受请求体指定归属）。

/** 路径参数：接入名。 */
const KindParamsSchema = z.object({ kind: z.string().min(1) });

/** 注册 Router 的账户侧路由。
 *
 *  入参 `registry` = 系统库（绑定表与开关都是部署级的，不在 `req.space.db` 里）；
 *  `ingresses` = 已上岗的接入（**取它们的声明与存储**，不在这里写死任何接入名）。
 */
export function registerRouterRoutes(
  app: FastifyInstance,
  deps: {
    registry: RegistryDb;
    ingresses: () => RelayIngress[];
    log: (msg: string) => void;
  },
): void {
  /** 按接入名找接入；找不到返回 undefined（→ 404，不猜一个默认接入）。 */
  const find = (kind: string): RelayIngress | undefined =>
    deps.ingresses().find((ing) => ing.name === kind);

  // 我的路由视图：每个接入一组（开关 + 我名下的绑定码）
  app.get("/api/router", async (req) => {
    const uid = req.space.uid;
    return RouterAccountViewSchema.parse({
      channels: deps.ingresses().map((ing) => ({
        kind: ing.name,
        label: ing.label,
        description: ing.description,
        enabled: ing.delivery.isEnabled(uid),
        bindings: ing.bindings.listFor(uid),
      })),
    });
  });

  // 整段覆盖我在某接入下的绑定码：算增删 → 增的绑给我、删的解绑
  app.put("/api/router/:kind/bindings", async (req, reply) => {
    const params = KindParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "接入名不合法" });
    const ing = find(params.data.kind);
    if (ing === undefined) return reply.code(404).send({ error: "没有这个接入" });

    const parsed = RouterBindingsInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "请求体不合法" });

    const uid = req.space.uid;
    const next = new Set(parsed.data.bindings);
    const current = ing.bindings.listFor(uid);

    // 先解绑：把一个码从「我这儿」拿走，再（如果是别人转给的我）绑过来
    for (const code of current) {
      if (!next.has(code)) ing.bindings.remove(code);
    }
    // 再绑定：**别人的码**转过来了就改绑（后写为准，绑定表自己会留痕）
    for (const code of next) ing.bindings.set(code, uid);

    deps.log(`[router:${ing.name}] 账户 ${uid} 的绑定码已更新（${next.size} 条）`);
    return { ok: true };
  });

  // 某接入的分发开关（关掉时该接入回「暂不可用」，不删绑定——语义见 router/store.ts）
  app.put("/api/router/:kind/enabled", async (req, reply) => {
    const params = KindParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "接入名不合法" });
    const ing = find(params.data.kind);
    if (ing === undefined) return reply.code(404).send({ error: "没有这个接入" });

    const parsed = RouterEnabledInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "请求体不合法" });
    ing.delivery.set(req.space.uid, parsed.data.enabled);
    return { ok: true };
  });
}
