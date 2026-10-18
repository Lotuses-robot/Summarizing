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

  // 一键清理（用户显式触发，无定时任务）：物理清除 trashed 超过 15 天的信息。
  // 留痕在事务**提交成功后**写（回滚时不能留下"已彻底清除"的假痕——红线：留痕必须属实）。
  app.post("/api/trash/purge", async (req) => {
    const result = runInTransaction(req.space.db, (tx) => repo.purgeTrashed(tx));
    for (const { itemId, title, preStatus, trashedAt } of result.items) {
      process.stderr.write(
        `[trash] 彻底清除：「${title}」id=${itemId}（原状态 ${preStatus}，进入回收站 ${trashedAt}）\n`,
      );
    }
    return { purged: result.purged };
  });
}
