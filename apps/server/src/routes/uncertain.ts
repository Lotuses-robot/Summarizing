import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { UncertainStatus } from "@summarizing/shared";
import type { Db } from "../storage/db";
import type { SweepResult } from "../agent0/sweep";
import * as repo from "../storage/repo";
import { nowLocalWallClock } from "../shared/time";

// 存疑信息库查询端点（D-85/D-88）：本期只挂接口不实现界面——前端批次直接消费。
// GET 全库（按状态筛，人工通道 needsHuman 倒序）；POST sweep 触发清扫循环；
// PUT /:id 人工移除（T4：审核页的移除图标走这里，处置为 discarded）。

const QuerySchema = z.object({ status: UncertainStatus.default("open") });
const IdParamsSchema = z.object({ id: z.string() });

/** 本组路由的窄依赖（不 import app.ts → 无循环）。 */
export interface UncertainRouteDeps {
  db: Db;
  /** 清扫触发（app.ts 注入清扫循环；未注入时 sweep 回 501——功能未接线如实相告）。 */
  sweep?: () => Promise<SweepResult>;
}

/** 注册存疑信息库路由：GET 查询（人工通道排序）/ POST sweep 触发清扫 / PUT /:id 人工移除。 */
export function registerUncertainRoutes(app: FastifyInstance, deps: UncertainRouteDeps): void {
  app.get("/api/uncertain", async (req) => {
    const parsed = QuerySchema.parse(req.query);
    return repo.listUncertainByStatus(deps.db, parsed.status);
  });

  app.post("/api/uncertain/sweep", async (_req, reply) => {
    if (!deps.sweep) {
      return reply.code(501).send({ error: "清扫循环未接线" });
    }
    const result = await deps.sweep();
    return reply.code(200).send(result);
  });

  // 人工移除（D-88 T4）：审核页图标直调——拿不准的条目看一眼就清掉，不必等 AI 清扫。
  // 复用 resolveUncertainInput 的 open 原子前置：404 不存在 / 409 已处置（并发不复活）。
  app.put("/api/uncertain/:id", async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    const exists = repo.getUncertainInput(deps.db, id);
    if (exists === null) {
      return reply.code(404).send({ error: "条目不存在" });
    }
    const resolved = repo.resolveUncertainInput(deps.db, {
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
