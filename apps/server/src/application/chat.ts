import {
  CHAT_HISTORY_MAX_ITEMS,
  GetItemArgsSchema,
  itemName,
  SearchItemsArgsSchema,
  SearchUncertainArgsSchema,
  type ChatHistoryItem,
} from "@summarizing/shared";
import { z } from "zod";
import type { Db } from "../storage/db";
import { nowLocalWallClock } from "../shared/time";
import * as repo from "../storage/repo";
import { buildBoard } from "./board";
import { describeSweep, sweepUncertainLibrary } from "../agent0/sweep";
import { kickDigest } from "../agent0/digest";
import { errText } from "../shared/err";
import { makeAgentTools, type AgentTools } from "../agent0/tools";
import type { ChatMsg, LlmClient, ToolCall, ToolDef } from "../shared/llm";

// 前台 buddy（D-78）：有连续上下文的多轮对话 agent——像聊天一样答问、收信息、留痕。
// 红线：只读 + 只能调工具，写权永远在执行器；拿不准宁可误录入（D-14）；全留痕。
// 工具循环与 agent0/digest.ts 的 elicitChangeList 互为镜像——读懂数管线就读懂了前台。
// ⚠️ 本文件编排之外还内含一个未拆的前台对话 agent（converse/runTool/提示词/工具定义）——
//    拆出与「agent 机制对齐」（两循环抽象共用）为观察项，待两个循环都被验证过后处理（2026-10-09）。

const MAX_ROUNDS = 4;

// ── 前台工具定义（schema 住边界：前台专属、无第二调用者，不进 shared）──

const BoardArgsSchema = z.object({});
const IngestArgsSchema = z.object({ content: z.string().min(1) });
const ChitchatArgsSchema = z.object({ content: z.string().min(1) });
const SweepArgsSchema = z.object({});

const FRONT_TOOL_DEFS: ToolDef[] = [
  {
    name: "get_board",
    description:
      "读取看板全部事项（存疑/日期未知/已排期/已完成五段）——回答「最近有什么要交的」这类问题用它",
    parametersJsonSchema: z.toJSONSchema(BoardArgsSchema),
  },
  {
    name: "search_items",
    description: "按关键词检索已有事项（关键词要用事项里出现过的词，如课程名）",
    parametersJsonSchema: z.toJSONSchema(SearchItemsArgsSchema),
  },
  {
    name: "get_item",
    description: "读取单个事项详情（元素/证据/版本历史——查看编辑记录）",
    parametersJsonSchema: z.toJSONSchema(GetItemArgsSchema),
  },
  {
    name: "search_uncertain",
    description:
      "查看存疑信息库（过去拿不准的原始信息）——用户问「有什么没弄清的吗」/「存疑库里有什么」时用它。sameSourceOnly 保持 false（库里的条目多来自群消息，按来源过滤会几乎全空）",
    parametersJsonSchema: z.toJSONSchema(SearchUncertainArgsSchema),
  },
  {
    name: "sweep_uncertain",
    description:
      "触发存疑库清扫（agent0 逐条复核、丢弃已被取代/证伪的条目）——用户说「清扫存疑库」时用它",
    parametersJsonSchema: z.toJSONSchema(SweepArgsSchema),
  },
  {
    name: "ingest",
    description:
      "把用户提供的**新信息**录入待处理队列（agent0 会去消化并自动去重合并）。content 必须是用户原话逐字，禁止改写或摘要",
    parametersJsonSchema: z.toJSONSchema(IngestArgsSchema),
  },
  {
    name: "log_chitchat",
    description: "用户消息纯属寒暄（没有任何具体事情）时调用留痕，content 传用户原话",
    parametersJsonSchema: z.toJSONSchema(ChitchatArgsSchema),
  },
];

export interface ChatResult {
  reply: string;
  actions: { tool: string; note: string }[]; // 工具轨迹（人话），响应后一次性展示（05§四）
  references: { id: string; title: string }[]; // 本轮触碰过的事项，前端渲染可点 chips 深链
}

/** 一轮会话的收集器：录入开关 + 工具轨迹 + 触碰过的事项（id→标题，插入序即触碰序）。 */
interface ChatTurnState {
  ingested: boolean;
  actions: { tool: string; note: string }[];
  refTitles: Map<string, string>;
}

/** references 组装：按触碰顺序去重、上限 8（防 chips 洪泛，05§四）。 */
function pickReferences(state: ChatTurnState): { id: string; title: string }[] {
  return [...state.refTitles.entries()].slice(0, 8).map(([id, title]) => ({ id, title }));
}

/** 前台主流程（D-78）：多轮工具循环后给出回复；LLM 挂/超轮数时兜底，已录入过绝不重复录入（消化非幂等）。
 *  mentions = 用户在输入框 @ 提及的事项（2026-09-27）——注入给模型做指代消解，id 由前端看板保证真实。 */
export async function handleChat(
  db: Db,
  llm: LlmClient,
  modelTag: string,
  message: string,
  history: ChatHistoryItem[],
  mentions: { id: string; title: string }[] = [],
): Promise<ChatResult> {
  const tools = makeAgentTools(db);
  const state: ChatTurnState = { ingested: false, actions: [], refTitles: new Map() };
  // 持久化本轮用户消息（L16：刷新/换设备可回填）——落库即用户话已存，模型再挂也不丢这句
  repo.appendChatTurn(db, "user", message);
  let result: ChatResult;
  try {
    const reply = await converse(db, llm, modelTag, message, history, tools, state, mentions);
    result = { reply, actions: state.actions, references: pickReferences(state) };
  } catch (err) {
    // 静默吞错 = 排障黑洞：先留痕再兜底（S2 评审）
    process.stderr.write(`[chat] 前台循环失败，走兜底：${errText(err)}\n`);
    // 前台 LLM 挂了 ≠ 消息丢失（D-14）：本轮尚未录入 → 原文走消化管线兜底；已录入过则如实相告
    if (!state.ingested) {
      result = {
        reply: fallbackIngest(db, llm, modelTag, tools, message),
        actions: [{ tool: "ingest", note: "已录入，消化中" }],
        references: [],
      };
    } else {
      result = {
        reply: "已记录，正在处理。处理结果稍后会在看板上出现。",
        actions: state.actions,
        references: pickReferences(state),
      };
    }
  }
  // 持久化助手回复（含兜底话术）
  repo.appendChatTurn(db, "assistant", result.reply);
  return result;
}

/** 一轮会话的工具循环：模型按需查（get_board/search_items/get_item）、收信息（ingest）、
 *  留痕（log_chitchat），直到给出纯文本回复或超轮数抛错。 */
async function converse(
  db: Db,
  llm: LlmClient,
  modelTag: string,
  message: string,
  history: ChatHistoryItem[],
  tools: AgentTools,
  state: ChatTurnState,
  mentions: { id: string; title: string }[],
): Promise<string> {
  // @ 提及（用户 2026-09-27）：注记拼进本条用户消息——模型拿到精确 id 指代，不用猜「就是那条」
  const mentionNote =
    mentions.length > 0
      ? `[用户在输入框 @ 提及了事项：${mentions
          .map((m) => `「${m.title}」(id=${m.id})`)
          .join("、")}——用户说「这条/它」时大概率指这些，可用 get_item 核实]\n`
      : "";
  const messages: ChatMsg[] = [
    ...history
      .slice(-CHAT_HISTORY_MAX_ITEMS)
      .map((h): ChatMsg => ({ role: h.role, content: h.content })),
    { role: "user", content: `${mentionNote}${message}` },
  ];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const turn = await llm.chat({
      system: FRONT_DESK_SYSTEM_PROMPT,
      messages,
      tools: FRONT_TOOL_DEFS,
    });
    if (turn.toolCalls.length > 0) {
      messages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });
      for (const call of turn.toolCalls) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: await runTool(db, llm, modelTag, tools, call, state),
        });
      }
      continue;
    }
    const reply = turn.content?.trim() ?? "";
    if (reply === "") {
      // 空回复不当作用户可见的话——回喂一次让模型重说
      messages.push({
        role: "user",
        content: "你的上一条回复是空的。请直接用一句话回复用户；如果操作还没完成，先调工具。",
      });
      continue;
    }
    return reply;
  }
  throw new Error(`前台工具循环超过 ${MAX_ROUNDS} 轮仍未给出回复`);
}

/** 执行一次前台工具调用并返回 JSON 结果；出错回喂给模型自行调整，不中断循环（仿 digest 的 runTool）。
 *  副作用：把人话轨迹记入 state.actions、触碰过的事项记入 state.refTitles（chips 数据，05§四）。 */
async function runTool(
  db: Db,
  llm: LlmClient,
  modelTag: string,
  tools: AgentTools,
  call: ToolCall,
  state: ChatTurnState,
): Promise<string> {
  try {
    const args: unknown = JSON.parse(call.argsJson);
    switch (call.name) {
      case "get_board": {
        BoardArgsSchema.parse(args);
        state.actions.push({ tool: "get_board", note: "查了看板" });
        return JSON.stringify(buildBoard(db));
      }
      case "search_items": {
        const { query } = SearchItemsArgsSchema.parse(args);
        const result = await tools.searchItems({ query });
        for (const item of result.items) {
          state.refTitles.set(item.id, itemName(item.elements));
        }
        state.actions.push({ tool: "search_items", note: `搜了「${query}」` });
        return JSON.stringify(result);
      }
      case "get_item": {
        const { id } = GetItemArgsSchema.parse(args);
        const full = await tools.getItem({ id });
        const title = itemName(full.item.elements);
        state.refTitles.set(id, title);
        state.actions.push({ tool: "get_item", note: `看了「${title}」` });
        return JSON.stringify(full);
      }
      case "search_uncertain": {
        SearchUncertainArgsSchema.parse(args);
        // 前台翻池：无「当前信源」可言——强制不看 sameSourceOnly（否则对群消息条目全失明，
        // 模型若填 true 会答「库是空的」= 用户可见的错误答案，评审 A4）
        const result = await tools.searchUncertain(
          { sameSourceOnly: false },
          { sourceIdentity: { sourceLabel: "用户对话" }, eventTime: null },
        );
        state.actions.push({
          tool: "search_uncertain",
          note: `翻了存疑库（${result.entries.length} 条）`,
        });
        return JSON.stringify(result);
      }
      case "sweep_uncertain": {
        SweepArgsSchema.parse(args);
        // 前台只触发不写库（§6.6）：清扫循环自己在围栏内落笔，from 审计记录触发来源
        const result = await sweepUncertainLibrary(db, llm, modelTag, "chat");
        state.actions.push({ tool: "sweep_uncertain", note: describeSweep(result) });
        return JSON.stringify({ ok: true, ...result, summary: describeSweep(result) });
      }
      case "ingest": {
        if (state.ingested) {
          // 批次粒度（01§5.3）：一条消息 = 一个批次。拒绝并提示模型整条录入，系统自己拆
          return JSON.stringify({
            ok: false,
            error: "本回合已录入过。一条消息只需 ingest 一次整条原话，系统会自动拆分与合并",
          });
        }
        const { content } = IngestArgsSchema.parse(args);
        const raw = insertChatRaw(db, content);
        state.ingested = true;
        state.actions.push({ tool: "ingest", note: "已录入，消化中" });
        kickDigest(db, llm, tools, modelTag, raw, "ingest-tool");
        return JSON.stringify({ ok: true, note: "已录入待处理队列，agent0 消化中" });
      }
      case "log_chitchat": {
        if (state.ingested) {
          return JSON.stringify({ ok: false, error: "本条已录入待处理，不是寒暄，无需留痕" });
        }
        const { content } = ChitchatArgsSchema.parse(args);
        chitchatAudit(db, content, modelTag);
        state.actions.push({ tool: "log_chitchat", note: "记了一笔闲聊" });
        return JSON.stringify({ ok: true });
      }
      default:
        return JSON.stringify({ error: `未知工具: ${call.name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: errText(err) });
  }
}

/** 「宁可误录入」的兜底（D-14）：原文入库 → 异步交给 agent0，绝不 500。 */
function fallbackIngest(
  db: Db,
  llm: LlmClient,
  modelTag: string,
  tools: AgentTools,
  message: string,
): string {
  const raw = insertChatRaw(db, message);
  kickDigest(db, llm, tools, modelTag, raw, "fallback");
  return "已记录，正在处理。";
}

/** 用户对话原文落档（chat 源；事件时间未知——对话里说的「今天」按 null 走有据推断）。 */
function insertChatRaw(db: Db, content: string) {
  return repo.insertRawInput(db, {
    content,
    sourceType: "chat",
    sourceIdentity: { sourceLabel: "用户对话" },
    receivedAt: nowLocalWallClock(),
    eventTime: null,
  });
}

/** 纯寒暄留痕（D-14）：原文入库即视为已处理，审计记 chitchat_discard，不进消化。 */
function chitchatAudit(db: Db, content: string, modelTag: string): void {
  const raw = insertChatRaw(db, content);
  repo.setDigestState(db, raw.id, "digested");
  repo.appendRawAudit(db, {
    rawInputId: raw.id,
    action: "chitchat_discard",
    detail: "前台判定纯寒暄，未入库处理（留痕）",
    by: { actor: "前台", model: modelTag },
  });
}

// 前台 buddy 提示词（D-78 重写）：人设 + 三选一纪律 + 指令处理 + 措辞禁令。
const FRONT_DESK_SYSTEM_PROMPT = `你是「前台」——用户的信息管家 buddy，有连续对话上下文。你通过工具做事，绝不直接改任何数据（你没有直接写库的能力）。

每条用户消息，按性质三选一：
- 查询/提问 → 调 get_board 或 search_items / get_item 查依据后回答。查不到的明说没有，禁止用常识编造；部分有依据时，有据与无据分开陈述。
- 包含任何具体信息（通知、作业、活动、时间地点、对已有事项的改动说法……哪怕只是"听说"）→ 调 ingest，content 必须是用户原话逐字，禁止改写、翻译或摘要（下游要拿原文核对引文）。系统会自动去重合并，你不要自己判断"是不是重复"。
- 纯寒暄（"你好""谢谢"，无任何具体事情）→ 调 log_chitchat 留痕。

指令类诉求：
- "把 xx 改成 yy" 这类修改说法 → 一律当新信息 ingest——系统会把它识别为对已有事项的修正；你没有修改数据的工具，绝不假装执行。
- 要求撤回/删除历史记录 → 系统暂未提供该能力（D-79），如实说明，并引导：直接再发一条更正信息即可，系统会合并处理。

用户可能用指代（"就是刚才那条"）——结合对话历史理解；不确定就先查证再回答。

措辞禁令：禁止"你还有 N 件事没看"；禁止"建议你关注…"式主动推荐；无依据时明说没有——「我不知道」是功能；有据与无据分开陈述。
回复简短、像聊天，不要把工具返回的原始 JSON 贴给用户。`;
