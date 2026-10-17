import { ConfirmBodySchema, GetItemArgsSchema, itemName, type Item } from "@summarizing/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";

// items 资源路由（D-73 拆分时自 app.ts 迁入；006 起依赖来自请求上下文）：
// GET 详情 + 用户手动写口 complete·reopen·confirm。「补充元素」走前台对话（D-60），无表单路由。
// 库从 `req.space.db` 取——受保护作用域的 preHandler 已挂 space，本组路由不存在「未鉴权可到」的形态。

/** 用户手动状态动作（标完成）公共体：追加状态版本节点并返回派生结果；
 *  事项不存在返回 null（调用方映射 404）。`user:手动` 直发版本链，不经 agent0 变更词表。
 *  reopen 有独立语义（恢复到待办），不走此公共体。 */
function manualSetStatus(
  db: Db,
  id: string,
  action: "complete_item",
  status: Item["status"],
): Item | null {
  const item = repo.deriveItem(db, id);
  if (item === null) return null;
  const verb = action === "complete_item" ? "标完成" : "";
  repo.appendItemVersion(db, {
    itemId: id,
    action,
    detail: `${verb}「${itemName(item.elements)}」`,
    snapshot: { ...item, status },
    by: { actor: "用户", model: null },
  });
  return repo.deriveItem(db, id);
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
    if (next === null) return reply.code(404).send({ error: "事项不存在" });
    return next;
  });

  // 恢复待办：已完成行 → 恢复为待办（与 complete 对称，重复操作只是多留痕迹）
  app.post("/api/items/:id/reopen", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const item = repo.deriveItem(req.space.db, id);
    if (!item) return reply.code(404).send({ error: "事项不存在" });
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

  // 从回收站恢复（007）：status 回到删前的值（版本链取，含 done/通知的 todo）
  app.post("/api/items/:id/restore", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const item = repo.deriveItem(req.space.db, id);
    if (!item) return reply.code(404).send({ error: "事项不存在" });
    repo.appendItemVersion(req.space.db, {
      itemId: id,
      action: "restore_item",
      detail: `从回收站恢复「${itemName(item.elements)}」`,
      snapshot: { ...item, status: repo.preTrashStatus(req.space.db, id) },
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
