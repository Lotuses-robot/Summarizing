import { z } from "zod";
import {
  errText,
  FetchImageArgsSchema,
  GetItemArgsSchema,
  GetRawArgsSchema,
  GetRawResultSchema,
  mediaIdFromUrl,
  SearchItemsArgsSchema,
  SearchKbArgsSchema,
  SearchRawsArgsSchema,
  SearchRawsResultSchema,
  SearchUncertainArgsSchema,
  SearchUncertainResultSchema,
  type FetchImageArgs,
  type GetItemArgs,
  type GetItemResult,
  type GetRawArgs,
  type GetRawResult,
  type SearchKbArgs,
  type SearchKbResult,
  type SearchItemsArgs,
  type SearchItemsResult,
  type RawInput,
  type SearchRawsArgs,
  type SearchRawHit,
  type SearchRawsResult,
  type SearchUncertainArgs,
  type SearchUncertainResult,
  type Identity,
} from "@summarizing/shared";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import { buildCountSql, buildSearchSql, validateSearchArgs } from "../search/query";
import type { ToolDef } from "../shared/llm";
import { parseWallClock } from "../shared/time";
import { fetchImage } from "./fetchImage";
import { readMediaBytes, storeImageBytes } from "../application/media";

// agent0 的检索工具（01§4.14）：全部真代码检索，LLM 永不裸操作存储。
// search_raws / search_uncertain 归信源阶段（D-85）：前者检索历史批次，后者查存疑库复原。
// fetch_image 归多模态初步（2026-10-13）：正文里的 `[图片](url)` 占位，agent0 自行取回查看。

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "search_items",
    description:
      "按关键词检索已有事项与通知（身份判断 / 打标签 / 更新通知参考；结果带 kind 区分种类）",
    parametersJsonSchema: z.toJSONSchema(SearchItemsArgsSchema),
  },
  {
    name: "search_kb",
    description: "检索知识库。当前知识库未落地，恒返回空（S3 才有内容）",
    parametersJsonSchema: z.toJSONSchema(SearchKbArgsSchema),
  },
  {
    name: "get_item",
    description: "读取单个事项详情：本体、标签、证据链、版本历史",
    parametersJsonSchema: z.toJSONSchema(GetItemArgsSchema),
  },
  {
    name: "search_raws",
    description:
      "检索历史进站批次（原文档案）。按关键词 / 信源 / 身份键值 / 时间任意组合查询，条件间取交集（mode=all）或并集（mode=any）。模糊匹配支持部分关键词（搜「课群」能命中「英语课群」），精确匹配按身份键值对查。结果可能因过长而截断——每条带 truncated 与原长度，more 说明还有多少条未返回；需要更多请缩小范围或调小 limit。⚠️ 某条 truncated=true 时，用 get_raw 按它的 id 取全文。",
    parametersJsonSchema: z.toJSONSchema(SearchRawsArgsSchema),
  },
  {
    name: "get_raw",
    description:
      "按 id 读取一条进站批次的全文（search_raws 结果里 truncated=true 时用它，或需要逐字核对引文时用）。id 必须逐字来自 search_raws 结果或当前批次简报，不猜、不做模糊匹配。一次只查一条；正文过长仍会截断，看 truncated 与 contentLength。",
    parametersJsonSchema: z.toJSONSchema(GetRawArgsSchema),
  },
  {
    name: "search_uncertain",
    description:
      "检索存疑信息库（open 条目：过去拿不准的原始信息）——命中即可能是本批的上下文，合并应用后 resolve_uncertain",
    parametersJsonSchema: z.toJSONSchema(SearchUncertainArgsSchema),
  },
  {
    name: "fetch_image",
    description:
      "查看正文里 [图片](url) 占位对应的图片内容（截图/海报里的文字信息）。url 逐字取自本批原文的占位，不要自己编。只允许图片直链；取不到就按纯文本处理，不要重试。",
    parametersJsonSchema: z.toJSONSchema(FetchImageArgsSchema),
  },
];

/** 检索工具的当前批次参照（服务端隐式注入，agent0 不拼参数）——供接近度排序。 */
export interface ToolContext {
  identity: Identity;
  eventTime: string | null;
}

/** fetch_image 的结果：成功给 data URL 与它落到的媒体 id（`null` = 没能持久化，图照样给模型看了）。
 *  mediaId 是刀 4「读过未引用 → 缩短留存」的判定依据——只在这里知道。 */
export type FetchImageToolResult =
  { ok: true; dataUrl: string; mediaId: string | null } | { ok: false; reason: string };

export interface AgentTools {
  searchItems(args: SearchItemsArgs): Promise<SearchItemsResult>;
  searchKb(args: SearchKbArgs): Promise<SearchKbResult>;
  getItem(args: GetItemArgs): Promise<GetItemResult>;
  searchRaws(args: SearchRawsArgs): Promise<SearchRawsResult>;
  getRaw(args: GetRawArgs): Promise<GetRawResult>;
  searchUncertain(args: SearchUncertainArgs, ctx: ToolContext): Promise<SearchUncertainResult>;
  fetchImage(args: FetchImageArgs): Promise<FetchImageToolResult>;
}

/** 造出 agent0 的检索工具集：全部只读真代码检索，写权不在这里（01§4.14）。
 *  `mediaDir` = 本账户媒体目录，**必填**（同 ingestBatch 的理由）：取图要能读本地副本、
 *  也要能把下载成功的图存进去；可选参数的版本会让某个调用方悄悄丢掉缓存。 */
export function makeAgentTools(db: Db, mediaDir: string): AgentTools {
  return {
    async searchItems({ query }) {
      const q = query.trim();
      // 标签或语义名命中都算（打标签参考 + 身份判断）；**trashed 一律排除**（D-106 ⑧ / OQ-9）：
      // 已删除的条目不该被检索到——否则 agent0 会尝试更新它、围栏每轮拒收空转
      const items = repo
        .deriveItems(db)
        .filter(
          (item) =>
            item.status !== "trashed" &&
            (item.tags.some((t) => t.includes(q)) || item.elements.some((e) => e.text.includes(q))),
        );
      return { items };
    },
    async searchKb() {
      // 01§4.9：知识库 S3 落地，读法① 在此之前恒空
      return { entries: [] };
    },
    async getItem({ id }) {
      const full = repo.getItemFull(db, id);
      if (!full) throw new Error(`item not found: ${id}`);
      // trashed 一律排除出检索面（D-106 ⑧ / OQ-9）：不把已删内容喂给模型
      if (full.item.status === "trashed") {
        throw new Error(`item 在回收站（已删除）：${id}——不可读取，需先在回收站恢复`);
      }
      return full;
    },
    async getRaw({ id }) {
      // 精确查一条：id 逐字比对（批次永不删，查不到就是 id 不对——报错并给正确用法，不猜）
      const raw = repo.getRawInput(db, id);
      if (raw === null) {
        throw new Error(
          `没有这个批次 id：${id}——id 必须逐字来自 search_raws 结果或当前批次简报（本工具不做模糊匹配）`,
        );
      }
      const truncated = raw.content.length > GET_RAW_CONTENT_MAX;
      return GetRawResultSchema.parse({
        id: raw.id,
        content: truncated ? raw.content.slice(0, GET_RAW_CONTENT_MAX) : raw.content,
        truncated,
        contentLength: raw.content.length,
        source: raw.source,
        identity: raw.identity,
        receivedAt: raw.receivedAt,
        eventTime: raw.eventTime,
      });
    },
    async searchRaws(args) {
      // 边界先校验（越界直接抛给模型：文案里带正确用法——D-103 不替模型改输入）
      validateSearchArgs(args);
      const idQuery = buildSearchSql(args);
      const countQuery = buildCountSql(args);
      const ids = queryRows(db, idQuery.sql, idQuery.params);
      const total = countRows(db, countQuery.sql, countQuery.params);
      const limit = args.limit ?? DEFAULT_SEARCH_LIMIT;
      const selected = ids.slice(0, limit);
      const raws = repo.getRawInputsByIds(db, selected);
      const byId = new Map(raws.map((r) => [r.id, r]));
      const hits: SearchRawHit[] = [];
      let budget = SEARCH_RESULT_BUDGET;
      for (const id of selected) {
        const raw = byId.get(id);
        if (raw === undefined) continue; // 检索与读之间被删（批次永不删，防御性跳过）
        const summary = summarizeRaw(raw);
        // 预算按**总量**算；装不下的**这一条**跳过、继续看后面的短条目——
        // 不能一遇到装不下就 break：那会把后面所有命中（包括模型要找的「另一半」）全部丢掉，
        // 而 more 区分不出「预算丢弃」和「超出 limit」。跳过则至少保证「给出的都是装得下的」。
        if (budget - summary.content.length < 0) continue;
        budget -= summary.content.length;
        hits.push(summary);
      }
      return SearchRawsResultSchema.parse({
        hits,
        total,
        more: total - hits.length,
      });
    },
    async searchUncertain({ sameSourceOnly }, ctx) {
      const open = repo.listUncertainByStatus(db, "open");
      const filtered = sameSourceOnly
        ? open.filter((u) => sameIdentity(u.identity, ctx.identity))
        : open;
      // 接近度排序 → 截断 → 映射 → 过 Result schema（同 searchRecentRaws）
      return SearchUncertainResultSchema.parse({
        entries: [...filtered]
          .sort(byProximity(ctx))
          .slice(0, TOOL_RESULT_LIMIT)
          .map((u) => ({
            id: u.id,
            content: u.content.slice(0, TOOL_RESULT_CONTENT_MAX),
            identity: u.identity,
            eventTime: u.eventTime,
            createdAt: u.createdAt,
            needsHuman: u.needsHuman,
            reason: u.reason,
          })),
      });
    },
    async fetchImage({ url }) {
      // 本地优先（009 FR-008）：占位可能已经落成媒体（前台上传的 `/api/media/<id>`、
      // 或已缓存的原链接）——直接读盘，零网络。QQ 图链接小时级过期，这一步常常是唯一能看的路径。
      const local = readLocalMedia(db, mediaDir, url);
      if (local !== null) return local;
      // 未命中走下载（SSRF 五道闸 + MIME/魔数/大小/超时全在 fetchImage.ts）；失败归一成 ok:false
      const got = await fetchImage(url);
      if (!got.ok) return got;
      // 下载成功即顺手持久化：进站缓存可能因抖动漏掉这张，模型看过之后它也该留在本地
      const mediaId = await persistImage(db, mediaDir, url, got.bytes);
      return { ok: true, dataUrl: got.dataUrl, mediaId };
    },
  };
}

/** 读本地副本（占位 URL → media 行 → 文件 → data URL）。
 *  返回 null = 本地没有、可回退下载；返回 ok:false = 本地就是唯一来源，且它已经没了。 */
function readLocalMedia(db: Db, mediaDir: string, url: string): FetchImageToolResult | null {
  const localId = mediaIdFromUrl(url);
  // `/api/media/<id>` 只存在于本机——行没了就是没了，回退下载也没有出处
  if (localId !== null) {
    const row = repo.getMedia(db, localId);
    if (row === null) return { ok: false, reason: "图片已过期或已被清理" };
    return readStored(mediaDir, row.id, row.mime);
  }
  const row = repo.getMediaByOriginUrl(db, url);
  if (row === null) return null;
  const local = readStored(mediaDir, row.id, row.mime);
  if (local.ok) return local;
  // 外部链接：本地副本缺了还能再下一次
  process.stderr.write(`[media] 本地副本缺失，改走原链接（${url}）：${local.reason}\n`);
  return null;
}

/** 读媒体行的文件并编码成 data URL（失败归一成 ok:false，不抛）。 */
function readStored(mediaDir: string, id: string, mime: string): FetchImageToolResult {
  try {
    const bytes = readMediaBytes(mediaDir, id, mime);
    return { ok: true, dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, mediaId: id };
  } catch (err) {
    return { ok: false, reason: `图片文件缺失：${errText(err)}` };
  }
}

/** 把刚下载的字节存进媒体库（失败只留痕——模型已经拿到图，持久化是顺手的事）。 */
async function persistImage(
  db: Db,
  mediaDir: string,
  url: string,
  bytes: Uint8Array,
): Promise<string | null> {
  if (mediaDir === "") return null; // 显式「无媒体目录」的场景（前台对话面 v1 不取图）——不落盘
  try {
    const stored = await storeImageBytes(db, mediaDir, Buffer.from(bytes), { originUrl: url });
    return stored.id;
  } catch (err) {
    process.stderr.write(`[media] 取图后持久化失败（${url}）：${errText(err)}\n`);
    return null;
  }
}

/** 工具单次返回的条目上限（防历史批次/存疑库洪泛直灌 LLM 上下文）。 */
const TOOL_RESULT_LIMIT = 30;
/** 工具结果里单条 content 的截断长度（检索只求「认出是同一条」，不必全量原文）。 */
const TOOL_RESULT_CONTENT_MAX = 400;

/** search_raws 默认返回条数（模型不给 limit 时）。 */
const DEFAULT_SEARCH_LIMIT = 20;
/** search_raws 单次结果的总字数预算（D-127：取代「每条硬砍 400 字 × 30 条」的 12,000 字洪泛）。
 *  依据：prompt 多 5,000 token 时缓存命中率 95%→55%——增量越小越好；2,000 字约 500 token。 */
const SEARCH_RESULT_BUDGET = 2_000;
/** search_raws 单条摘要的字数上限（摘要级：够认出是哪条，不够下结论——看全文走 get_raw）。 */
const SEARCH_RAW_SUMMARY_MAX = 150;

/** get_raw 单次返回的字数上限（够读完一整篇通知；再长说明该批已撞字节闸，不该整段灌进对话）。
 *  取 4,000 而不是更大：一次 get_raw 的返回会永久留在对话里，按「一次读一整篇」定档即可。 */
const GET_RAW_CONTENT_MAX = 4_000;

/** 一条批次 → 检索命中（截断**如实标注**：truncated + contentLength）。
 *  @param raw 批次（原文逐字，不改）
 */
function summarizeRaw(raw: RawInput): SearchRawHit {
  const truncated = raw.content.length > SEARCH_RAW_SUMMARY_MAX;
  return {
    id: raw.id,
    content: truncated ? raw.content.slice(0, SEARCH_RAW_SUMMARY_MAX) : raw.content,
    truncated,
    contentLength: raw.content.length,
    source: raw.source,
    identity: raw.identity,
    receivedAt: raw.receivedAt,
    eventTime: raw.eventTime,
  };
}

/** 跑一条 id 查询（search/query.ts 构造；参数全部绑定，无字符串拼接）。
 *  @param db 库句柄
 *  @param sql 查询 SQL
 *  @param params 绑定参数
 */
function queryRows(db: Db, sql: string, params: unknown[]): string[] {
  return z
    .object({ id: z.string() })
    .array()
    .parse(db.$client.prepare(sql).all(...params))
    .map((r) => r.id);
}

/** 跑 count 查询（命中总数，不受 limit 影响）。
 *  @param db 库句柄
 *  @param sql 查询 SQL
 *  @param params 绑定参数
 */
function countRows(db: Db, sql: string, params: unknown[]): number {
  return z.object({ n: z.number() }).parse(db.$client.prepare(sql).get(...params)).n;
}

/** 取身份的「同源判据键」（除 sender 外全部键，排序后可比）。
 *  @param i 身份字典
 */
function identityKeys(i: Identity): string[] {
  return Object.keys(i)
    .filter((k) => k !== "sender")
    .sort();
}

/** 两条身份是否同源：**除 `sender` 外的全部键**逐个相等。
 *
 *  为什么排除 sender：多人群批次按 D-91 **不写发信人**（批内多人时不署名），
 *  拿 sender 比会把「同一群的两人接续发言」判成不同源——恰恰是最该找齐的场景。
 *  为什么其余键全比：只比 displayName 会漏判（同一显示名可能是不同群的备注重名）。
 *  键集合不同 = 不同源（一个缺 groupId 的批次与有 groupId 的不是同一类身份）。 */
function sameIdentity(a: Identity, b: Identity): boolean {
  const ak = identityKeys(a);
  const bk = identityKeys(b);
  if (ak.length !== bk.length || ak.some((k, idx) => k !== bk[idx])) return false;
  return ak.every((k) => a[k] === b[k]);
}

/** 按与当前批次的信源接近度排序（同源 > 时间临近 > 新入库）——给 agent0 找「另一半」用。
 *  时间临近 = 离**当前批次时刻**最近的排前（不是单纯的新到旧；ctx.eventTime 缺席时回退新到旧）。 */
function byProximity(ctx: ToolContext) {
  // 时刻串一律 parseWallClock（+08:00 显式解析，机器时区无关——裸 Date.parse 是 D-97 泄漏形态）
  const ctxT = ctx.eventTime === null ? Number.NaN : parseWallClock(ctx.eventTime);
  return (
    a: { identity: Identity; eventTime: string | null; createdAt: string },
    b: typeof a,
  ): number => {
    // 同源判据**与 sameIdentity 同一出处**（此前这里只比 displayName，而同一次调用里的
    // sameSourceOnly 过滤比全部键——同一批数据被两套判据分到不同组，自相矛盾）
    const aSame = sameIdentity(a.identity, ctx.identity) ? 1 : 0;
    const bSame = sameIdentity(b.identity, ctx.identity) ? 1 : 0;
    if (aSame !== bSame) return bSame - aSame; // 同源优先
    if (!Number.isNaN(ctxT)) {
      const aT = parseWallClock(a.eventTime ?? a.createdAt);
      const bT = parseWallClock(b.eventTime ?? b.createdAt);
      if (!Number.isNaN(aT) && !Number.isNaN(bT)) {
        const d = Math.abs(aT - ctxT) - Math.abs(bT - ctxT);
        if (d !== 0) return d; // 与当前批次时刻差越小越前
      }
    }
    return b.createdAt.localeCompare(a.createdAt); // 回退/破平：新入库优先
  };
}
