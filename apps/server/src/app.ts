import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { z } from "zod";
import { ChatRequestSchema, errText, IngestRequestSchema } from "@summarizing/shared";
import { getSessionSecret, type RegistryDb } from "./storage/registry";
import { withTimeout } from "./shared/timeout";
import * as repo from "./storage/repo";
import { retryRawInput } from "./agent0/digest";
import { ingestBatch } from "./application/ingest";
import { handleChat } from "./application/chat";
import { buildBoard } from "./application/board";
import { deriveNotices } from "./application/notice";
import { makeSessionAuth } from "./auth/session";
import { registerAuthPublicRoutes, registerAuthSessionRoutes } from "./routes/auth";
import { registerItemRoutes } from "./routes/items";
import { registerTrashRoutes } from "./routes/trash";
import { registerPipelineRoutes } from "./routes/pipeline";
import { registerSourceRoutes } from "./routes/sources";
import { registerSettingsRoutes } from "./routes/settings";
import { registerUncertainRoutes } from "./routes/uncertain";
import type { SpaceHub } from "./spaces";

// 装配 HTTP 应用（006 多用户重构）：
// ① 公开面 = 认证三端点（register/login/logout）+ webhook 网关（令牌鉴权）——除此之外全部 401；
// ② 受保护面 = 一个**封装作用域**：作用域级 preHandler 验会话并挂 `req.space`——路由只读
//    `req.space.db`，结构上不可能「某条路由漏挂鉴权」（漏挂的路由根本访问不到数据）。
// 信源不认识本文件（D-88）：装配在 spaces.ts 按空间进行，webhook 经网关分发。

/** 关停超时：close 挂起时按超时继续走保底退出——与信源 start 的 START_TIMEOUT_MS 对称：
 *  任何一侧挂起都不许拖住 Ctrl-C。（空间 stop 由 index 的 closeAll 走同一超时。） */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** URL 路径里的批次 id 参数（重试口）。与 shared 的 GetItemArgsSchema 分开是刻意的：
 *  那是 get_item 工具的跨边界契约（住 shared），这只是 server 内部 HTTP 细节——schema 住在使用它的边界。 */
const RawIdParamsSchema = z.object({ id: z.string() });

/** 对话历史查询参数（L16）：limit = 回填多少轮，默认 50、上限 200。 */
const ChatHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** webhook 网关参数：token 定空间、source + 通配定处理器。 */
const HookParamsSchema = z.object({ token: z.string(), source: z.string(), "*": z.string() });

/** 日志用 URL 脱敏：令牌段整体替换为 `***`（FR-008：令牌不进日志明文）。导出给测试断言同一出处。 */
export function redactHookUrl(url: string): string {
  return url.replace(/^\/hook\/[^/?#]+/, "/hook/***");
}

/** webhook 网关（唯一信源 HTTP 入口，FR-008）：token 定空间（含 active 校验）→
 *  (源名, method, 相对路径) 定处理器。无/错/停用令牌 → 401 且**零落库**（先鉴权后路由）；
 *  未登记的源/路径 → 404。令牌在 URL 路径——其上日志脱敏见 serializer。 */
function registerWebhookGateway(app: FastifyInstance, hub: SpaceHub): void {
  app.route({
    method: ["GET", "POST", "PUT", "DELETE"],
    url: "/hook/:token/:source/*",
    handler: async (req, reply) => {
      const parsed = HookParamsSchema.safeParse(req.params);
      if (!parsed.success) return reply.code(404).send({ error: "Not Found" });
      const space = await hub.byToken(parsed.data.token);
      if (space === undefined) {
        req.log.warn("webhook 接入令牌无效（无匹配或账户停用）");
        return reply.code(401).send({ error: "接入令牌无效" });
      }
      const path = `/${parsed.data["*"]}`;
      const route = space.webhookRoutes.find(
        (r) => r.source === parsed.data.source && r.method === req.method && r.path === path,
      );
      if (route === undefined) return reply.code(404).send({ error: "Not Found" });
      return route.handler(req, reply);
    },
  });
}

/** 装配 HTTP 应用（只装 core——不认识信源；信源在空间装配里上岗）。 */
export function makeApp(deps: { registry: RegistryDb; hub: SpaceHub }) {
  const app = Fastify({
    logger: {
      serializers: {
        // 请求日志：/hook 令牌脱敏；其余字段维持 Fastify 默认形状
        req(request: FastifyRequest) {
          return {
            method: request.method,
            url: redactHookUrl(request.url),
            host: request.hostname,
            remoteAddress: request.ip,
          };
        },
      },
    },
    // Caddy 反代后取真实来源 IP（限速用）；前提：应用端口绝不可直暴公网（部署注意 R12）
    trustProxy: process.env.TRUST_PROXY === "1",
  });
  void app.register(cookie);
  const secret = getSessionSecret(deps.registry);

  // 基础安全头（006 安全审视）：nosniff / Referrer-Policy: same-origin（防邀请码经 referrer 出站）/
  // 禁嵌框；API 响应 no-store（防共享设备浏览器缓存残留）。CSP 留批次 3（需对 Vite 产物实测）。
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    return payload;
  });

  // ── 公开面 ──
  registerAuthPublicRoutes(app, { registry: deps.registry, hub: deps.hub, secret });
  registerWebhookGateway(app, deps.hub);

  // ── 受保护面（封装作用域：preHandler 一次挂全；路由只读 req.space）──
  void app.register(async (scope) => {
    scope.addHook(
      "preHandler",
      makeSessionAuth({
        registry: deps.registry,
        secret,
        ensureSpace: (uid) => deps.hub.ensure(uid),
      }),
    );

    scope.post("/api/ingest", async (req, reply) => {
      const parsed = IngestRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "请求体不合法", issues: parsed.error.issues });
      }
      // 进站装配唯一出处（application/ingest.ts）：先落盘后异步消化
      const space = req.space;
      const { raw, digestState } = ingestBatch(
        space.db,
        space.llmRef,
        space.tools,
        parsed.data,
        "ingest-api",
        (msg) => req.log.error(msg),
      );
      // digestState 来自 kickDigest 的置位结果——不报发射前快照（七轮评审）
      return reply.code(202).send({ id: raw.id, digestState });
    });

    scope.get("/api/board", async (req) => buildBoard(req.space.db));

    // 通知页（007）：kind=notice 的独立查看入口——不进看板三段
    scope.get("/api/notices", async (req) => deriveNotices(req.space.db));

    // 对话历史回填（L16）：持久化的轮次，前端启动时拉回——解「刷新/换设备对话即失」。
    scope.get("/api/chat/history", async (req) => {
      const { limit } = ChatHistoryQuerySchema.parse(req.query);
      return { turns: repo.listRecentChatTurns(req.space.db, limit) };
    });

    scope.post("/api/chat", async (req, reply) => {
      const parsed = ChatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "请求体不合法", issues: parsed.error.issues });
      }
      const client = req.space.llmRef.current;
      return handleChat(
        req.space.db,
        client,
        client.modelTag,
        parsed.data.message,
        parsed.data.history,
        parsed.data.mentions,
      );
    });

    // 失败批次重试（D-71）：领域函数拥有 failed→pending 跃迁与「仅 failed」前置；
    // 路由只做参数解析与状态码映射（404 不存在 / 409 非 failed / 202 受理）。
    scope.post("/api/raw/:id/retry", async (req, reply) => {
      const { id } = RawIdParamsSchema.parse(req.params);
      const client = req.space.llmRef.current;
      const result = retryRawInput(req.space.db, client, req.space.tools, client.modelTag, id);
      if (!result.ok) {
        return result.reason === "not_found"
          ? reply.code(404).send({ error: "批次不存在" })
          : reply.code(409).send({ error: "只有「未处理」批次可以重试" });
      }
      // digestState 来自 kickDigest 的置位结果——不报发射前快照（七轮评审）
      return reply.code(202).send({ id, digestState: result.digestState });
    });

    registerAuthSessionRoutes(scope, { registry: deps.registry, secret });
    registerItemRoutes(scope);
    registerPipelineRoutes(scope);
    registerSettingsRoutes(scope);
    registerSourceRoutes(scope);
    registerUncertainRoutes(scope);
    registerTrashRoutes(scope);
  });

  return app;
}

/** 关停收尾（D-88「SIGINT 归 core」的可测内核）：**永不无限等待、永不 reject**——
 *  close 失败只留痕；挂起（某信源 stop/清理项永不 settle）按 SHUTDOWN_TIMEOUT_MS 判超时。
 *  退出保证由 `exitAfter` 兜底。index.ts 的 SIGINT 处理 = `exitAfter(gracefulClose(app))`。 */
export async function gracefulClose(app: FastifyInstance): Promise<void> {
  try {
    await withTimeout(
      // close 中途失败时 Fastify 不再跑剩余 onClose hook——留痕可见，但仍要退出（见 exitAfter）
      app.close().catch((err) => {
        process.stderr.write(`[shutdown] app.close 失败（尽力退出）：${errText(err)}\n`);
      }),
      SHUTDOWN_TIMEOUT_MS,
      `关停超时(${SHUTDOWN_TIMEOUT_MS / 1000}s，保底退出)`,
    );
  } catch (err) {
    process.stderr.write(`[shutdown] ${errText(err)}\n`);
  }
}

/** 保底退出：无论收尾成败，最终都 exit(0)——process.on("SIGINT") 一旦注册就覆盖 Node 默认
 *  「收到即退出」，这里不退出 = Ctrl-C 停不掉进程（评审 C1 的回归守卫就在这条上）。 */
export function exitAfter(p: Promise<void>): Promise<void> {
  return p.finally(() => process.exit(0));
}
