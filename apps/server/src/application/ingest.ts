import type { DigestState, IngestRequest, RawInput } from "@summarizing/shared";
import type { TaggedLlm } from "../shared/llm";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import { nowWallClock } from "../shared/time";
import { kickDigest } from "../agent0/digest";
import { cacheIngestImages } from "./mediaIngest";
import type { AgentTools } from "../agent0/tools";

// 进站装配（D-84 唯一出处）：HTTP 路由与 SourceContext.ingest 共用同一段
// 「落档 → fire-and-forget 消化」——信源源与手动源同一条管线，from 标记区分来源。

/** 进站载荷：标准批次字段 + 可选 raw 归档（信源原始载荷留底，D-84）。 */
export type IngestBatch = IngestRequest & { raw?: unknown };

/** 执行一次进站：先落盘（含接收时刻），后异步交给 agent0（失败标「未处理」，01§5.3）。
 *  llm 逐请求取当前客户端——热切换后 modelTag 依旧值进署名的旧坑在这里堵住。
 *  `mediaDir` = 本账户媒体目录，**必填**：图片进站缓存（009）走它。做成可选参数的版本
 *  被真实咬过一次——`/api/ingest` 悄悄不传，缓存静默不跑且无任何痕迹。必填让编译器逼每个
 *  调用方表态（没有媒体目录的场景显式传空串，缓存自然跳过）。
 *  返回落档批次与消化置位结果（specs/004 八轮评审：回执用置位结果而非发射前快照）。 */
export function ingestBatch(
  db: Db,
  llmRef: { current: TaggedLlm },
  tools: AgentTools,
  payload: IngestBatch,
  from: string,
  mediaDir: string,
  log?: (msg: string) => void,
): { raw: RawInput; digestState: DigestState } {
  const raw = repo.insertRawInput(db, { ...payload, receivedAt: nowWallClock() });
  // 图片缓存与消化并行、互不阻塞（009）：抓图失败绝不影响进站回执与消化
  if (mediaDir !== "") cacheIngestImages(db, mediaDir, raw.id);
  const client = llmRef.current;
  const digestState = kickDigest(db, client, tools, client.modelTag, raw, from, log);
  return { raw, digestState };
}
