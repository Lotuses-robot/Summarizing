import { ConfirmBodySchema, GetItemArgsSchema, itemName, type Item } from "@summarizing/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";

// items 资源路由（D-73 拆分时自 app.ts 迁入；006 起依赖来自请求上下文）：
// GET 详情 + 用户手动写口 complete·reopen·confirm。「补充元素」走前台对话（D-60），无表单路由。
// 库从 `req.space.db` 取——受保护作用域的 preHandler 已挂 space，本组路由不存在「未鉴权可到」的形态。

/** 手动状态动作的失败原因（路由层守状态不变量；围栏只管模型侧写路径，见 fence.ts）。 */
type ManualStatusError = "not_found" | "trashed" | "notice";

/** 用户手动状态动作（标完成）公共体：追加状态版本节点并返回派生结果。
 *  `ok:false` 时调用方按 error 映射 HTTP（404 / 409）——回收站条目不可写（OQ-12），
 *  通知不参与完成演化（US2-2，按 kind 判）。 */
function manualSetStatus(
  db: Db,
  id: string,
  action: "complete_item",
  status: Item["status"],
): { ok: true; item: Item } | { ok: false; error: ManualStatusError } {
  const item = repo.deriveItem(db, id);
  if (item === null) return { ok: false, error: "not_found" };
  if (item.status === "trashed") return { ok: false, error: "trashed" };
  if (action === "complete_item" && item.kind === "notice") return { ok: false, error: "notice" };
  repo.appendItemVersion(db, {
    itemId: id,
    action,
    detail: `标完成「${itemName(item.elements)}」`,
    snapshot: { ...item, status },
    by: { actor: "用户", model: null },
  });
  return { ok: true, item: repo.deriveItem(db, id) ?? item };
}

/** 手动状态动作的错误码 → HTTP 响应（同一套文案，端点共用）。 */
function sendManualStatusError(
  reply: { code: (n: number) => { send: (b: { error: string }) => unknown } },
  error: ManualStatusError,
): unknown {
  if (error === "not_found") return reply.code(404).send({ error: "事项不存在" });
  if (error === "trashed") {
    return reply.code(409).send({ error: "这条在回收站里——请先恢复再操作" });
  }
  return reply.code(409).send({ error: "通知不参与完成——它没有完成状态" });
}

/** 注册 items 资源路由（GET 详情 / complete / reopen / confirm）。 */
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
    const next = manualSetStatus(req.space.db, id, "complete_item", "done");
    if (!next.ok) return sendManualStatusError(reply, next.error);
    return next.item;
  });

  // 恢复待办：已完成行 → 恢复为待办（与 complete 对称，重复操作只是多留痕迹）
  // 守卫与 complete 同款：回收站条目不可写（先恢复）、通知没有"待办"可言（409）
  app.post("/api/items/:id/reopen", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const item = repo.deriveItem(req.space.db, id);
    if (!item) return reply.code(404).send({ error: "事项不存在" });
    if (item.status === "trashed") return sendManualStatusError(reply, "trashed");
    if (item.kind === "notice") return sendManualStatusError(reply, "notice");
    repo.appendItemVersion(req.space.db, {
      itemId: id,
      action: "reopen_item",
      detail: `恢复待办「${itemName(item.elements)}」`,
      snapshot: { ...item, status: "todo" },
      by: { actor: "用户", model: null },
    });
    return repo.deriveItem(req.space.db, id);
  });

  // 删除（007 回收站）：追加 trashed 版本——进回收站、可恢复，不物理删（Replay 精神）。
  // 一步到位、不弹确认（可复活，与完成同款）；重复删除幂等（已在回收站则不追加无意义版本）。
  app.post("/api/items/:id/trash", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const item = repo.deriveItem(req.space.db, id);
    if (!item) return reply.code(404).send({ error: "事项不存在" });
    if (item.status !== "trashed") {
      repo.appendItemVersion(req.space.db, {
        itemId: id,
        action: "trash_item",
        detail: `删除「${itemName(item.elements)}」`,
        snapshot: { ...item, status: "trashed" },
        by: { actor: "用户", model: null },
      });
    }
    return repo.deriveItem(req.space.db, id);
  });

  // 从回收站恢复（007）：status 回到删前的值（版本链取，含 done/通知的 todo）。
  // 幂等语义与删除对齐：不在回收站的条目「恢复」= no-op，不追加无意义版本。
  app.post("/api/items/:id/restore", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const item = repo.deriveItem(req.space.db, id);
    if (!item) return reply.code(404).send({ error: "事项不存在" });
    if (item.status !== "trashed") return item; // 已在正常态：原样返回，不落版本
    const restoring = repo.preTrashStatus(req.space.db, id);
    if (restoring === null) {
      // 删前状态不可考（整条链全 trashed/异常）——不编造 todo，如实拒
      return reply.code(409).send({ error: "删前状态不可考，无法恢复（数据异常）" });
    }
    repo.appendItemVersion(req.space.db, {
      itemId: id,
      action: "restore_item",
      detail: `从回收站恢复「${itemName(item.elements)}」`,
      snapshot: { ...item, status: restoring },
      by: { actor: "用户", model: null },
    });
    return repo.deriveItem(req.space.db, id);
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
