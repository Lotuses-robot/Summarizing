import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { UncertainStatus } from "@summarizing/shared";
import { sweepUncertainLibrary } from "../agent0/sweep";
import * as repo from "../storage/repo";
import { nowLocalWallClock } from "../shared/time";

// 存疑信息库查询端点（D-85/D-88；006 起依赖来自请求上下文）：GET 全库（按状态筛，人工通道
// needsHuman 倒序）；POST sweep 触发清扫循环（用本空间的库与 llm——清扫归本账户）；
// PUT /:id 人工移除（审核页的移除图标走这里，处置为 discarded）。

const QuerySchema = z.object({ status: UncertainStatus.default("open") });
const IdParamsSchema = z.object({ id: z.string() });

/** 注册存疑信息库路由：GET 查询（人工通道排序）/ POST sweep 触发清扫 / PUT /:id 人工移除。 */
export function registerUncertainRoutes(app: FastifyInstance): void {
  app.get("/api/uncertain", async (req) => {
    const parsed = QuerySchema.parse(req.query);
    return repo.listUncertainByStatus(req.space.db, parsed.status);
  });

  // 清扫循环：与旧实现同调用形态，但源点改为本空间（每人清自己库、用自己 key）
  app.post("/api/uncertain/sweep", async (req) => {
    const space = req.space;
    return sweepUncertainLibrary(
      space.db,
      space.llmRef.current,
      space.llmRef.current.modelTag,
      "api",
    );
  });

  // 人工移除（D-88 T4）：审核页图标直调——拿不准的条目看一眼就清掉，不必等 AI 清扫。
  // 复用 resolveUncertainInput 的 open 原子前置：404 不存在 / 409 已处置（并发不复活）。
  app.put("/api/uncertain/:id", async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    const exists = repo.getUncertainInput(req.space.db, id);
    if (exists === null) {
      return reply.code(404).send({ error: "条目不存在" });
    }
    const resolved = repo.resolveUncertainInput(req.space.db, {
      id,
      status: "discarded",
      resolvedRef: "manual",
      resolvedAt: nowLocalWallClock(),
    });
    if (!resolved) {
      return reply.code(409).send({ error: "条目已被处置" });
    }
    return reply.code(204).send();
  });
}
