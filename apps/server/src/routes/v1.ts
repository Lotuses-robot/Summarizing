import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  errText,
  GetItemArgsSchema,
  GetRawArgsSchema,
  IngestRequestSchema,
  SearchItemsArgsSchema,
  SearchRawsArgsSchema,
  UncertainStatus,
  type RawInput,
} from "@summarizing/shared";
import * as repo from "../storage/repo";
import { buildBoard, listMentionables } from "../application/board";
import { deriveNotices } from "../application/notice";
import { deriveTrashed } from "../application/trash";
import { ingestBatch } from "../application/ingest";
import { makeAgentTools } from "../agent0/tools";
import { retryRawInput } from "../agent0/digest";
import { registerMediaReadRoutesV1 } from "./media";
import { beijingDayStart, nowWallClock } from "../shared/time";
import { UsageRangeSchema, type UsageRange } from "@summarizing/shared";
import {
  manualActionHttp,
  manualSetStatus,
  restoreFromTrash,
  type ManualActionError,
} from "../application/itemStatus";

// 对外 v1 接口（D-139）：给外部 agent / 脚本用的稳定读写面。
//
// 与 `/api/*` 的关系：**同一个领域函数、同一份 shared schema**，只是鉴权方式不同
// （Bearer 令牌，而非浏览器会话 cookie）。
//
// 鉴权在 `auth/token.ts`，作用域在 `app.ts` 里单独注册。v1 暴露哪些能力**以本文件的路由
// 清单为准**——新增一条就得写在这里。

/** 看板查询：page / folded 与 `/api/board` 同口径（见 app.ts 的 BoardQuerySchema）。 */
const BoardQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  folded: z.enum(["0", "1"]).default("0"),
});

/** 列表类查询：一页页码（回收站 / 通知共用）。 */
const PageQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1) });

/** @ 候选的过滤参数（q = 前缀/子串，空 = 全量）。 */
const MentionablesQuerySchema = z.object({ q: z.string().default("") });

/** 台账条数（与内部 `/api/pipeline/runs` 上限同源）。 */
const RunsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/** 检索参数：查询串里全是一维值，数字/枚举在边界转（`identity` 用 JSON 串，因为它是键值对数组）。 */
const SearchQuerySchema = z.object({
  query: z.string().optional(),
  source: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  mode: z.enum(["all", "any"]).optional(),
  limit: z.coerce.number().optional(),
  identity: z.string().optional(),
});

/** 用量查询（与 `/api/usage` 同口径：北京墙钟日历日）。 */
const UsageQuerySchema = z.object({ range: UsageRangeSchema.default("7d") });

/** 存疑库查询（status 缺席 = open）。 */
const UncertainQuerySchema = z.object({ status: UncertainStatus.default("open") });
/** 路径参数：单个 id。 */
const IdParamsSchema = z.object({ id: z.string() });

/** 把一次投喂回执压成 v1 的形状（批次 id + 消化置位结果，不泄露内部状态机细节）。 */
function ingestReceipt(raw: RawInput, digestState: string): { id: string; digestState: string } {
  return { id: raw.id, digestState };
}

/** 外部调用的署名（版本链里据此区分「谁改的」）。 */
const BY_EXTERNAL = { actor: "外部接口", model: null } as const;

/** 领域错误 → HTTP 响应（与界面端点同一套文案，见 `manualActionHttp`）。 */
function sendManualActionError(
  reply: { code: (n: number) => { send: (b: { error: string }) => unknown } },
  error: ManualActionError,
): unknown {
  const { code, error: message } = manualActionHttp(error);
  return reply.code(code).send({ error: message });
}

/** 注册 v1 对外路由。
 *
 *  调用方（app.ts）负责把它挂进**独立的作用域**并前置 `makeTokenAuth`——本函数只声明路由，
 *  不碰鉴权（与 `registerItemRoutes` 等内部路由组同构）。 */
export function registerV1Routes(app: FastifyInstance): void {
  // ── 读：看板 / 事项 / 通知 / 回收站 / 存疑 / 流水 / 检索 / 用量 / 图片 ──

  app.get("/api/v1/board", async (req, reply) => {
    const parsed = BoardQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "page 必须是 ≥1 的整数；folded 只能是 0 或 1" });
    }
    return buildBoard(req.space.db, {
      page: parsed.data.page,
      folded: parsed.data.folded === "1",
    });
  });

  app.get("/api/v1/items/:id", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const full = repo.getItemFull(req.space.db, id);
    if (!full) return reply.code(404).send({ error: "事项不存在" });
    return full;
  });

  // 事项检索：参数形状与 agent0 的 search_items 工具完全相同
  app.get("/api/v1/items/search", async (req, reply) => {
    const parsed = SearchItemsArgsSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "query 必填且不能为空" });
    }
    return makeAgentTools(req.space.db, req.space.mediaDir).searchItems(parsed.data);
  });

  // @ 提及候选：与界面的自动补全同一个数据源（非回收站全部条目，时间倒序，上限 500）。
  // 外部 agent 用它做「用户说的『它』是哪条」的候选池；不需要时不必调（看板响应里不再带它）。
  app.get("/api/v1/mentionables", async (req, reply) => {
    const parsed = MentionablesQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "q 必须是字符串" });
    return listMentionables(req.space.db, parsed.data.q);
  });

  app.get("/api/v1/notices", async (req, reply) => {
    const parsed = PageQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "page 必须是 ≥1 的整数" });
    return deriveNotices(req.space.db, parsed.data.page);
  });

  app.get("/api/v1/trash", async (req, reply) => {
    const parsed = PageQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "page 必须是 ≥1 的整数" });
    return deriveTrashed(req.space.db, parsed.data.page);
  });

  app.get("/api/v1/uncertain", async (req) => {
    const { status } = UncertainQuerySchema.parse(req.query);
    return repo.listUncertainByStatus(req.space.db, status);
  });

  app.get("/api/v1/pipeline/runs", async (req) => {
    const { limit } = RunsQuerySchema.parse(req.query);
    return { runs: repo.listPipelineRuns(req.space.db, limit) };
  });

  app.get("/api/v1/pipeline/runs/:id", async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    const raw = repo.getRawInput(req.space.db, id);
    if (!raw) return reply.code(404).send({ error: "批次不存在" });
    return {
      raw,
      events: repo.listPipelineEvents(req.space.db, id),
      // 对话提交上下文（D-139）：与内部端点同口径，外部 agent 也能看到 agent0 当时看到了什么
      context: repo.getRawContext(req.space.db, id),
    };
  });

  // 原文检索：查询串 → 与 search_raws 工具同一套参数
  app.get("/api/v1/search", async (req, reply) => {
    const parsed = SearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "查询参数不合法", issues: parsed.error.issues });
    }
    const { identity, ...rest } = parsed.data;
    let identityPairs: { key: string; value: string }[] | undefined;
    if (identity !== undefined) {
      // identity 是键值对数组，查询串里只能给 JSON——解析失败如实报（不猜也不忽略）
      try {
        const raw: unknown = JSON.parse(identity);
        identityPairs = z.array(z.object({ key: z.string(), value: z.string() })).parse(raw);
      } catch (err) {
        return reply.code(400).send({ error: `identity 必须是 JSON 数组：${errText(err)}` });
      }
    }
    const args = SearchRawsArgsSchema.safeParse({
      ...rest,
      ...(identityPairs === undefined ? {} : { identity: identityPairs }),
    });
    if (!args.success) {
      return reply.code(400).send({ error: "检索参数不合法", issues: args.error.issues });
    }
    try {
      return await makeAgentTools(req.space.db, req.space.mediaDir).searchRaws(args.data);
    } catch (err) {
      // 越界参数由工具自己抛（带正确用法）——v1 如实转成 400
      return reply.code(400).send({ error: errText(err) });
    }
  });

  // 单条批次全文：与 get_raw 工具同口径（精确 id；截断如实标注）
  app.get("/api/v1/raw/:id", async (req, reply) => {
    const parsed = GetRawArgsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "id 不合法" });
    try {
      return await makeAgentTools(req.space.db, req.space.mediaDir).getRaw(parsed.data);
    } catch (err) {
      return reply.code(404).send({ error: errText(err) });
    }
  });

  app.get("/api/v1/usage", async (req, reply) => {
    const parsed = UsageQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "range 取值只能是 today / 7d / 30d" });
    }
    const range: UsageRange = parsed.data.range;
    const days = range === "today" ? 1 : range === "7d" ? 7 : 30;
    const since = beijingDayStart(new Date(), days - 1);
    return { range, ...repo.sumLlmUsage(req.space.db, since) };
  });

  // ── 写：投喂 / 状态 / 重试 / 存疑处置 ──

  // 投喂：与信源/粘贴同一条管线（先落盘、后异步消化）。202 表示「收下了，正在处理」。
  app.post("/api/v1/ingest", async (req, reply) => {
    const parsed = IngestRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "请求体不合法", issues: parsed.error.issues });
    }
    const space = req.space;
    const { raw, digestState } = ingestBatch(
      space.db,
      space.llmRef,
      space.tools,
      parsed.data,
      "v1-api",
      space.mediaDir,
      (msg) => req.log.error(msg),
      (source) => space.mediaFetchers.get(source),
    );
    return reply.code(202).send(ingestReceipt(raw, digestState));
  });

  // 状态动作：与界面端点**共用同一个领域函数**（application/itemStatus.ts）——
  // 守卫、幂等语义、版本链落笔全在一处，两处端点不会各说各话。
  app.post("/api/v1/items/:id/complete", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const next = manualSetStatus(req.space.db, id, "complete_item", BY_EXTERNAL);
    if (!next.ok) return sendManualActionError(reply, next.error);
    return next.item;
  });

  app.post("/api/v1/items/:id/reopen", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const next = manualSetStatus(req.space.db, id, "reopen_item", BY_EXTERNAL);
    if (!next.ok) return sendManualActionError(reply, next.error);
    return next.item;
  });

  app.post("/api/v1/items/:id/trash", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const next = manualSetStatus(req.space.db, id, "trash_item", BY_EXTERNAL);
    if (!next.ok) return sendManualActionError(reply, next.error);
    return next.item;
  });

  app.post("/api/v1/items/:id/restore", async (req, reply) => {
    const { id } = GetItemArgsSchema.parse(req.params);
    const next = restoreFromTrash(req.space.db, id, BY_EXTERNAL);
    if (!next.ok) return sendManualActionError(reply, next.error);
    return next.item;
  });

  // 重试「未处理」批次：与内部重试口同一条领域函数（仅 failed 可重试）
  app.post("/api/v1/raw/:id/retry", async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    const client = req.space.llmRef.current;
    const result = retryRawInput(
      req.space.db,
      client,
      req.space.tools,
      client.modelTag,
      id,
      req.space.mediaDir,
    );
    if (!result.ok) {
      return result.reason === "not_found"
        ? reply.code(404).send({ error: "批次不存在" })
        : reply.code(409).send({ error: "只有「未处理」批次可以重试" });
    }
    return reply.code(202).send({ id, digestState: result.digestState });
  });

  // 存疑库处置：丢弃（与审核页「丢弃这条」同一语义）。合并去向由 agent0 清扫决定——
  // 外部接口不做 merged（那要求调用方知道合并到哪条，等于让它替 AI 做判断）。
  app.put("/api/v1/uncertain/:id", async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    const exists = repo.getUncertainInput(req.space.db, id);
    if (exists === null) return reply.code(404).send({ error: "条目不存在" });
    const resolved = repo.resolveUncertainInput(req.space.db, {
      id,
      status: "discarded",
      resolvedRef: "v1",
      resolvedAt: nowWallClock(),
    });
    if (!resolved) return reply.code(409).send({ error: "条目已被处置" });
    return reply.code(204).send();
  });

  // 图片：内容寻址的只读字节（与浏览器面共用同一份实现）。图片是证据链的一环——
  // 正文/引文里的 `[图片](url)` 占位要靠它渲染成图。
  registerMediaReadRoutesV1(app);
}
