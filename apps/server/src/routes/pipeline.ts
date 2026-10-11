import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PipelineRunDetailSchema } from "@summarizing/shared";
import * as repo from "../storage/repo";

// 流水读口（specs/005，C2；006 起依赖来自请求上下文）：进站台账 + 单批详情——纯只读，
// 数据全来自 raw_inputs（原文档案）与 pipeline_events（批次流水）。库从 `req.space.db` 取。

/** 列表 query：limit = 台账条数（默认 50，上限 200——与 chat history 上限同源）。 */
const ListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/** 详情 params：批次 id。 */
const IdParamsSchema = z.object({ id: z.string() });

/** 注册流水读口（GET /api/pipeline/runs、GET /api/pipeline/runs/:id）。 */
export function registerPipelineRoutes(app: FastifyInstance): void {
  app.get("/api/pipeline/runs", async (req) => {
    const { limit } = ListQuerySchema.parse(req.query);
    return { runs: repo.listPipelineRuns(req.space.db, limit) };
  });

  app.get("/api/pipeline/runs/:id", async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    const raw = repo.getRawInput(req.space.db, id);
    if (!raw) {
      return reply.code(404).send({ error: "批次不存在" });
    }
    // 契约在边界过 schema——字段漂移在此响亮表达（不静默发出坏形状）
    return PipelineRunDetailSchema.parse({
      raw,
      events: repo.listPipelineEvents(req.space.db, id),
    });
  });
}
