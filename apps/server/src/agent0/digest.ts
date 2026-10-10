import {
  DIGEST_MAX_ROUNDS,
  errText,
  GetItemArgsSchema,
  SearchKbArgsSchema,
  SearchItemsArgsSchema,
  SearchRecentRawsArgsSchema,
  SearchUncertainArgsSchema,
  type ChangeList,
  type DigestState,
  type Provenance,
  type RawInput,
} from "@summarizing/shared";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import type { ChatMsg, LlmClient } from "../shared/llm";
import { describeRejections, parseChangeList, runFence } from "../executor/fence";
import { DIGEST_SYSTEM_PROMPT } from "./prompt";
import { TOOL_DEFS, type AgentTools, type ToolContext } from "./tools";
import { executeChanges } from "../executor/executor";

// 消化管线（01§4.10 全景）：
// ① 入口 RawInput（已落档）→ ② 自由推理（工具循环，轮数上限 DIGEST_MAX_ROUNDS 在 shared）
// → ③ 变更清单 → ④ 行为围栏（拒收回喂一次，再失败放弃留痕）→ ⑤ 逐项落笔 → ⑥ 事后可查。

/** 兜底日志：stderr 自身不可写时静默——catch 块内的最后一级，绝不允许「留痕失败」再抛（八轮评审）。 */
function bestEffortLog(msg: string): void {
  try {
    process.stderr.write(`${msg}\n`);
  } catch {
    // stderr 已死——无处可写
  }
}

/** 尽力而为流水留痕：appendPipelineEvent 失败只记 stderr（含批次 id 与 action），绝不拖垮
 *  消化主流程。label 参数已收敛——日志前缀直接取 event.action（九轮评审：防两处字符串漂移）。 */
function appendPipelineEventBestEffort(
  db: Db,
  rawId: string,
  event: { action: string; detail: string; payload?: unknown },
  by: Provenance,
): void {
  try {
    repo.appendPipelineEvent(db, { rawInputId: rawId, ...event, by });
  } catch (err) {
    bestEffortLog(`[digest] ${event.action} 留痕失败（raw=${rawId}，尽力而为）：${errText(err)}`);
  }
}

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
    const list = await elicitChangeList(db, llm, tools, modelTag, raw);

    const { accepted, rejected } = runFence(db, raw, list);
    // 拒收项留痕先于修复轮（十轮评审定案：先拒、后修，时序即因果）；写失败抛进外层 catch
    // （批次标 failed、可重试）——直呼 repo 不走尽力而为助手（吞错会让「失败可重试」不可达）。
    // detail 不写「并放弃」——修复轮可能救回，最终裁决以 repair_round 流水为准。
    for (const r of rejected) {
      repo.appendPipelineEvent(db, {
        rawInputId: raw.id,
        action: "fence_reject",
        detail: `围栏拒收：${r.reason}`,
        payload: r.item,
        by,
      });
    }
    if (rejected.length > 0) {
      // 拒收项报错回给 agent0，可修正清单再提交一次（01§4.10④）。
      // 修正轮本身失败（如网关抖动）不得拖垮已通过围栏的项——降级为「放弃拒收项并留痕」。
      // 修复调用失败本身也记 stderr（九轮评审：网关故障 ≠ 模型不修复，须可分辨）。
      const repaired = await requestRepair(llm, rejected).catch((err) => {
        bestEffortLog(`[digest] 修复轮调用失败（raw=${raw.id}）：${errText(err)}`);
        return null;
      });
      if (repaired === null) {
        // 修复轮跑过且失败——落流水与「从未尝试」可分辨（十轮评审）
        appendPipelineEventBestEffort(
          db,
          raw.id,
          {
            action: "repair_round",
            detail: "修复轮调用失败（网关/解析失败），拒收项维持原判",
            payload: { rejected: rejected.length },
          },
          by,
        );
      } else {
        const second = runFence(db, raw, repaired);
        // 修复轮常按「其余项保持原样」回吐全量清单——按 JSON 相等去重，防 create_item 双落库
        // （九轮评审）；其新增拒收同样留痕（九轮评审：被拒过就要有行可查）。
        const seenKeys = new Set([
          ...accepted.map((a) => JSON.stringify(a)),
          ...rejected.map((r) => JSON.stringify(r.item)),
        ]);
        let fixed = 0;
        for (const a of second.accepted) {
          const key = JSON.stringify(a);
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            accepted.push(a);
            fixed += 1;
          }
        }
        for (const r of second.rejected) {
          const key = JSON.stringify(r.item);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          rejected.push(r);
        }
        appendPipelineEventBestEffort(
          db,
          raw.id,
          {
            action: "repair_round",
            detail: `修复轮：修正 ${fixed} 项，仍拒收 ${second.rejected.length} 项`,
            payload: { fixed, stillRejected: second.rejected.length },
          },
          by,
        );
      }
    }

    const { details } = executeChanges(db, raw, accepted, by);

    // 谓词与计数同源（details.length）——执行器会静默跳过空 setElements 的项，
    // 按 accepted 计数会虚报「应用 N 项」（九轮评审）。
    const note =
      details.length === 0
        ? "评估后未产生变更（零变更合法）"
        : `应用 ${details.length} 项变更：${details.join("；")}`;
    // digest_done 留痕尽力而为——此处已在 executeChanges 提交（digested）之后，审计写失败
    // 绝不允许窜进外层 catch 把已消化批次错标 failed → 重试双落库（七轮评审）。
    // 计数用 details.length（执行器实写数）而非 accepted.length——空 setElements 会被执行器
    // 静默跳过，按 accepted 计数会虚报（九轮评审）。
    appendPipelineEventBestEffort(
      db,
      raw.id,
      {
        action: "digest_done",
        detail: note + (rejected.length > 0 ? `（围栏拒收 ${rejected.length} 项）` : ""),
        payload: { applied: details },
      },
      by,
    );
    // 「置已消化」已并入 executeChanges 的事务（S2 评审：堵住提交后崩溃→重试双写的窗口）
    return { state: "digested", note, appliedCount: details.length };
  } catch (err) {
    // AI 挂了 ≠ 数据没了：原文已在库，标「未处理」且可见（01§5.3）。
    // 兜底写入自身再包一层尽力而为——「永不 reject」是本函数对全部调用方的契约（S2 simplify 轮收回各调用点护栏）
    const detail = errText(err);
    try {
      repo.setDigestState(db, raw.id, "failed");
      repo.appendPipelineEvent(db, {
        rawInputId: raw.id,
        action: "digest_failed",
        // 「处理失败」而非「AI 处理失败」——本地库错混在异常里时，「AI」归因会误导排障（十轮评审）
        detail: `处理失败，标记「未处理」：${detail}`,
        by: { actor: "系统", model: null },
      });
    } catch (auditErr) {
      bestEffortLog(`[digest] 失败留痕自身抛错（尽力而为）：${errText(auditErr)}`);
    }
    return { state: "failed", note: detail, appliedCount: 0 };
  }
}

export type RetryResult =
  { ok: true; digestState: DigestState } | { ok: false; reason: "not_found" | "not_failed" };

/** 重试一条失败批次（D-71）：failed→pending 原子跃迁后重走完整消化管线（异步，即返）。
 *  仅 failed 可重试——已消化重试会重复落库（变更非幂等）；pending/digesting 可能仍在途，防双跑。
 *  「失败批次可从头重跑」依赖执行器整批回滚语义——该论证放在这里：这次状态跃迁归本函数所有，
 *  将来任何新调用方（CLI/批量口）走这里都不会绕过不变量。返回置位结果供回执（specs/004 八轮评审）。 */
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
  const digestState = kickDigest(db, llm, tools, modelTag, raw, "retry");
  return { ok: true, digestState };
}

/** fire-and-forget 消化的唯一发射口：digestRawInput 承诺永不 reject（失败留痕尽力而为），
 *  这里再兜一层防「兜底自身抛错」变 unhandled rejection；from 标记发射来源供排障。
 *  log 可选注入结构化日志器（HTTP 入口传 fastify 的 req.log 保留请求上下文），缺省写 stderr。
 *  返回 digesting 置位结果——"digesting"（成功）| "pending"（置位失败但照常发射，七轮评审降级）；
 *  回执 MUST 用它而非发射前快照（specs/004 八轮评审：不报与库不符的状态）。 */
export function kickDigest(
  db: Db,
  llm: LlmClient,
  tools: AgentTools,
  modelTag: string,
  raw: RawInput,
  from: string,
  log?: (msg: string) => void,
): "digesting" | "pending" {
  // 发射即置「消化中」——尽力而为：库异常时滞留 pending 照常发射（stderr 留痕；七轮评审），
  // 置位结果如实返回供回执（specs/004 八轮评审：不报与库不符的快照）。
  let bumped: "digesting" | "pending" = "pending";
  try {
    repo.setDigestState(db, raw.id, "digesting");
    bumped = "digesting";
  } catch (stateErr) {
    bestEffortLog(`[digest] digesting 置位失败（raw=${raw.id}，尽力而为）：${errText(stateErr)}`);
  }
  void digestRawInput(db, llm, tools, modelTag, raw).catch((err) =>
    (log ?? bestEffortLog)(`[digest] 兜底泄漏（${from}）：${errText(err)}`),
  );
  return bumped;
}

/** 启动清扫（L11 + specs/004 FR-005）：消化是进程内异步——进程死后 pending/digesting 永滞，
 *  而重启的这一刻不可能存在在途消化，所以「启动时仍是 pending/digesting」与「被中断的孤儿」
 *  严格等价，无需超时阈值。全部置为「未处理」：横幅可见、D-71 重试口可救（不可见不可救才是真丢失）。
 *  ⚠️ 单实例硬前提（S2 评审）：双进程并发时新实例会把旧实例在途的批次误扫成 failed，
 *  随后重试即双消化——本地单用户部署下成立，勿多开。 */
export function sweepOrphanPending(db: Db): void {
  const orphans = [
    ...repo.listRawInputsByState(db, "pending"),
    ...repo.listRawInputsByState(db, "digesting"),
  ];
  for (const raw of orphans) {
    // 逐条尽力而为：单条写失败不弃剩余孤儿、不炸启动（孤儿困在 pending/digesting =
    // 「不可见不可救 = 真丢失」——本函数存在的意义就是防它，八轮评审）
    try {
      repo.setDigestState(db, raw.id, "failed");
      repo.appendPipelineEvent(db, {
        rawInputId: raw.id,
        action: "startup_sweep",
        detail: "启动清扫：上次进程中断，本批未消化完——已标「未处理」，可重试",
        by: { actor: "系统", model: null },
      });
    } catch (err) {
      bestEffortLog(`[digest] 启动清扫单条失败（raw=${raw.id}）：${errText(err)}`);
    }
  }
}

/** 工具循环：让模型自由检索（它决定查什么、查几次），直到吐出合法变更清单或超轮数抛错。
 *  每个带工具调用的轮次落一条 digest_trace 流水（specs/004 FR-006）——用户将来在流水视图
 *  看到「先查了什么、后查了什么」；轨迹写失败只记 stderr，绝不拖垮消化。 */
async function elicitChangeList(
  db: Db,
  llm: LlmClient,
  tools: AgentTools,
  modelTag: string,
  raw: RawInput,
): Promise<ChangeList> {
  const messages: ChatMsg[] = [{ role: "user", content: buildUserBrief(raw) }];
  let traced = 0; // 已落 trace 的轮次（1-based；清单解析失败的重试轮不产生 trace，故序号连续——七轮评审）
  for (let round = 0; round < DIGEST_MAX_ROUNDS; round++) {
    const turn = await llm.chat({ system: DIGEST_SYSTEM_PROMPT, messages, tools: TOOL_DEFS });
    if (turn.toolCalls.length > 0) {
      traced += 1;
      try {
        repo.appendPipelineEvent(db, {
          rawInputId: raw.id,
          action: "digest_trace",
          detail: `第 ${traced} 轮：${turn.toolCalls.map((t) => t.name).join("、")}`,
          payload: {
            round: traced,
            thought: (turn.content ?? "").slice(0, 500),
            tools: turn.toolCalls.map((t) => t.name),
          },
          by: { actor: "agent0", model: modelTag },
        });
      } catch (traceErr) {
        // 写失败不占号（traced 回退）——成功者的序号保持连续；绝不拖垮消化（八轮评审）
        traced -= 1;
        bestEffortLog(
          `[digest] digest_trace 留痕失败（raw=${raw.id}，尽力而为）：${errText(traceErr)}`,
        );
      }
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
  throw new Error(`工具循环超过 ${DIGEST_MAX_ROUNDS} 轮仍未产出合法变更清单`);
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
    return JSON.stringify({ error: errText(err) });
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
