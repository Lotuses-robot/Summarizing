import {
  errText,
  CHAT_HISTORY_MAX_ITEMS,
  extractImageUrls,
  GetItemArgsSchema,
  itemName,
  SearchItemsArgsSchema,
  SearchUncertainArgsSchema,
  type ChatHistoryItem,
} from "@summarizing/shared";
import { z } from "zod";
import type { Db } from "../storage/db";
import { nowWallClock } from "../shared/time";
import * as repo from "../storage/repo";
import { buildBoard } from "./board";
import { deriveNotices } from "./notice";
import { describeSweep, sweepUncertainLibrary } from "../agent0/sweep";
import { kickDigest } from "../agent0/digest";
import { makeAgentTools, type AgentTools } from "../agent0/tools";
import type { ChatMsg, LlmClient, ToolCall, ToolDef } from "../shared/llm";
import type { MediaFetcherLookup } from "./mediaIngest";
import { recordUsage } from "../shared/usage";

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
/** 人工移除单条存疑（A10；端点 D-87④）：id 由模型从 search_uncertain 结果里取（真实 id 才可命中）。 */
const ResolveUncertainArgsSchema = z.object({ id: z.string().min(1) });
/** 删除一条信息（007 / OQ-8：对话删除 = 进回收站、可恢复）。id 由模型从 search_items / get_board 取。 */
const DeleteItemArgsSchema = z.object({ id: z.string().min(1) });

const FRONT_TOOL_DEFS: ToolDef[] = [
  {
    name: "get_board",
    description:
      "读取看板全部事项（日期未知/已排期/已完成三段）+ 全部通知（notices）——回答「最近有什么要交的」「有什么通知」这类问题用它",
    parametersJsonSchema: z.toJSONSchema(BoardArgsSchema),
  },
  {
    name: "search_items",
    description: "按关键词检索已有事项与通知（关键词要用里面出现过的词，如课程名）",
    parametersJsonSchema: z.toJSONSchema(SearchItemsArgsSchema),
  },
  {
    name: "get_item",
    description: "读取单个事项/通知详情（元素/证据/版本历史——查看编辑记录）",
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
    name: "resolve_uncertain",
    description:
      "把**存疑库**里指定的一条标记为已处理/丢弃（人工移除）——**只用于存疑库条目**。用户说「把那条存疑删了/清了」并指明是哪条时用它；id 必须先用 search_uncertain 查到。⚠️ 要删除看板/通知里的信息请用 delete_item，不要用这个",
    parametersJsonSchema: z.toJSONSchema(ResolveUncertainArgsSchema),
  },
  {
    name: "delete_item",
    description:
      "删除一条**事项或通知**——进回收站、可恢复（不是彻底删）。用户说「把那条删了/不要了」并指明是看板或通知里的哪条时用它；id 必须先 search_items 或 get_board 查到。⚠️ 存疑库条目用 resolve_uncertain",
    parametersJsonSchema: z.toJSONSchema(DeleteItemArgsSchema),
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
  /** 本回合用户消息里的图片占位 URL——ingest 工具据它把模型漏抄的占位补回原文。 */
  imageUrls: string[];
  /** 按信源名查「媒体占位取字节」实现（对话入口用；与其它消化入口同一条口）。 */
  mediaLookup?: MediaFetcherLookup;
}

/** references 组装：按触碰顺序去重、上限 8（防 chips 洪泛，05§四）。 */
function pickReferences(state: ChatTurnState): { id: string; title: string }[] {
  return [...state.refTitles.entries()].slice(0, 8).map(([id, title]) => ({ id, title }));
}

/** 回复中的「已录入」类声称（2026-10-10 事故复发的读工具掩护形态：无其他可判信号，只能扫措辞）。
 *  二轮复查扩样：「已经/帮你/为你/成功+动词」是中文自然完成态（实测「已经记下来了」漏报）——
 *  有界通配 4 字内中缀；假阳性（如「已找到相关记录」）仅多录一条批次，D-14 允许。 */
const RECORDED_CLAIM_RE = /已[^。！？!?\n]{0,4}(?:录入|记录|存档|记下)|记下(?:来)?了/;

/** 回复是否声称已录入——仅在未 ingest 时用于兜底判定（声称 ≠ 事实，代码不让它背离）。 */
function claimsRecorded(reply: string): boolean {
  return RECORDED_CLAIM_RE.test(reply);
}

/** 「已录入」工具轨迹条目（ingest 工具 / 零工具守卫 / LLM 挂兜底三处共用——对用户可见的文案单一出处）。 */
function ingestAction(): { tool: string; note: string } {
  return { tool: "ingest", note: "已录入，消化中" };
}

/** 前台主流程（D-78）：多轮工具循环后给出回复；LLM 挂/超轮数时兜底，已录入过绝不重复录入（消化非幂等）。
 *  mentions = 用户在输入框 @ 提及的事项（2026-09-27）——注入给模型做指代消解，id 由前端看板保证真实。 */
export async function handleChat(
  db: Db,
  llm: LlmClient,
  modelTag: string,
  message: string,
  history: ChatHistoryItem[],
  mediaDir: string,
  mentions: { id: string; title: string }[] = [],
  /** 按信源名查「媒体占位取字节」实现（与其它消化入口同一条口——见 `MediaFetcherLookup`）。 */
  mediaLookup?: MediaFetcherLookup,
): Promise<ChatResult> {
  const tools = makeAgentTools(db, mediaDir);
  const state: ChatTurnState = {
    ingested: false,
    actions: [],
    refTitles: new Map(),
    imageUrls: extractImageUrls(message),
    ...(mediaLookup === undefined ? {} : { mediaLookup }),
  };
  // 持久化本轮用户消息（L16：刷新/换设备可回填）——落库即用户话已存，模型再挂也不丢这句
  repo.appendChatTurn(db, "user", message);
  let result: ChatResult;
  try {
    const reply = await converse(
      db,
      llm,
      modelTag,
      message,
      history,
      tools,
      state,
      mentions,
      mediaDir,
    );
    // 兜底录入（2026-10-10 事故；二轮评审收口）：①本轮无**成功**工具调用 = 回话无凭据；
    // ②未 ingest 却声称已录入——实证的同型事故：先成功查询做了掩护、再谎称「原话已录入」。
    // 按 D-14「宁可误录入」真录一次：声称与事实对齐，绝不静默。
    if (!state.ingested && (state.actions.length === 0 || claimsRecorded(reply))) {
      const why = state.actions.length === 0 ? "本轮无成功工具调用" : "回复声称已录入";
      process.stderr.write(`[chat] ${why}，按兜底录入：${message.slice(0, 60)}\n`);
      fallbackIngest(db, llm, modelTag, tools, message, mediaDir, mediaLookup);
      state.actions.push(ingestAction());
    }
    result = { reply, actions: state.actions, references: pickReferences(state) };
  } catch (err) {
    // 静默吞错 = 排障黑洞：先留痕再兜底（S2 评审）
    process.stderr.write(`[chat] 前台循环失败，走兜底：${errText(err)}\n`);
    // 前台 LLM 挂了 ≠ 消息丢失（D-14）：本轮尚未录入 → 原文走消化管线兜底；已录入过则如实相告
    if (!state.ingested) {
      result = {
        reply: fallbackIngest(db, llm, modelTag, tools, message, mediaDir, mediaLookup),
        actions: [ingestAction()],
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

/** 一轮会话的工具循环：模型按需查（get_board/search_items/get_item/search_uncertain）、收信息（ingest）、
 *  触发清扫（sweep_uncertain）、人工移除存疑（resolve_uncertain）、留痕（log_chitchat），直到给出纯文本回复或超轮数抛错。 */
async function converse(
  db: Db,
  llm: LlmClient,
  modelTag: string,
  message: string,
  history: ChatHistoryItem[],
  tools: AgentTools,
  state: ChatTurnState,
  mentions: { id: string; title: string }[],
  mediaDir: string,
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
    recordUsage(db, "chat", modelTag, turn.usage);
    if (turn.toolCalls.length > 0) {
      messages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });
      for (const call of turn.toolCalls) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: await runTool(db, llm, modelTag, tools, call, state, mediaDir),
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
  mediaDir: string,
): Promise<string> {
  try {
    const args: unknown = JSON.parse(call.argsJson);
    switch (call.name) {
      case "get_board": {
        BoardArgsSchema.parse(args);
        state.actions.push({ tool: "get_board", note: "查了看板" });
        // 看板三段 + 通知（OQ-9：前台可只读查通知）——挂成额外键，看板形状不动
        return JSON.stringify({ ...buildBoard(db), notices: deriveNotices(db).notices });
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
          { identity: { displayName: "用户对话" }, eventTime: null },
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
      case "resolve_uncertain": {
        // A10（端点 D-87④）：存疑库人工移除的对话工具——与审核页 `PUT /api/uncertain/:id` 两套可互替。
        // 语义对齐该端点：不存在 / 已被处置（非 open）/ 成功。resolvedRef="chat" 留痕来源。
        const { id } = ResolveUncertainArgsSchema.parse(args);
        const exists = repo.getUncertainInput(db, id);
        if (exists === null) {
          return JSON.stringify({
            ok: false,
            error: "存疑库里没有这条（id 可能不对，先用 search_uncertain 查）",
          });
        }
        const resolved = repo.resolveUncertainInput(db, {
          id,
          status: "discarded",
          resolvedRef: "chat",
          resolvedAt: nowWallClock(),
        });
        if (!resolved) {
          return JSON.stringify({ ok: false, error: "这条已经被处置过了" });
        }
        state.actions.push({ tool: "resolve_uncertain", note: `从存疑库移除 1 条` });
        return JSON.stringify({ ok: true, note: "已从存疑库移除" });
      }
      case "delete_item": {
        // 对话删除（OQ-8）：与 POST /api/items/:id/trash 同语义——追加 trashed 版本、进回收站可恢复。
        // 不是裸写库：只走 repo 的版本链追加这一条路径（与审核页/看板行删除完全同一行为）。
        const { id } = DeleteItemArgsSchema.parse(args);
        const item = repo.deriveItem(db, id);
        if (item === null) {
          return JSON.stringify({
            ok: false,
            error: "没有这条信息（id 可能不对，先用 search_items 或 get_board 查）",
          });
        }
        const title = itemName(item.elements);
        state.refTitles.set(id, title);
        if (item.status === "trashed") {
          // 幂等：已在回收站，不追加无意义版本（与端点同款）
          state.actions.push({ tool: "delete_item", note: `「${title}」已在回收站` });
          return JSON.stringify({ ok: true, note: `「${title}」本来就在回收站里` });
        }
        repo.appendItemVersion(db, {
          itemId: id,
          action: "trash_item",
          detail: `删除「${title}」（对话）`,
          snapshot: { ...item, status: "trashed" },
          by: { actor: "前台", model: modelTag },
        });
        state.actions.push({ tool: "delete_item", note: `删除「${title}」` });
        return JSON.stringify({
          ok: true,
          note: `已删除「${title}」，进了回收站（可恢复）`,
        });
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
        // 图片占位补齐：模型常只抄用户打的字、把正文末尾的 `[图片](…)` 丢掉——
        // 丢了就等于图片持久化白做（原文里没有占位 → 界面渲染不出图、进站缓存也扫不到）。
        // 用户原话里的占位由我们补回，不给模型「记得带上」的机会（补的是原文，不是噪音）。
        const missing = state.imageUrls.filter((url) => !extractImageUrls(content).includes(url));
        const full =
          missing.length === 0
            ? content
            : `${content}\n\n${missing.map((u) => `[图片](${u})`).join("\n")}`;
        const raw = insertChatRaw(db, full);
        state.ingested = true;
        state.actions.push(ingestAction());
        kickDigest(
          db,
          llm,
          tools,
          modelTag,
          raw,
          "ingest-tool",
          mediaDir,
          undefined,
          state.mediaLookup,
        );
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
  mediaDir: string,
  mediaLookup?: MediaFetcherLookup,
): string {
  const raw = insertChatRaw(db, message);
  kickDigest(db, llm, tools, modelTag, raw, "fallback", mediaDir, undefined, mediaLookup);
  return "已记录，正在处理。";
}

/** 用户对话原文落档（chat 源；事件时间未知——对话里说的「今天」按 null 走有据推断）。 */
function insertChatRaw(db: Db, content: string) {
  return repo.insertRawInput(db, {
    content,
    source: "chat",
    identity: { displayName: "用户对话" },
    receivedAt: nowWallClock(),
    eventTime: null,
  });
}

/** 纯寒暄留痕（D-14）：原文入库即视为已处理（零变更的一种），流水记 digest_done，不进消化。 */
function chitchatAudit(db: Db, content: string, modelTag: string): void {
  const raw = insertChatRaw(db, content);
  repo.setDigestState(db, raw.id, "digested");
  repo.appendPipelineEvent(db, {
    rawInputId: raw.id,
    action: "digest_done",
    detail: "前台判定纯寒暄，未产生变更（留痕）",
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
- **凡是「修改」类的操作（改事项、改标签、改日期、加/删内容、合并……），你一律尝试通过 agent0 完成**——即把用户原话 ingest 进管线，由 agent0 消化执行。除了「删除」与「存疑库处置」这两个专用工具，你**没有**其它直接改数据的能力；绝不自己动手、也绝不假装执行（说"改好了"而没走 ingest = 假声称）。
- "把 xx 改成 yy""标签改成 zz"这类 → 一律当新信息 ingest（content 逐字原话）——agent0 会识别为对已有事项的修正并落地。你做不到的修改，正是 agent0 能做的：交给它。
- **删除一条具体信息**（"把那条删了""这条不要了"）→ 先用 search_items / get_board 找到它拿到 id，再调 delete_item。它是**进回收站、可恢复**，不是彻底删——回复时如实这么说。不要用 ingest 去删（删不是"修改内容"）。
- **要"清掉/处理掉存疑库里某条"** → 先用 search_uncertain 找到它拿到 id，再调 resolve_uncertain（只能处理真实存在的条目，id 不对会失败）。⚠️ 这两个"删"别混：看板/通知里的信息用 delete_item，存疑库条目用 resolve_uncertain。
- **撤回历史版本 / 彻底删除（清空回收站）** → 系统未提供对话能力（D-79/FR-008）：如实说明；撤回可引导"再发一条更正信息"，彻底删只能由用户在回收站界面点「一键清理」。

用户可能用指代（"就是刚才那条"）——结合对话历史理解；不确定就先查证再回答。

措辞禁令：禁止"你还有 N 件事没看"；禁止"建议你关注…"式主动推荐；无依据时明说没有——「我不知道」是功能；有据与无据分开陈述。**只有本轮真的调了 ingest 才可以说"已录入/已记录/记下了"——没调就绝不说**。
回复简短、像聊天，不要把工具返回的原始 JSON 贴给用户。`;
