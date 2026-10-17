import type { FastifyInstance } from "fastify";
import { runInTransaction } from "../storage/db";
import * as repo from "../storage/repo";
import { deriveTrashed } from "../application/trash";

// 回收站路由（007）：列表 + 「一键清理 >15d」。库从 `req.space.db` 取（受保护作用域，
// 与 items 路由同一保证——不存在「未鉴权可到」的形态）。
// 彻底删只发生在清理环节且 >15d 才清理；raw_inputs/fragments/uncertain_inputs 不受影响。

/** 注册回收站资源路由（GET 列表 / POST purge）。 */
export function registerTrashRoutes(app: FastifyInstance): void {
  app.get("/api/trash", async (req) => deriveTrashed(req.space.db));

  // 一键清理（用户显式触发，无定时任务）：物理清除 trashed 超过 15 天的信息，
  // 删前 stderr 留痕（repo.purgeTrashed 负责，红线「不许静默」）。
  app.post("/api/trash/purge", async (req) => {
    return runInTransaction(req.space.db, (tx) => repo.purgeTrashed(tx));
  });
}
