import { ConfirmBodySchema, GetItemArgsSchema, itemName, type Item } from "@summarizing/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";

// items 资源路由（D-73 routes 拆分触发器执行时自 app.ts 迁入）：
// GET 详情 + 用户手动写口 complete·reopen·confirm。「补充元素」走前台对话（D-60），无表单路由。

/** 本组路由的窄依赖（不 import app.ts → 无循环）。 */
export interface ItemRouteDeps {
  db: Db;
}

/** 用户手动状态动作（标完成/归档，D-83）公共体：追加状态版本节点并返回派生结果；
 *  事项不存在返回 null（调用方映射 404）。`user:手动` 直发版本链，不经 agent0 变更词表。
 *  reopen 有独立语义（撤回归档不改完成状态），不走此公共体。 */
function manualSetStatus(
  db: Db,
  id: string,
  action: "complete_item" | "archive_item",
  status: Item["status"],
): Item | null {
  const item = repo.deriveItem(db, id);
  if (item === null) return null;
  const verb = action === "complete_item" ? "标完成" : "归档";
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
export function registerItemRoutes(app: FastifyInstance, deps: ItemRouteDeps): void {
  app.get("/api/items/:id", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    // 派生失败（如存量脏数据）降级为 404 而非 500——不静默，但也不让详情页整站崩
    const full = repo.getItemFull(deps.db, id);
    if (!full) return reply.code(404).send({ error: "事项不存在" });
    return full;
  });

  app.post("/api/items/:id/complete", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const next = manualSetStatus(deps.db, id, "complete_item", "done");
    if (next === null) return reply.code(404).send({ error: "事项不存在" });
    return next;
  });

  // 恢复待办/撤回归档（D-82/D-83 二轮）：已完成行 → 恢复为待办；
  // 已归档行 → 只撤归档、回到归档前的状态（完成状态保留，不强制回待办）。
  // 撤回前的状态从版本链取（repo.preArchivedStatus）；与 complete 一致不做前置检查，重复操作只是多留痕迹
  app.post("/api/items/:id/reopen", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const item = repo.deriveItem(deps.db, id);
    if (!item) return reply.code(404).send({ error: "事项不存在" });
    const restoring = item.status === "archived" ? repo.preArchivedStatus(deps.db, id) : null;
    const verb = item.status === "archived" ? "撤回归档" : "恢复待办";
    repo.appendItemVersion(deps.db, {
      itemId: id,
      action: "reopen_item",
      detail: `${verb}「${itemName(item.elements)}」`,
      snapshot: { ...item, status: restoring ?? "todo" },
      by: { actor: "用户", model: null },
    });
    return repo.deriveItem(deps.db, id);
  });

  // 标记已查看（用户 2026-09-27：「新」微标点开即消）：幂等，重复标记无副作用
  app.post("/api/items/:id/viewed", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    if (!repo.itemExists(deps.db, id)) return reply.code(404).send({ error: "事项不存在" });
    repo.markItemViewed(deps.db, id);
    return reply.code(204).send();
  });

  // 归档（D-83 最小归档提前自信源阶段）：todo/done → archived，直接进看板归档段；
  // 不删不隐藏（Replay 精神），恢复走 reopen
  app.post("/api/items/:id/archive", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const next = manualSetStatus(deps.db, id, "archive_item", "archived");
    if (next === null) return reply.code(404).send({ error: "事项不存在" });
    return next;
  });

  app.post("/api/items/:id/confirm", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const item = repo.deriveItem(deps.db, id);
    if (!item) return reply.code(404).send({ error: "事项不存在" });
    const body = ConfirmBodySchema.parse(req.body ?? {});
    repo.appendItemVersion(deps.db, {
      itemId: id,
      action: "resolve_doubt",
      detail: `手动确认存疑解除${body.note ? `：${body.note}` : ""}`,
      snapshot: { ...item, doubtNote: null },
      by: { actor: "用户", model: null },
    });
    return repo.deriveItem(deps.db, id);
  });
}
