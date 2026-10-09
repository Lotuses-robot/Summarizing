# Tasks: 流水数据层

**Input**: Design documents from `/specs/004-pipeline-events-data/`

**Prerequisites**: plan.md ✅ spec.md ✅

## Format: `[ID] [P?] [Story] Description`

## Phase 1: shared 契约

- [x] T001 [P] `packages/shared`：`DigestState` 增 `"digesting"`；新增 `PipelineEventSchema`/`PipelineEvent`（id/action/detail/payload(z.unknown)/at/by:Provenance）

## Phase 2: 存储层改名

- [x] T002 `storage/schema.ts`：常量 `replayNodes→pipelineEvents`、表名、删 `entity_type` 列
- [x] T003 [P] `storage/db.ts`：DDL 表/索引改名（`pipeline_entity_idx(entity_id)`）、`migrateByToProvenance` 目标表名
- [x] T004 `storage/repo.ts`：`appendPipelineEvent`（删 entityType 赋值）/`listPipelineEvents`（PipelineEventSchema 全字段解析）/`PIPELINE_ORDER`

## Phase 3: 消化侧

- [x] T005 `agent0/digest.ts`：kickDigest 同步置 `digesting`；`elicitChangeList(+db)` 每轮 `digest_trace`（try/catch→stderr）；sweepOrphanPending 扫 `pending+digesting`
- [x] T006 [P] `agent0/sweep.ts`、`executor/executor.ts`、`application/chat.ts`：改名跟随；chitchatAudit → `digest_done`（detail 含「寒暄」）

## Phase 4: 测试

- [x] T007 [P] 既有断言改名跟随（listRawAudit→listPipelineEvents 等；grep 清单）
- [x] T008 kickDigest 发射后状态=`digesting`（同步确定性断言）
- [x] T009 [P] sweepOrphanPending：`digesting` 孤儿 → failed + startup_sweep 流水
- [x] T010 [P] digest_trace：两轮工具循环 → 恰两条 trace（round/payload.tools）；写入失败不影响消化
- [x] T011 [P] chat 寒暄：action=`digest_done` 且 detail 含「寒暄」

## Phase 5: 质量门

- [x] T012 `npm run db:reset` 后全量 `npm run check` + knip + web 构建全绿
- [x] T013 `grep -rn "replay\|chitchat_discard\|entity_type" apps packages`（docs/02 历史除外）零命中
- [x] T014 台账 D-92 + specs/004 勾选

## Notes

- 改完 schema 先 `npm run db:reset` 再跑测试（worktree 的 data/summarizing.db 有旧表）
- grep 自审红线：`replayNodes/replay_nodes/appendRawAudit/listRawAudit/REPLAY_ORDER/chitchat_discard/entity_type` 全清单
