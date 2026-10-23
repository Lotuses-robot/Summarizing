import { afterEach, describe, expect, it } from "vitest";
import { cleanupAllTestAccounts, makeTestAccount } from "./helpers/app";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";

// 流水读口（specs/005）：台账 + 详情——纯只读；数据由真实 insertRawInput/appendPipelineEvent 造出。
// 006 起经 makeTestAccount 打真实入口（真账户 + 真会话 cookie）。

afterEach(cleanupAllTestAccounts);

/** 造一条已含两条流水的批次（真实写入路径：insertRawInput + appendPipelineEvent）。 */
function seedBatch(db: Db): string {
  const raw = repo.insertRawInput(db, {
    content: "群里说的作业通知",
    source: "nc",
    identity: { displayName: "英语课官方群", groupId: "g1" },
    receivedAt: "2026-09-28T10:00:00",
    eventTime: "2026-09-28T10:00:00",
  });
  repo.setDigestState(db, raw.id, "digested");
  repo.appendPipelineEvent(db, {
    rawInputId: raw.id,
    action: "digest_done",
    detail: "应用 1 项变更：新建事项「作业」",
    payload: { applied: ["新建事项「作业」"] },
    by: { actor: "agent0", model: "test" },
  });
  repo.appendPipelineEvent(db, {
    rawInputId: raw.id,
    action: "digest_trace",
    detail: "第 1 轮：search_items",
    payload: { round: 1, thought: "", tools: ["search_items"] },
    by: { actor: "agent0", model: "test" },
  });
  return raw.id;
}

describe("流水读口（specs/005）", () => {
  it("台账：批次概要含来源显示名/状态/消化结果一句话/流水计数", async () => {
    const t = await makeTestAccount();
    const rawId = seedBatch(t.db);
    const res = await t.inject({ method: "GET", url: "/api/pipeline/runs" });
    expect(res.statusCode).toBe(200);
    const runs = res.json<{ runs: Record<string, unknown>[] }>().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: rawId,
      source: "nc",
      displayName: "英语课官方群",
      digestState: "digested",
      summary: "应用 1 项变更：新建事项「作业」",
      eventCount: 2,
    });
  });

  it("详情：原文 + 全部流水（时间升序）；404 = 批次不存在", async () => {
    const t = await makeTestAccount();
    const rawId = seedBatch(t.db);
    const res = await t.inject({ method: "GET", url: `/api/pipeline/runs/${rawId}` });
    expect(res.statusCode).toBe(200);
    const detail = res.json<{ raw: { content: string }; events: { action: string }[] }>();
    expect(detail.raw.content).toBe("群里说的作业通知");
    expect(detail.events.map((e) => e.action)).toEqual(["digest_done", "digest_trace"]);

    const missing = await t.inject({ method: "GET", url: "/api/pipeline/runs/nope" });
    expect(missing.statusCode).toBe(404);
  });

  it("台账：空库 → 空数组（不是 null/报错）", async () => {
    const t = await makeTestAccount();
    const res = await t.inject({ method: "GET", url: "/api/pipeline/runs" });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ runs: unknown[] }>().runs).toEqual([]);
  });
});
