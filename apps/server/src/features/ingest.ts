import type { IngestRequest, RawInput } from "@summarizing/shared";
import type { TaggedLlm } from "../shared/llm";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import { nowLocalWallClock } from "../shared/time";
import { kickDigest } from "./agent0/digest";
import type { AgentTools } from "./agent0/tools";

// 进站装配（D-84 唯一出处）：HTTP 路由与 SourceContext.ingest 共用同一段
// 「落档 → fire-and-forget 消化」——信源源与手动源同一条管线，from 标记区分来源。

/** 进站载荷：标准批次字段 + 可选 raw 归档（信源原始载荷留底，D-84）。 */
export type IngestBatch = IngestRequest & { raw?: unknown };

/** 执行一次进站：先落盘（含接收时刻），后异步交给 agent0（失败标「未处理」，01§5.3）。
 *  llm 逐请求取当前客户端——热切换后 modelTag 依旧值进署名的旧坑在这里堵住。返回落档批次。 */
export function ingestBatch(
  db: Db,
  llmRef: { current: TaggedLlm },
  tools: AgentTools,
  payload: IngestBatch,
  from: string,
  log?: (msg: string) => void,
): RawInput {
  const raw = repo.insertRawInput(db, { ...payload, receivedAt: nowLocalWallClock() });
  const client = llmRef.current;
  kickDigest(db, client, tools, client.modelTag, raw, from, log);
  return raw;
}
