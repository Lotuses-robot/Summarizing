import {
  GetItemArgsSchema,
  SearchKbArgsSchema,
  SearchItemsArgsSchema,
  SearchRecentRawsArgsSchema,
  SearchUncertainArgsSchema,
  type ChangeList,
  type Provenance,
  type RawInput,
} from "@summarizing/shared";
import type { Db } from "../../storage/db";
import * as repo from "../../storage/repo";
import type { ChatMsg, LlmClient } from "../../shared/llm";
import { describeRejections, parseChangeList, runFence } from "./fence";
import { DIGEST_SYSTEM_PROMPT } from "./prompt";
import { TOOL_DEFS, type AgentTools, type ToolContext } from "./tools";
import { executeChanges } from "./executor";

// 消化管线（01§4.10 全景）：
// ① 入口 RawInput（已落档）→ ② 自由推理（工具循环）→ ③ 变更清单
// → ④ 行为围栏（拒收回喂一次，再失败放弃留痕）→ ⑤ 逐项落笔 → ⑥ 事后可查。

const MAX_TOOL_ROUNDS = 8;

export interface DigestResult {
  state: "digested" | "failed";
  note: string;
  appliedCount: number;
}

/** 消化一条 RawInput 的完整管线（01§4.10）：推理→围栏→落笔；任何失败标「未处理」，原文永不丢。 */
export async function digestRawInput(
  db: Db,
  llm: LlmClient,
  tools: AgentTools,
  modelTag: string,
  raw: RawInput,
): Promise<DigestResult> {
  const by: Provenance = { actor: "agent0", model: modelTag };
  try {
    const list = await elicitChangeList(llm, tools, raw);

    let { accepted, rejected } = runFence(db, raw, list);
    if (rejected.length > 0) {
      // 拒收项报错回给 agent0，可修正清单再提交一次（01§4.10④）。
      // 修正轮本身失败（如网关抖动）不得拖垮已通过围栏的项——降级为「放弃拒收项并留痕」。
      const repaired = await requestRepair(llm, rejected).catch(() => null);
      if (repaired !== null) {
        const second = runFence(db, raw, repaired);
        accepted = [...accepted, ...second.accepted];
        rejected = second.rejected;
      }
    }

    const { details } = executeChanges(db, raw, accepted, by);

    for (const r of rejected) {
      // 再失败 → 放弃该项并留痕（不静默）
      repo.appendRawAudit(db, {
        rawInputId: raw.id,
        action: "fence_reject",
        detail: `围栏拒收并放弃：${r.reason}`,
        payload: r.item,
        by,
      });
    }

    const note =
      accepted.length === 0
        ? "评估后未产生变更（零变更合法）"
        : `应用 ${accepted.length} 项变更：${details.join("；")}`;
    repo.appendRawAudit(db, {
      rawInputId: raw.id,
      action: "digest_done",
      detail: note + (rejected.length > 0 ? `（围栏拒收 ${rejected.length} 项）` : ""),
      payload: { applied: details },
      by,
    });
    // 「置已消化」已并入 executeChanges 的事务（S2 评审：堵住提交后崩溃→重试双写的窗口）
    return { state: "digested", note, appliedCount: accepted.length };
  } catch (err) {
    // AI 挂了 ≠ 数据没了：原文已在库，标「未处理」且可见（01§5.3）。
    // 兜底写入自身再包一层尽力而为——「永不 reject」是本函数对全部调用方的契约（S2 simplify 轮收回各调用点护栏）
    const detail = errText(err);
    try {
      repo.setDigestState(db, raw.id, "failed");
      repo.appendRawAudit(db, {
        rawInputId: raw.id,
        action: "digest_failed",
        detail: `AI 处理失败，标记「未处理」：${detail}`,
        by: { actor: "系统", model: null },
      });
    } catch (auditErr) {
      process.stderr.write(`[digest] 失败留痕自身抛错（尽力而为）：${errText(auditErr)}\n`);
    }
    return { state: "failed", note: detail, appliedCount: 0 };
  }
}

export type RetryResult = { ok: true } | { ok: false; reason: "not_found" | "not_failed" };

/** 重试一条失败批次（D-71）：failed→pending 原子跃迁后重走完整消化管线（异步，即返）。
 *  仅 failed 可重试——已消化重试会重复落库（变更非幂等）；pending 可能仍在途，防双跑。
 *  「失败批次可从头重跑」依赖执行器整批回滚语义——该论证放在这里：这次状态跃迁归本函数所有，
 *  将来任何新调用方（CLI/批量口）走这里都不会绕过不变量。 */
export function retryRawInput(
  db: Db,
  llm: LlmClient,
  tools: AgentTools,
  modelTag: string,
  id: string,
): RetryResult {
  const raw = repo.getRawInput(db, id);
  if (!raw) return { ok: false, reason: "not_found" };
  if (!repo.setDigestStateIf(db, id, "failed", "pending")) {
    return { ok: false, reason: "not_failed" };
  }
  kickDigest(db, llm, tools, modelTag, raw, "retry");
  return { ok: true };
}

/** fire-and-forget 消化的唯一发射口：digestRawInput 承诺永不 reject（失败留痕尽力而为），
 *  这里再兜一层防「兜底自身抛错」变 unhandled rejection；from 标记发射来源供排障。
 *  log 可选注入结构化日志器（HTTP 入口传 fastify 的 req.log 保留请求上下文），缺省写 stderr。 */
export function kickDigest(
  db: Db,
  llm: LlmClient,
  tools: AgentTools,
  modelTag: string,
  raw: RawInput,
  from: string,
  log?: (msg: string) => void,
): void {
  void digestRawInput(db, llm, tools, modelTag, raw).catch((err) =>
    (log ?? ((msg: string) => process.stderr.write(`${msg}\n`)))(
      `[digest] 兜底泄漏（${from}）：${errText(err)}`,
    ),
  );
}

/** 异常 → 人话单行（日志与回喂共用；仓库内统一出处）。 */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 启动清扫（L11）：消化是进程内异步——进程死后 pending 永滞，而重启的这一刻不可能存在
 *  在途消化，所以「启动时仍是 pending」与「被中断的孤儿」严格等价，无需超时阈值。
 *  全部置为「未处理」：横幅可见、D-71 重试口可救（不可见不可救才是真丢失）。
 *  ⚠️ 单实例硬前提（S2 评审）：双进程并发时新实例会把旧实例在途的 pending 误扫成 failed，
 *  随后重试即双消化——本地单用户部署下成立，勿多开。 */
export function sweepOrphanPending(db: Db): void {
  const orphans = repo.listRawInputsByState(db, "pending");
  for (const raw of orphans) {
    repo.setDigestState(db, raw.id, "failed");
    repo.appendRawAudit(db, {
      rawInputId: raw.id,
      action: "startup_sweep",
      detail: "启动清扫：上次进程中断，本批未消化完——已标「未处理」，可重试",
      by: { actor: "系统", model: null },
    });
  }
}

/** 工具循环：让模型自由检索（它决定查什么、查几次），直到吐出合法变更清单或超轮数抛错。 */
async function elicitChangeList(
  llm: LlmClient,
  tools: AgentTools,
  raw: RawInput,
): Promise<ChangeList> {
  const messages: ChatMsg[] = [{ role: "user", content: buildUserBrief(raw) }];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const turn = await llm.chat({ system: DIGEST_SYSTEM_PROMPT, messages, tools: TOOL_DEFS });
    if (process.env.DIGEST_DEBUG === "1") {
      // 调试观察：每轮模型在干什么（开 DIGEST_DEBUG=1 查看）
      process.stderr.write(
        `[digest] round ${round}: toolCalls=${JSON.stringify(turn.toolCalls.map((t) => t.name))} content=${JSON.stringify((turn.content ?? "").slice(0, 300))}\n`,
      );
    }
    if (turn.toolCalls.length > 0) {
      messages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });
      const ctx = { sourceIdentity: raw.sourceIdentity, eventTime: raw.eventTime };
      for (const call of turn.toolCalls) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: await runTool(tools, call.name, call.argsJson, ctx),
        });
      }
      continue;
    }
    const parsed = parseChangeList(turn.content ?? "");
    if (parsed !== null) return parsed;
    messages.push({
      role: "user",
      content: `你的上一条输出不是合法的变更清单 JSON。请严格按系统提示词【输出格式】的字段表重新输出：只输出一个 JSON 对象 {"changes":[...]}，不要任何其他文字。`,
    });
  }
  throw new Error(`工具循环超过 ${MAX_TOOL_ROUNDS} 轮仍未产出合法变更清单`);
}

/** 执行一次工具调用并返回 JSON 结果；工具报错回喂给模型自行调整，不中断循环。
 *  ctx = 当前批次参照（信源+时刻）——信源阶段工具（search_recent_raws/search_uncertain）靠它做接近度。 */
async function runTool(
  tools: AgentTools,
  name: string,
  argsJson: string,
  ctx: ToolContext,
): Promise<string> {
  try {
    const args: unknown = JSON.parse(argsJson);
    switch (name) {
      case "search_items":
        return JSON.stringify(await tools.searchItems(SearchItemsArgsSchema.parse(args)));
      case "search_kb":
        return JSON.stringify(await tools.searchKb(SearchKbArgsSchema.parse(args)));
      case "get_item":
        return JSON.stringify(await tools.getItem(GetItemArgsSchema.parse(args)));
      case "search_recent_raws":
        return JSON.stringify(
          await tools.searchRecentRaws(SearchRecentRawsArgsSchema.parse(args), ctx),
        );
      case "search_uncertain":
        return JSON.stringify(
          await tools.searchUncertain(SearchUncertainArgsSchema.parse(args), ctx),
        );
      default:
        return JSON.stringify({ error: `未知工具: ${name}` });
    }
  } catch (err) {
    // 工具报错回给模型让它自己调整，而不是中断整个循环
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** 围栏拒收后给模型一次修正机会（01§4.10④）：只回喂被拒项与原因。 */
async function requestRepair(
  llm: LlmClient,
  rejected: { item: ChangeList["changes"][number]; reason: string }[],
): Promise<ChangeList | null> {
  const res = await llm.chat({
    system: DIGEST_SYSTEM_PROMPT,
    tools: [],
    messages: [
      {
        role: "user",
        content: `你提交的变更清单中有 ${rejected.length} 项被围栏拒收：\n${describeRejections(rejected)}\n请只针对被拒收的项修正后重新提交（其余项保持原样），同样只输出 {"changes":[...]}。`,
      },
    ],
  });
  return parseChangeList(res.content ?? "");
}

/** 拼装给模型的原始信息简报——事件时间显式给出，防相对日期被锚到接收时间。 */
function buildUserBrief(raw: RawInput): string {
  return [
    "[原始信息]",
    `内容（逐字）：${raw.content}`,
    `来源类型：${raw.sourceType}`,
    `来源身份：${JSON.stringify(raw.sourceIdentity)}`,
    `事件时间：${raw.eventTime ?? "未知（相对日期无锚，禁止按接收时间兜底）"}`,
    `接收时间：${raw.receivedAt}`,
    "",
    "请处理这条信息（按系统规则产出变更清单）。",
  ].join("\n");
}
