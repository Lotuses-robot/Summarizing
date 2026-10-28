import {
  DIGEST_MAX_ROUNDS,
  errText,
  FetchImageArgsSchema,
  GetItemArgsSchema,
  SearchKbArgsSchema,
  SearchItemsArgsSchema,
  GetRawArgsSchema,
  SearchRawsArgsSchema,
  SearchUncertainArgsSchema,
  type ChangeList,
  type DigestState,
  type Provenance,
  type RawInput,
} from "@summarizing/shared";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import type { ChatMsg, LlmClient, ToolCall, LlmUsage } from "../shared/llm";
import { UNCONFIGURED_MODEL_TAG } from "../shared/llm";
import { recordUsage } from "../shared/usage";
import { describeRejections, parseChangeListDetailed, runFence } from "../executor/fence";
import { buildDigestPrompt } from "./prompt";
import { TOOL_DEFS, type AgentTools, type ToolContext } from "./tools";
import { executeChanges } from "../executor/executor";
import { uncitedMediaExpiry } from "../shared/mediaTtl";
import { nowWallClock } from "../shared/time";
import { cacheIngestImages, type MediaFetcherLookup } from "../application/mediaIngest";

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

/** 变更清单原文的留存上限（字符）。
 *
 *  为什么不无限存：一条清单可能带几十项、每项几段引文，逐字全存会让 `pipeline_events.payload`
 *  单行涨到几十 KB，而流水页是「列表 + 展开」的高频读取面。4,000 字足够看清模型请求的一切，
 *  超出部分**明确标注被截断**（不静默裁掉）。
 */
const RAW_CHANGE_LIST_MAX_CHARS = 4000;

/** 截断变更清单原文；超长时在末尾标注原长度（读者能判断自己少看了多少）。 */
function truncateRaw(text: string): string {
  if (text.length <= RAW_CHANGE_LIST_MAX_CHARS) return text;
  return `${text.slice(0, RAW_CHANGE_LIST_MAX_CHARS)}\n…（原文共 ${text.length} 字，此处截断）`;
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
    const { list, readMedia, rawText } = await elicitChangeList(db, llm, tools, modelTag, raw);

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
      const repaired = await requestRepair(llm, db, modelTag, rejected).catch((err) => {
        bestEffortLog(`[digest] 修复轮调用失败（raw=${raw.id}）：${errText(err)}`);
        return { ok: false as const, reason: `调用失败：${errText(err)}` };
      });
      if (!repaired.ok) {
        // 修复轮跑过且失败——落流水与「从未尝试」可分辨（十轮评审）；
        // **原因写清**（调用失败 / 没有 JSON / 字段不合规+路径），别让「网关/解析失败」一句话盖住三种情况
        appendPipelineEventBestEffort(
          db,
          raw.id,
          {
            action: "repair_round",
            detail: `修复轮未产出可用清单（${repaired.reason}），拒收项维持原判`,
            payload: { rejected: rejected.length, reason: repaired.reason },
          },
          by,
        );
      } else {
        const second = runFence(db, raw, repaired.list);
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

    // 修正轮里有 await（LLM 调用，秒级窗口）——期间用户可能已把首轮通过的某条删进回收站。
    // 执行前按**当前**状态复检一遍围栏：漂移项降为拒收并留痕，而不是让执行器抛错把整批回滚
    // （与「一条坏 target 不拖垮整批」的既有取向一致：record_note 降级、resolve_uncertain 幂等跳过）。
    if (rejected.length > 0) {
      const recheck = runFence(db, raw, { changes: accepted });
      if (recheck.rejected.length > 0) {
        accepted.splice(0, accepted.length, ...recheck.accepted);
        for (const r of recheck.rejected) {
          rejected.push(r);
          appendPipelineEventBestEffort(
            db,
            raw.id,
            {
              action: "fence_reject",
              detail: `执行前复检拒收：${r.reason}`,
              payload: r.item,
            },
            by,
          );
        }
      }
    }

    const { details, citedMediaIds } = executeChanges(db, raw, accepted, by);

    // 读过但没被证据引用的图只留 3 天（009；只提前不延后，原值更早则不动）。
    // ⚠️ 尽力而为：此处变更已提交，这里再抛会把已消化的批次错标「未处理」→ 重试双落库（同 digest_done）。
    for (const [mediaId, readAt] of readMedia) {
      if (citedMediaIds.has(mediaId)) continue;
      try {
        // 跨批否决：**任何一批**的证据引过它就不缩短——否则 A 批引用过的图会被 B 批的
        // 「读过没引用」缩到 3 天，A 批的证据链当场断（本批 citedMediaIds 只看得见本批）
        if (repo.isMediaCited(db, mediaId)) continue;
        repo.shortenMediaExpiry(db, mediaId, uncitedMediaExpiry(readAt));
      } catch (err) {
        bestEffortLog(`[media] 缩短未引用图片留存失败（${mediaId}）：${errText(err)}`);
      }
    }

    // 谓词与计数同源（details.length）——执行器会静默跳过空 elements 的项，
    // 按 accepted 计数会虚报「应用 N 项」（九轮评审）。
    const note =
      details.length === 0
        ? "评估后未产生变更（零变更合法）"
        : `应用 ${details.length} 项变更：${details.join("；")}`;
    // digest_done 留痕尽力而为——此处已在 executeChanges 提交（digested）之后，审计写失败
    // 绝不允许窜进外层 catch 把已消化批次错标 failed → 重试双落库（七轮评审）。
    // 计数用 details.length（执行器实写数）而非 accepted.length——空 elements 会被执行器
    // 静默跳过，按 accepted 计数会虚报（九轮评审）。
    appendPipelineEventBestEffort(
      db,
      raw.id,
      {
        action: "digest_done",
        detail: note + (rejected.length > 0 ? `（围栏拒收 ${rejected.length} 项）` : ""),
        // `raw` = 模型提交的变更清单原文（逐字；超长截断并标注）——用户要看的就是这段。
        // `applied` = 执行器实际落库的项（与 raw 的差别来自围栏拒收与执行器的空项跳过）。
        payload: { applied: details, raw: truncateRaw(rawText) },
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

/** 启动自动重试（D-116）：只对**本次启动清扫扫出的**被打断批次调用——历史 failed 批次不碰，
 *  不然每次重启都会把以前失败的全再烧一遍 token。逐条走 D-71 的唯一入口 `retryRawInput`
 *  （failed→pending 原子跃迁 + kickDigest），不另开一条写入路径。
 *  跳过条件：①AI 未配置（重试必然立刻失败，白留一批噪音流水）；②该批已自动重试过
 *  （流水里有 startup_retry）——自动重试只救一次，反复「重启即中断」的批次（如每次都把进程耗死）
 *  不再自动重来，退回可见的「未处理」+ 手动重试，避免重启循环。
 *  单条失败只留痕，不拖垮其余与启动。返回实际发射的条数（测试与调用方核对「只重试了该重试的」）。 */
export function retryInterruptedOnStartup(
  db: Db,
  llm: LlmClient,
  tools: AgentTools,
  modelTag: string,
  interrupted: RawInput[],
  mediaDir: string,
  mediaLookup?: MediaFetcherLookup,
): number {
  if (interrupted.length === 0) return 0;
  // 未配置时启动重试必然失败；留一条可见说明，不假装「重试过了」（跳过原因不静默）
  if (modelTag === UNCONFIGURED_MODEL_TAG) {
    bestEffortLog(
      `[digest] 启动重试跳过（AI 尚未配置）：${interrupted.length} 个被中断的批次仍是「未处理」，配置后可手动重试`,
    );
    return 0;
  }
  let started = 0;
  for (const raw of interrupted) {
    try {
      // 自动重试只救一次：已经自动重试过的批次不再自动重来（防「重启即中断」无限循环）
      const alreadyRetried = repo
        .listPipelineEvents(db, raw.id)
        .some((e) => e.action === "startup_retry");
      if (alreadyRetried) {
        bestEffortLog(
          `[digest] 启动重试跳过（raw=${raw.id}）：本批已自动重试过一次，仍停在「未处理」，请手动重试`,
        );
        continue;
      }
      const result = retryRawInput(db, llm, tools, modelTag, raw.id, mediaDir, mediaLookup);
      if (!result.ok) {
        bestEffortLog(
          `[digest] 启动重试未发射（raw=${raw.id}，${result.reason}）——批次状态在清扫后被改动过`,
        );
        continue;
      }
      started += 1;
      repo.appendPipelineEvent(db, {
        rawInputId: raw.id,
        action: "startup_retry",
        detail: "启动自动重试：上次进程在消化途中中断，重新开始本批消化",
        by: { actor: "系统", model: null },
      });
    } catch (err) {
      // 单条失败（跃迁或流水写失败）只留痕——其余批次照跑，启动不受影响
      bestEffortLog(`[digest] 启动自动重试单条失败（raw=${raw.id}）：${errText(err)}`);
    }
  }
  return started;
}

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
  mediaDir: string,
  mediaLookup?: MediaFetcherLookup,
): RetryResult {
  const raw = repo.getRawInput(db, id);
  if (!raw) return { ok: false, reason: "not_found" };
  if (!repo.setDigestStateIf(db, id, "failed", "pending")) {
    return { ok: false, reason: "not_failed" };
  }
  const digestState = kickDigest(
    db,
    llm,
    tools,
    modelTag,
    raw,
    "retry",
    mediaDir,
    undefined,
    mediaLookup,
  );
  return { ok: true, digestState };
}

/** fire-and-forget 消化的唯一发射口：digestRawInput 承诺永不 reject（失败留痕尽力而为），
 *  这里再兜一层防「兜底自身抛错」变 unhandled rejection；from 标记发射来源供排障。
 *  **图片进站缓存也挂在这里**（009）：所有进站路径（HTTP/信源/对话/兜底录入/重试）都必须经过本函数，
 *  放在这一处才不会「某条路悄悄不缓存」（曾只有 ingestBatch 调，重试与对话路径漏掉）。
 *  **顺序是先缓存、后消化**：执行器写证据时要按占位查到 media 行，行没落库就抬不了 90 天。
 *  mediaDir 必填（同 ingestBatch 的理由）；无媒体目录的场景显式传空串。
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
  mediaDir: string,
  log?: (msg: string) => void,
  /** 按信源名查「媒体占位取字节」实现——由调用方提供查表口（见 `MediaFetcherLookup`）。 */
  mediaLookup?: MediaFetcherLookup,
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
  /** 真正发射消化（缓存跑完之后）。 */
  const fire = (): void => {
    void digestRawInput(db, llm, tools, modelTag, raw).catch((err) =>
      (log ?? bestEffortLog)(`[digest] 兜底泄漏（${from}）：${errText(err)}`),
    );
  };
  // **先缓存、再消化**（009）：执行器写证据时按占位查 media 行，行还没落库就抬不了 90 天
  // （慢下载必踩）。串行还省掉一次重复下载——缓存落地后 agent0 的 fetch_image 直接本地命中。
  // 两者都在后台，进站回执照旧立即返回（信源等的是 202）。
  if (mediaDir === "") fire();
  else void cacheIngestImages(db, mediaDir, raw.id, mediaLookup?.(raw.source)).then(fire);
  return bumped;
}

/** 启动清扫（L11 + specs/004 FR-005）：消化是进程内异步——进程死后 pending/digesting 永滞，
 *  而重启的这一刻不可能存在在途消化，所以「启动时仍是 pending/digesting」与「被中断的孤儿」
 *  严格等价，无需超时阈值。全部置为「未处理」：横幅可见、D-71 重试口可救（不可见不可救才是真丢失）。
 *  **返回本次扫出的批次**（D-116）：启动自动重试只认这批——历史 failed 批次不在其中，不会被反复烧 token。
 *  ⚠️ 单实例硬前提（S2 评审）：双进程并发时新实例会把旧实例在途的批次误扫成 failed，
 *  随后重试即双消化——本地单用户部署下成立，勿多开。 */
export function sweepOrphanPending(db: Db): RawInput[] {
  const orphans = [
    ...repo.listRawInputsByState(db, "pending"),
    ...repo.listRawInputsByState(db, "digesting"),
  ];
  /** 只收「已确实落成 failed」的批次——状态没写成功的那条仍困在原状态，重试口也不会收它。 */
  const swept: RawInput[] = [];
  for (const raw of orphans) {
    // 逐条尽力而为：单条写失败不弃剩余孤儿、不炸启动（孤儿困在 pending/digesting =
    // 「不可见不可救 = 真丢失」——本函数存在的意义就是防它，八轮评审）
    try {
      repo.setDigestState(db, raw.id, "failed");
      swept.push(raw);
      repo.appendPipelineEvent(db, {
        rawInputId: raw.id,
        action: "startup_sweep",
        detail: "启动清扫：上次进程中断，本批未消化完——已标「未处理」",
        by: { actor: "系统", model: null },
      });
    } catch (err) {
      bestEffortLog(`[digest] 启动清扫单条失败（raw=${raw.id}）：${errText(err)}`);
    }
  }
  return swept;
}

/** 工具循环：让模型自由检索（它决定查什么、查几次），直到吐出合法变更清单或超轮数抛错。
 *  每个带工具调用的轮次落一条 digest_trace 流水（specs/004 FR-006）——用户将来在流水视图
 *  看到「先查了什么、后查了什么」；轨迹写失败只记 stderr，绝不拖垮消化。
 *  `readMedia` = 本批 agent0 实际看过的图（mediaId → 读取时刻），供读后留存判定（009）。 */
async function elicitChangeList(
  db: Db,
  llm: LlmClient,
  tools: AgentTools,
  modelTag: string,
  raw: RawInput,
): Promise<{ list: ChangeList; readMedia: Map<string, string>; rawText: string }> {
  // 消化开始时刻（本轮对话全程不变）：给模型一个明确的「现在」——补年份、判是否已过期都要它
  const digestAt = nowWallClock();
  const messages: ChatMsg[] = [{ role: "user", content: buildUserBrief(raw, digestAt) }];
  const readMedia = new Map<string, string>();
  let traced = 0; // 已落 trace 的轮次（1-based；清单解析失败的重试轮不产生 trace，故序号连续——七轮评审）
  let imageBudget = MAX_IMAGE_FETCHES; // 本批取图预算（防模型反复取图撑爆上下文/带宽）
  // 连续降级次数（成功一次即清零）。达 2 次才判定「这模型就是不能读图」——单次带图失败更可能是
  // 瞬时（429/超时），一失败就永久封杀会静默丢掉该批后续所有图片（审查 2026-10-14）。
  let degradedStreak = 0;
  let visionDisabled = false;
  /** 最后一轮模型到底回了什么——预算耗尽时并进报错，免得只留一句「超过 8 轮」无从追。 */
  let lastRoundSummary = "未发生任何一轮";
  /** 取一次取图额度：够则扣一次返回 null；否则返回拒因人话（回喂给模型、按纯文本继续）。
   *  守卫与扣减同一处（审查：曾分居两处各自判 `call.name === "fetch_image"`——防两处漂移）。 */
  const takeImageSlot = (): string | null => {
    if (visionDisabled) return "读图已降级为纯文本（带图调用失败）——不要再取图";
    if (imageBudget <= 0) return "本批取图已达上限，请按纯文本处理";
    imageBudget -= 1; // 尝试即计（含失败——预算防的是反复打网，不只防取到图；审查 2026-10-14）
    return null;
  };
  for (let round = 0; round < DIGEST_MAX_ROUNDS; round++) {
    const turn = await chatWithImageFallback(llm, db, raw, modelTag, messages);
    // 记下这一轮的形状（工具调用名 / 正文长度）——预算耗尽时它能说明是哪一步空转
    lastRoundSummary =
      turn.toolCalls.length > 0
        ? `工具调用 ${turn.toolCalls.map((t) => t.name).join("、")}`
        : (turn.content ?? "").trim() === ""
          ? "空回复（无正文、无工具调用）"
          : `正文 ${(turn.content ?? "").length} 字但非合法变更清单`;
    if (turn.degraded) {
      degradedStreak += 1;
      // 连续两次降级 = 模型确实读不了图 → 后续 fetch_image 直接拒（防死循环；单次降级不封杀）
      if (degradedStreak >= 2) visionDisabled = true;
      // 剥图落回本批消息体——后续轮次不再带图、不再重复留痕（审查 2026-10-14：曾只在重试调用里剥、
      // 不落回 messages，导致降级后每轮都重演一次带图失败 + 重复 image_degraded 留痕）。
      // 整批 messages 只替换一次（降级最多发生一回）：长度清零后逐个 push 已改好的元素，不重建数组。
      const stripped = stripImages(messages);
      messages.length = 0;
      messages.push(...stripped);
    } else {
      degradedStreak = 0; // 本轮没降级（含带图成功）→ 复位：不把「瞬时一次」记成「持续不可用」
    }
    /** 本轮的形状描述（工具名 / 空回复 / 正文未过校验）——留痕与耗尽报错共用一句话。 */
    const describeRound = (): string => {
      const names = turn.toolCalls.map((t) => t.name);
      if (names.length > 0) return names.join("、");
      const text = (turn.content ?? "").trim();
      return text === ""
        ? "空回复（无正文、无工具调用）"
        : `无工具调用（正文 ${text.length} 字，未通过变更清单校验）`;
    };
    /** **除成功收尾那一轮外，每一轮都留痕**（2026-10-22 用户定：「不能每一轮都记录下来吗」）。
     *  旧实现只记「有工具调用」的轮次，于是空回复/非法 JSON 的轮次在流水里完全消失：
     *  用户只看到第 1、2 轮，然后直接是「超过 8 轮仍未产出合法变更清单」，中间六轮为何空转无从追。
     *  收尾轮不留（它不是一次失败的尝试，进度条的「第 N/8 轮」也不该把成功那步算成额外一轮）。 */
    const traceRound = (): void => {
      traced += 1;
      try {
        repo.appendPipelineEvent(db, {
          rawInputId: raw.id,
          action: "digest_trace",
          detail: `第 ${traced} 轮：${describeRound()}`,
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
    };
    if (turn.toolCalls.length > 0) {
      traceRound();
      messages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });
      const ctx = { identity: raw.identity, eventTime: raw.eventTime };
      const images: string[] = []; // 本轮的图片 data URL（稍后作 user 消息注入模型）
      for (const call of turn.toolCalls) {
        if (call.name === "fetch_image") {
          // 预算耗尽 / 已降级 → 直接拒（回喂人话，模型按纯文本继续）
          const refusal = takeImageSlot();
          if (refusal !== null) {
            messages.push({
              role: "tool",
              toolCallId: call.id,
              content: JSON.stringify({ ok: false, reason: refusal }),
            });
            continue;
          }
        }
        const result = await runTool(tools, call.name, call.argsJson, ctx);
        messages.push({ role: "tool", toolCallId: call.id, content: result.text });
        if (result.image !== null) images.push(result.image);
        // 看过就记（每张图只记第一次读取的时刻——留存只该从最早那眼算起）
        if (result.mediaId !== null && !readMedia.has(result.mediaId)) {
          readMedia.set(result.mediaId, nowWallClock());
        }
      }
      // 取回的图作下一条 user 消息注入（OpenAI 协议 tool 结果只能放文本；图走 user 内容块）。
      // 降级后再不注入（否则模型仍收到图 = 白重试）。
      if (images.length > 0 && !visionDisabled) {
        messages.push({
          role: "user",
          content: images.map((url) => ({ type: "image_url", image_url: { url } })),
        });
      }
      continue;
    }
    const parsed = parseChangeListDetailed(turn.content ?? "");
    // rawText = 模型**提交的那段原文**（不含 JSON 围栏的正文，逐字）——流水详情要能看见
    // 「它到底请求改什么」，而不是只看我们解析后的结果（用户 2026-10-28 要求）。
    if (parsed.ok) return { list: parsed.value, readMedia, rawText: (turn.content ?? "").trim() };
    // 没拿到合法清单 = 这一轮空转了——留痕（含空回复 / 非法 JSON），流水里能看见它
    traceRound();
    /** 把这一轮的原样回复放回对话：**模型必须看见自己写了什么**才能改。旧实现只在
     *  「有工具调用」时 push assistant，于是非法轮次的追问等于凭空指责——模型看不到上文，
     *  只能把同样的散文再写一遍（2026-10-22 实测连败六轮）。
     *  空回复不入（没内容可看，且部分网关对空 assistant 消息不友好）。 */
    const empty = (turn.content ?? "").trim() === "";
    if (!empty) messages.push({ role: "assistant", content: turn.content });
    messages.push({
      role: "user",
      content: empty
        ? `你的上一条回复是空的（没有任何内容）。请按系统提示词【输出格式】输出一个 JSON 对象 {"changes":[...]}；这条信息若确实无需改动，就输出 {"changes":[]}。`
        : `你的上一条输出没有被接受：${parsed.reason}。请对照系统提示词【输出格式】的字段表改成合法清单后再发一次——**只输出一个 JSON 对象 {"changes":[...]}，不要任何解释、标题或代码围栏之外的文字**；这条信息若确实无需改动，就输出 {"changes":[]}。`,
    });
  }
  throw new Error(
    `工具循环超过 ${DIGEST_MAX_ROUNDS} 轮仍未产出合法变更清单（最后一轮：${lastRoundSummary}）`,
  );
}

/** 工具调用结果：text 是回喂模型的 JSON 文本；image 非空 = 该工具取回一张图（data URL），
 *  由调用方注入下一条 user 消息（OpenAI 协议的 tool 结果只能放文本）。
 *  mediaId = 取图落到的媒体（只有 fetch_image 有）；读后留存判定用（009）。 */
interface ToolRun {
  text: string;
  image: string | null;
  mediaId: string | null;
}

/** 执行一次工具调用并返回结果；工具报错回喂给模型自行调整，不中断循环。
 *  ctx = 当前批次参照（信源+时刻）——search_uncertain 靠它做接近度。 */
async function runTool(
  tools: AgentTools,
  name: string,
  argsJson: string,
  ctx: ToolContext,
): Promise<ToolRun> {
  try {
    const args: unknown = JSON.parse(argsJson);
    switch (name) {
      case "search_items":
        return {
          text: JSON.stringify(await tools.searchItems(SearchItemsArgsSchema.parse(args))),
          image: null,
          mediaId: null,
        };
      case "search_kb":
        return {
          text: JSON.stringify(await tools.searchKb(SearchKbArgsSchema.parse(args))),
          image: null,
          mediaId: null,
        };
      case "get_item":
        return {
          text: JSON.stringify(await tools.getItem(GetItemArgsSchema.parse(args))),
          image: null,
          mediaId: null,
        };
      case "search_raws":
        return {
          text: JSON.stringify(await tools.searchRaws(SearchRawsArgsSchema.parse(args))),
          image: null,
          mediaId: null,
        };
      case "get_raw":
        return {
          text: JSON.stringify(await tools.getRaw(GetRawArgsSchema.parse(args))),
          image: null,
          mediaId: null,
        };
      case "search_uncertain":
        return {
          text: JSON.stringify(
            await tools.searchUncertain(SearchUncertainArgsSchema.parse(args), ctx),
          ),
          image: null,
          mediaId: null,
        };
      case "fetch_image": {
        const result = await tools.fetchImage(FetchImageArgsSchema.parse(args));
        if (result.ok) {
          // 回喂给模型的是「已附上图」的提示（base64 不进 tool 文本，避免重复占上下文——图在 user 消息里）
          return {
            text: JSON.stringify({ ok: true, note: "图片已附在接下来的一条消息里" }),
            image: result.dataUrl,
            mediaId: result.mediaId,
          };
        }
        return { text: JSON.stringify(result), image: null, mediaId: null };
      }
      default:
        return { text: JSON.stringify({ error: `未知工具: ${name}` }), image: null, mediaId: null };
    }
  } catch (err) {
    // 工具报错回给模型让它自己调整，而不是中断整个循环
    return { text: JSON.stringify({ error: errText(err) }), image: null, mediaId: null };
  }
}

/** 本批最多取几次图（尝试即计——失败的取图也耗预算，防对失效 URL 反复打网）。 */
const MAX_IMAGE_FETCHES = 4;

/** 消息里是否含图片内容块（决定是否需要走「剥图重试」这条路）。 */
function hasImage(messages: ChatMsg[]): boolean {
  return messages.some(
    (m) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === "image_url"),
  );
}

/** 剥掉所有图片内容块——带图调用失败时的降级重试：不丢任何文本工具结果，
 *  只把 user 消息的图片块换成占位文本（否则空内容块会被网关拒）。 */
function stripImages(messages: ChatMsg[]): ChatMsg[] {
  return messages.map((m) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    const parts = m.content.map((p) =>
      p.type === "image_url"
        ? { type: "text" as const, text: "（图片已省略：带图调用失败，本批按纯文本处理）" }
        : p,
    );
    return { role: "user", content: parts };
  });
}

/** 调模型；带图时若调用抛错**或返回静默空回复**，则**剥图重试一次**——不预判原因
 *  （模型不支持图 / 请求过大 / 网关抖动），只如实留痕原因。
 *
 *  ⚠️ 「空回复」也算带图失败（2026-10-22 实测）：部分网关收到图不报错，只是回一个既无正文、
 *  也无工具调用的空 turn。旧实现只把「抛错」当失败，于是图一直挂在消息里、每轮都空回、
 *  直到轮次预算耗尽报「超过 8 轮仍未产出合法变更清单」——图明明是取到了的，坏在看完图之后。
 *
 *  返回 degraded=true 表示本轮降级过——**剥图落回与置位归调用方**（helper 不改调用方数据；
 *  重试仍失败则抛出，外层标 failed）。 */
async function chatWithImageFallback(
  llm: LlmClient,
  db: Db,
  raw: RawInput,
  modelTag: string,
  messages: ChatMsg[],
): Promise<{ content: string | null; toolCalls: ToolCall[]; degraded: boolean }> {
  const args = {
    system: buildDigestPrompt(repo.readRejectionRules(db), readSourceHints(db)),
    messages,
    tools: TOOL_DEFS,
  };
  /** 一次成功调用的用量落行（010；失败无 usage 可记——asset 分支不进这里）。 */
  const counted = <T extends { usage: LlmUsage | null }>(turn: T): T => {
    recordUsage(db, "agent0", modelTag, turn.usage);
    return turn;
  };
  /** 静默空回复：既没正文也没工具调用——模型这一轮什么都没产出，重试才有意义。 */
  const isEmptyTurn = (t: { content: string | null; toolCalls: ToolCall[] }): boolean =>
    t.toolCalls.length === 0 && (t.content ?? "").trim() === "";
  if (!hasImage(messages)) return { ...counted(await llm.chat(args)), degraded: false };
  /** 剥图重试一次并留痕（抛错与空回复共用同一条降级路径）。 */
  const retryWithoutImages = async (reason: string) => {
    // 先跑剥图重试，**成功后才留痕**——若重试也抛（429/5xx 等），本批整体 failed，
    // 不应留下「已剥图重试、本批不再注入图片」的假痕（审查 2026-10-14）
    const retried = counted(await llm.chat({ ...args, messages: stripImages(messages) }));
    appendPipelineEventBestEffort(
      db,
      raw.id,
      {
        action: "image_degraded",
        detail: `带图调用失败（${reason}），已剥图重试、本批不再注入图片`,
        payload: { error: reason },
      },
      { actor: "agent0", model: modelTag },
    );
    return { ...retried, degraded: true };
  };
  let first: { content: string | null; toolCalls: ToolCall[]; usage: LlmUsage | null };
  try {
    first = await llm.chat(args);
  } catch (err) {
    return retryWithoutImages(errText(err));
  }
  if (isEmptyTurn(first))
    return retryWithoutImages("模型对带图消息返回了空回复（无正文、无工具调用）");
  return { ...counted(first), degraded: false };
}

/** 围栏拒收后给模型一次修正机会（01§4.10④）：只回喂被拒项与原因。 */
async function requestRepair(
  llm: LlmClient,
  db: Db,
  modelTag: string,
  rejected: { item: ChangeList["changes"][number]; reason: string }[],
): Promise<{ ok: true; list: ChangeList } | { ok: false; reason: string }> {
  const res = await llm.chat({
    system: buildDigestPrompt(repo.readRejectionRules(db), readSourceHints(db)),
    tools: [],
    messages: [
      {
        role: "user",
        content: `你提交的变更清单中有 ${rejected.length} 项被围栏拒收：\n${describeRejections(rejected)}\n请只针对被拒收的项修正后重新提交（其余项保持原样），同样只输出 {"changes":[...]}。`,
      },
    ],
  });
  recordUsage(db, "agent0", modelTag, res.usage);
  const parsed = parseChangeListDetailed(res.content ?? "");
  return parsed.ok ? { ok: true, list: parsed.value } : { ok: false, reason: parsed.reason };
}

/** 拼装给模型的原始信息简报——时间事实逐项给全（事件时间/提交时间/消化时间），
 *  相对日期与补年份才有据可锚（见 prompt.ts【ddl 推断】）。
 *  - 对话来源（chat）：前台提交即用户亲口说的时刻，是**有据锚点**；
 *  - 其余来源（粘贴/信源）：接收时间仍禁止当锚（积压粘贴是常态，01§5.3）。 */
/** 读在岗信源声明的「来源说明」（L27：装配期由 registerSources **整体重写**，这里原样拼给提示词）。
 *
 *  为什么是「一份清单」而不是「按源逐个存」：逐源存的话，注销一个源就得靠清扫补救——
 *  而清扫只在恰好跑到时生效，残留会让提示词一直说一个收不到的信源。
 *  清单整体重写，注销的源自然消失。
 *
 *  `chat` 不是适配器（它在 `application/chat.ts` 里直接 ingest），所以它的说明**内置在这里**——
 *  这是唯一一处不走适配器声明的来源。
 *
 *  @param db 账户库
 */
function readSourceHints(db: Db): repo.SourceDigestHint[] {
  // chat 的内置说明排最前（它是最常用的入口）
  return [
    {
      name: "chat",
      hint: "**用户本人在对话里说的话**。说给他自己听的，第一人称、省略多——缺的字段不要猜，缺日期就进「日期未知」。",
    },
    ...repo.readSourceDigestHints(db),
  ];
}

/** 拼「这条信息」的用户消息（D-118 的三个时刻：事件时间 / 提交时间 / 消化时间）。
 *
 *  @param raw 待消化的批次
 *  @param now 消化时刻（整轮不变——模型判「今年/是否已过期」的「现在」）
 */
function buildUserBrief(raw: RawInput, now: string): string {
  const isChat = raw.source === "chat";
  return [
    "[原始信息]",
    `批次 id：${raw.id}`,
    `内容（逐字）：${raw.content}`,
    `来源类型：${raw.source}`,
    `来源身份：${JSON.stringify(raw.identity)}`,
    `事件时间：${
      raw.eventTime ??
      (isChat
        ? "未知（对话即时输入；相对日期以「提交时间」为锚）"
        : "未知（相对日期无锚，禁止按接收时间兜底）")
    }`,
    isChat
      ? `提交时间：${raw.receivedAt}（前台提交这条的原话，即用户说完的时刻——「明天/下周」以此为锚）`
      : `接收时间：${raw.receivedAt}`,
    `消化时间：${now}（现在是这个时刻——判「今年」与是否已过期用它）`,
    "",
    "请处理这条信息（按系统规则产出变更清单）。",
  ].join("\n");
}
