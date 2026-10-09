import {
  ChangeListSchema,
  type ChangeItem,
  type Provenance,
  type UncertainInput,
} from "@summarizing/shared";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import type { ChatMsg, LlmClient } from "../shared/llm";
import { resolveUncertainWellFormed } from "../executor/fence";
import { executeChanges } from "../executor/executor";

// 存疑库清扫循环（D-85）：复核 open 条目——被取代/证伪/重复的丢弃留痕，仍有效的不动。
// 双入口共用：对话触发（前台工具）+ POST /api/uncertain/sweep。
// 围栏只许动库（只接受 resolve_uncertain 一个动作，其余全部忽略）——清扫绝不碰事项。
// ⚠️ 本文件是第二个执行者任务（清扫 agent：独立提示词/独立围栏约束）——暂居 agent0 目录，
//    独立成模块与「agent 机制对齐」同为观察项（2026-10-09 布局定稿）。

const MAX_ROUNDS = 20; // 一次最多复核这么多条目（防失控；单机库规模远小于此）

/** 清扫循环的产出统计（端点响应 / 对话回话）。 */
export interface SweepResult {
  evaluated: number; // 复核条目数
  discarded: number; // 被丢弃数（discarded）
  busy?: boolean; // 已在清扫中，本轮被拒（互斥，评审 A2）
}

/** 清扫提示词：逐条复核 open 条目，判断是否已被取代/证伪/重复。 */
const SWEEP_SYSTEM_PROMPT = `你是 agent0 的存疑库清扫环节。库里存着过去拿不准的原始信息（open 条目）。
判断这一条现在还需要人来处理吗？
- 已被后续信息取代 / 证伪 / 与另一条重复 → resolve_uncertain 关闭它（outcome="discarded"，note 说明理由）。
- 仍然有效、确实需要人看 → 不动它，输出空清单。
严格只输出 {"changes":[...]}；**只允许 resolve_uncertain 一个动作**，禁止任何改动事项的动作。
没有需要关闭的就输出 {"changes":[]}。`;

/** 清扫一条条目的用户简报（时刻信息完整给出，让 agent0 自判陈旧）。 */
function sweepBrief(entry: UncertainInput): string {
  return [
    "[待复核的存疑条目]",
    `id：${entry.id}`,
    `原话：${entry.content}`,
    `信源：${JSON.stringify(entry.sourceIdentity)}`,
    `事件时间：${entry.eventTime ?? "未知"}`,
    `入库时间：${entry.createdAt}`,
    `需人工分：${entry.needsHuman}`,
    `理由：${entry.reason}`,
    "",
    "请判断这条还需要保留吗（按系统规则产出变更清单）。",
  ].join("\n");
}

/** 清扫中的互斥标志：同一时刻只允许一轮清扫在跑。
 *  防「用户重复点击 / 对话连发」导致两轮并发——两轮各自 resolve 同一条目，
 *  后到的会覆盖先到的处置（评审 A2）。进程内单实例，模块级即可。 */
let sweeping = false;

/** 清扫循环：逐条复核 open 条目，agent0 自主决定丢弃哪些（只接受 resolve_uncertain）。
 *  条目缺来源批次（不应发生）则跳过该条——不因一条坏数据回滚整轮。
 *  from = 触发来源（"chat" / "api"）——进 by 署名，回溯「谁触发的清扫」。
 *  ⚠️ markDigested:false——来源批次是历史批次，把它改写 digested 会吞掉 failed 告警（评审 H4）。 */
export async function sweepUncertainLibrary(
  db: Db,
  llm: LlmClient,
  modelTag: string,
  from: string,
): Promise<SweepResult> {
  // 互斥：已在清扫则拒绝这一轮（防并发覆盖处置，评审 A2）
  if (sweeping) {
    return { evaluated: 0, discarded: 0, busy: true };
  }
  sweeping = true;
  try {
    return await runSweep(db, llm, modelTag, from);
  } finally {
    sweeping = false;
  }
}

/** 清扫实体（由 sweepUncertainLibrary 包互斥调用）。 */
async function runSweep(
  db: Db,
  llm: LlmClient,
  modelTag: string,
  from: string,
): Promise<SweepResult> {
  const by: Provenance = { actor: `清扫(${from})`, model: modelTag };
  const open = repo.listUncertainByStatus(db, "open").slice(0, MAX_ROUNDS);
  let discarded = 0;
  let touched = 0; // 真正处置了的条目数（区别于 evaluated：含解析失败/无动作的跳过）
  let anchorRawInputId: string | null = null; // 汇总审计的锚 = 首个实际处置条目的来源批次

  for (const entry of open) {
    const origin = entry.originRawInputId ? repo.getRawInput(db, entry.originRawInputId) : null;
    if (!origin) {
      process.stderr.write(`[sweep] 条目 ${entry.id} 缺来源批次，跳过\n`);
      continue;
    }
    try {
      const messages: ChatMsg[] = [{ role: "user", content: sweepBrief(entry) }];
      const turn = await llm.chat({ system: SWEEP_SYSTEM_PROMPT, messages, tools: [] });
      const parsed = ChangeListSchema.safeParse(safeJson(turn.content ?? ""));
      if (!parsed.success) continue; // 解析失败：跳过（不清扫即保留，保守）
      // 围栏：只保留指向本条目的 resolve_uncertain；形状规则（merged 必给去向）与 digest 围栏共用同一谓词
      const allowed = parsed.data.changes.filter(
        (c): c is Extract<ChangeItem, { action: "resolve_uncertain" }> =>
          c.action === "resolve_uncertain" && c.id === entry.id && resolveUncertainWellFormed(c),
      );
      if (allowed.length === 0) continue;
      // 整批事务：返回即全部落笔——丢弃数直接数围栏后的清单，无需执行器回传结构
      executeChanges(db, origin, allowed, by, { markDigested: false });
      touched += allowed.length;
      discarded += allowed.filter((c) => c.outcome === "discarded").length;
      anchorRawInputId ??= origin.id;
    } catch (err) {
      process.stderr.write(`[sweep] 复核条目 ${entry.id} 失败：${String(err)}\n`);
    }
  }

  // 每轮一条汇总审计（触发来源/处置量可回溯；逐条审计已由执行器事务内落过，不重复）
  const anchor = anchorRawInputId ? repo.getRawInput(db, anchorRawInputId) : null;
  if (anchor !== null) {
    repo.appendRawAudit(db, {
      rawInputId: anchor.id,
      action: "sweep_done",
      detail: `存疑库清扫（触发：${from}）：复核 ${open.length} 条，处置 ${touched} 条（丢弃 ${discarded}）`,
      by: { actor: `清扫(${from})`, model: null }, // 汇总审计：触发来源，非模型署名
    });
  }

  return { evaluated: open.length, discarded };
}

/** 尝试把模型输出解析成 JSON 对象；失败返回 null（ChangeListSchema.safeParse 会拒）。 */
function safeJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/** 把清扫统计拼成人话（对话回话用）。 */
export function describeSweep(result: SweepResult): string {
  if (result.busy === true) return "上一次清扫还在进行中，请稍候再试。";
  if (result.evaluated === 0) return "存疑库里目前没有待复核的条目。";
  return `清扫完成：复核 ${result.evaluated} 条，丢弃 ${result.discarded} 条。`;
}
