import { ConfirmBodySchema, GetItemArgsSchema } from "@summarizing/shared";
import type { FastifyInstance } from "fastify";
import * as repo from "../storage/repo";
import { manualActionHttp, manualSetStatus, restoreFromTrash } from "../application/itemStatus";

// items 资源路由（D-73 拆分时自 app.ts 迁入；006 起依赖来自请求上下文）：
// GET 详情 + 用户手动写口 complete·reopen·confirm。「补充元素」走前台对话（D-60），无表单路由。
// 库从 `req.space.db` 取——受保护作用域的 preHandler 已挂 space，本组路由不存在「未鉴权可到」的形态。
//
// 状态动作的守卫与落笔在 `application/itemStatus.ts`：与对外 v1（routes/v1.ts）共用同一份，
// 两处各写一遍时已经漂移过（trash 有幂等守卫、complete 没有）。

/** 账户本人的署名。 */
const BY_USER = { actor: "用户", model: null } as const;

/** 领域错误 → HTTP 响应（文案与状态码的唯一出处在 itemStatus）。 */
function sendManualStatusError(
  reply: { code: (n: number) => { send: (b: { error: string }) => unknown } },
  error: Parameters<typeof manualActionHttp>[0],
): unknown {
  const { code, error: message } = manualActionHttp(error);
  return reply.code(code).send({ error: message });
}

/** 注册 items 资源路由（GET 详情 / complete / reopen / trash / restore / viewed / confirm）。 */
export function registerItemRoutes(app: FastifyInstance): void {
  app.get("/api/items/:id", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    // 派生失败（如存量脏数据）降级为 404 而非 500——不静默，但也不让详情页整站崩
    const full = repo.getItemFull(req.space.db, id);
    if (!full) return reply.code(404).send({ error: "事项不存在" });
    return full;
  });

  app.post("/api/items/:id/complete", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const next = manualSetStatus(req.space.db, id, "complete_item", BY_USER);
    if (!next.ok) return sendManualStatusError(reply, next.error);
    return next.item;
  });

  // 恢复待办：已完成行 → 恢复为待办（与 complete 对称，重复操作只是多留痕迹）
  // 守卫与 complete 同款：回收站条目不可写（先恢复）、通知没有"待办"可言（409）
  app.post("/api/items/:id/reopen", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const next = manualSetStatus(req.space.db, id, "reopen_item", BY_USER);
    if (!next.ok) return sendManualStatusError(reply, next.error);
    return next.item;
  });

  // 删除（007 回收站）：追加 trashed 版本——进回收站、可恢复，不物理删（Replay 精神）。
  // 一步到位、不弹确认（可复活，与完成同款）；重复删除幂等（已在回收站则不追加无意义版本）。
  app.post("/api/items/:id/trash", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const next = manualSetStatus(req.space.db, id, "trash_item", BY_USER);
    if (!next.ok) return sendManualStatusError(reply, next.error);
    return next.item;
  });

  // 从回收站恢复（007）：status 回到删前的值（版本链取，含 done/通知的 todo）。
  // 幂等语义与删除对齐：不在回收站的条目「恢复」= no-op，不追加无意义版本。
  app.post("/api/items/:id/restore", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const next = restoreFromTrash(req.space.db, id, BY_USER);
    if (!next.ok) return sendManualStatusError(reply, next.error);
    return next.item;
  });

  // 标记已查看（用户 2026-09-27：「新」微标点开即消）：幂等，重复标记无副作用
  app.post("/api/items/:id/viewed", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    if (!repo.itemExists(req.space.db, id)) return reply.code(404).send({ error: "事项不存在" });
    repo.markItemViewed(req.space.db, id);
    return reply.code(204).send();
  });

  app.post("/api/items/:id/confirm", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const item = repo.deriveItem(req.space.db, id);
    if (!item) return reply.code(404).send({ error: "事项不存在" });
    // 回收站条目不可写（OQ-12）：要改先从回收站恢复
    if (item.status === "trashed") return sendManualStatusError(reply, "trashed");
    const body = ConfirmBodySchema.parse(req.body ?? {});
    repo.appendItemVersion(req.space.db, {
      itemId: id,
      action: "resolve_doubt",
      detail: `手动确认存疑解除${body.note ? `：${body.note}` : ""}`,
      snapshot: { ...item, doubtNote: null },
      by: { actor: "用户", model: null },
    });
    return repo.deriveItem(req.space.db, id);
  });
}
