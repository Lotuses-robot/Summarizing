import { z } from "zod";
import {
  errText,
  FetchImageArgsSchema,
  GetItemArgsSchema,
  mediaIdFromUrl,
  SearchItemsArgsSchema,
  SearchKbArgsSchema,
  SearchRecentRawsArgsSchema,
  SearchRecentRawsResultSchema,
  SearchUncertainArgsSchema,
  SearchUncertainResultSchema,
  type FetchImageArgs,
  type GetItemArgs,
  type GetItemResult,
  type SearchKbArgs,
  type SearchKbResult,
  type SearchItemsArgs,
  type SearchItemsResult,
  type SearchRecentRawsArgs,
  type SearchRecentRawsResult,
  type SearchUncertainArgs,
  type SearchUncertainResult,
  type SourceIdentity,
} from "@summarizing/shared";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import type { ToolDef } from "../shared/llm";
import { parseWallClock } from "../shared/time";
import { fetchImage } from "./fetchImage";
import { readMediaBytes, storeImageBytes } from "../application/media";

// agent0 的检索工具（01§4.14）：全部真代码检索，LLM 永不裸操作存储。
// search_recent_raws / search_uncertain 归信源阶段（D-85）：前者找碎片兄弟，后者查存疑库复原。
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
    name: "search_recent_raws",
    description:
      "检索历史进站批次（时间相近 + 可选同来源）——散落碎片的兄弟找齐（本批像某条旧通知的续篇时用）",
    parametersJsonSchema: z.toJSONSchema(SearchRecentRawsArgsSchema),
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
  sourceIdentity: SourceIdentity;
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
  searchRecentRaws(args: SearchRecentRawsArgs, ctx: ToolContext): Promise<SearchRecentRawsResult>;
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
    async searchRecentRaws({ daysBack, sameSourceOnly }, ctx) {
      const all = repo.listRecentRawInputs(db, daysBack);
      const filtered = sameSourceOnly
        ? all.filter((r) => sameIdentity(r.sourceIdentity, ctx.sourceIdentity))
        : all;
      // 映射成契约形状后过 Result schema（截断 content 防 token 洪泛、不外发内部字段；契约漂移在此爆）
      return SearchRecentRawsResultSchema.parse({
        raws: filtered.slice(0, TOOL_RESULT_LIMIT).map((r) => ({
          id: r.id,
          content: r.content.slice(0, TOOL_RESULT_CONTENT_MAX),
          sourceType: r.sourceType,
          sourceIdentity: r.sourceIdentity,
          receivedAt: r.receivedAt,
          eventTime: r.eventTime,
        })),
      });
    },
    async searchUncertain({ sameSourceOnly }, ctx) {
      const open = repo.listUncertainByStatus(db, "open");
      const filtered = sameSourceOnly
        ? open.filter((u) => sameIdentity(u.sourceIdentity, ctx.sourceIdentity))
        : open;
      // 接近度排序 → 截断 → 映射 → 过 Result schema（同 searchRecentRaws）
      return SearchUncertainResultSchema.parse({
        entries: [...filtered]
          .sort(byProximity(ctx))
          .slice(0, TOOL_RESULT_LIMIT)
          .map((u) => ({
            id: u.id,
            content: u.content.slice(0, TOOL_RESULT_CONTENT_MAX),
            sourceIdentity: u.sourceIdentity,
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

/** 两条来源身份是否同源（同 sourceLabel 视为同群/同发信人；弹性字典的核心键就这一个）。 */
function sameIdentity(a: SourceIdentity, b: SourceIdentity): boolean {
  return a["sourceLabel"] === b["sourceLabel"];
}

/** 按与当前批次的信源接近度排序（同源 > 时间临近 > 新入库）——给 agent0 找「另一半」用。
 *  时间临近 = 离**当前批次时刻**最近的排前（不是单纯的新到旧；ctx.eventTime 缺席时回退新到旧）。 */
function byProximity(ctx: ToolContext) {
  // 时刻串一律 parseWallClock（+08:00 显式解析，机器时区无关——裸 Date.parse 是 D-97 泄漏形态）
  const ctxT = ctx.eventTime === null ? Number.NaN : parseWallClock(ctx.eventTime);
  return (
    a: { sourceIdentity: SourceIdentity; eventTime: string | null; createdAt: string },
    b: typeof a,
  ): number => {
    const aSame = a.sourceIdentity["sourceLabel"] === ctx.sourceIdentity["sourceLabel"] ? 1 : 0;
    const bSame = b.sourceIdentity["sourceLabel"] === ctx.sourceIdentity["sourceLabel"] ? 1 : 0;
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
