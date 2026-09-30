import { z } from "zod";
import {
  GetItemArgsSchema,
  SearchItemsArgsSchema,
  SearchKbArgsSchema,
  SearchRecentRawsArgsSchema,
  SearchRecentRawsResultSchema,
  SearchUncertainArgsSchema,
  SearchUncertainResultSchema,
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
import type { Db } from "../../storage/db";
import * as repo from "../../storage/repo";
import type { ToolDef } from "../../shared/llm";

// agent0 的检索工具（01§4.14）：全部真代码检索，LLM 永不裸操作存储。
// search_recent_raws / search_uncertain 归信源阶段（D-85）：前者找碎片兄弟，后者查存疑库复原。

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "search_items",
    description: "按关键词检索已有事项（身份判断 / 打标签参考）",
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
];

/** 检索工具的当前批次参照（服务端隐式注入，agent0 不拼参数）——供接近度排序。 */
export interface ToolContext {
  sourceIdentity: SourceIdentity;
  eventTime: string | null;
}

export interface AgentTools {
  searchItems(args: SearchItemsArgs): Promise<SearchItemsResult>;
  searchKb(args: SearchKbArgs): Promise<SearchKbResult>;
  getItem(args: GetItemArgs): Promise<GetItemResult>;
  searchRecentRaws(args: SearchRecentRawsArgs, ctx: ToolContext): Promise<SearchRecentRawsResult>;
  searchUncertain(args: SearchUncertainArgs, ctx: ToolContext): Promise<SearchUncertainResult>;
}

/** 造出 agent0 的检索工具集：全部只读真代码检索，写权不在这里（01§4.14）。 */
export function makeAgentTools(db: Db): AgentTools {
  return {
    async searchItems({ query }) {
      const q = query.trim();
      // 标签或语义名命中都算（打标签参考 + 身份判断）
      const items = repo
        .deriveItems(db)
        .filter(
          (item) =>
            item.tags.some((t) => t.includes(q)) || item.elements.some((e) => e.text.includes(q)),
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
  };
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
  const ctxT = ctx.eventTime === null ? Number.NaN : Date.parse(ctx.eventTime);
  return (
    a: { sourceIdentity: SourceIdentity; eventTime: string | null; createdAt: string },
    b: typeof a,
  ): number => {
    const aSame = a.sourceIdentity["sourceLabel"] === ctx.sourceIdentity["sourceLabel"] ? 1 : 0;
    const bSame = b.sourceIdentity["sourceLabel"] === ctx.sourceIdentity["sourceLabel"] ? 1 : 0;
    if (aSame !== bSame) return bSame - aSame; // 同源优先
    if (!Number.isNaN(ctxT)) {
      const aT = Date.parse(a.eventTime ?? a.createdAt);
      const bT = Date.parse(b.eventTime ?? b.createdAt);
      if (!Number.isNaN(aT) && !Number.isNaN(bT)) {
        const d = Math.abs(aT - ctxT) - Math.abs(bT - ctxT);
        if (d !== 0) return d; // 与当前批次时刻差越小越前
      }
    }
    return b.createdAt.localeCompare(a.createdAt); // 回退/破平：新入库优先
  };
}
