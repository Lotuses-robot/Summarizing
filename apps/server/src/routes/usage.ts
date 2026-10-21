import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { UsageRangeSchema, type UsageRange } from "@summarizing/shared";
import * as repo from "../storage/repo";
import { beijingDayStart } from "../shared/time";

// Token 用量查询端点（010）：只读聚合本账户库——活动栏「用量」仪表盘的唯一数据源。
// 范围口径 = **北京墙钟的日历日**：today = 今日 00:00 起；7d = 含今日的 7 个日历日；30d 同理。
// 日历日而非 7×24 小时：用户看「近 7 天」时想的是天，不是精确到秒的滚动窗口。

/** 范围天数（今日含在内）。 */
function rangeDays(range: UsageRange): number {
  return range === "today" ? 1 : range === "7d" ? 7 : 30;
}

/** 范围起点（北京墙钟）：今日午夜往回推 N−1 天（日期算术的单一出处是 shared/time 的 beijingDayStart）。 */
function rangeStart(range: UsageRange, now: Date): string {
  return beijingDayStart(now, rangeDays(range) - 1);
}

/** 查询参数（运行时数据一律 zod 解析，不用 `as`）：range 缺席 = 近 7 天，非法 = 400。 */
const UsageQuerySchema = z.object({ range: UsageRangeSchema.default("7d") });

/** 注册用量路由（受保护面）：GET /api/usage?range=。range 非法 → 400（安全报错，不由 Fastify 兜）。 */
export function registerUsageRoutes(app: FastifyInstance): void {
  app.get("/api/usage", async (req, reply) => {
    const parsed = UsageQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "range 取值只能是 today / 7d / 30d" });
    }
    const range = parsed.data.range;
    const since = rangeStart(range, new Date());
    return { range, ...repo.sumLlmUsage(req.space.db, since) };
  });
}
