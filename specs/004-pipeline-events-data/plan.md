# Implementation Plan: 流水数据层

**Branch**: `004-pipeline-events-data` | **Date**: 2026-10-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-pipeline-events-data/spec.md`

**Note**: 六轮评审已定稿的全部数据层决策，本计划只做落地编排。无未知项——不生成 research/data-model/contracts。

## Summary

三线合一：①`replay_nodes` 正名 `pipeline_events`（删 entityType 死列）；②`DigestState` 增 `digesting`（发射置位 + 孤儿清扫扩展）；③工具循环每轮落 `digest_trace`（db 显式传参进 elicitChangeList，不入 ToolContext；写入失败只记 stderr）。

## Technical Context

**Language/Version**: TypeScript 5.x strict / Node ≥22

**Primary Dependencies**: 无新增（drizzle/zod 既有）

**Storage**: `raw_inputs.digest_state` 值域 +1；`replay_nodes`→`pipeline_events` 表改名+删列（开发版 `db:reset`，不写迁移）

**Testing**: Vitest（nc/digest/repo/chat/uncertain 既有断言改造 + 新增 digesting/trace/孤儿用例）

**Target Platform**: server

**Project Type**: monorepo `apps/server` + `packages/shared`

**Performance Goals**: N/A（每批 +轮数次 SQLite 追加，量级同既有审计写入）

**Constraints**: 轨迹写入失败不影响消化；`digest_trace` 不记工具参数与结果

**Scale/Scope**: shared 1 处、schema/db/repo 3 文件、agent0/application 4 文件、测试 5 文件

## Constitution Check

| 宪法条款 | 合规 | 说明 |
|----------|:---:|------|
| IV 不写没有调用者的东西 | ✅ | `PipelineEventSchema` 由 `listPipelineEvents` 真实消费（读侧解析）；`digesting` 由 kickDigest/orphan 双方使用 |
| 边界加固三规矩（脏形态枚举） | ✅ | DigestState 值域 +1 → grep 全部 switch/比较消费者一次改全（本轮 grep 清单含 web 侧） |
| 结构容错 ≠ 语义兜底 | ✅ | time null → eventTime null（上一轮已定），不新增兜底 |
| V 真实入口验证 | ✅ | kickDigest/孤儿清扫走 repo 真库断言 |
| 自审三问 | ✅ | SC-001 grep 清单；台账 D-92 |

**结论**：通过。

## Project Structure

### Source Code

```text
packages/shared/src/index.ts        # DigestState + "digesting"；PipelineEventSchema/Type（新增）
apps/server/src/storage/schema.ts   # replayNodes→pipelineEvents 常量/表名/列（删 entity_type）
apps/server/src/storage/db.ts       # DDL 同步（表/索引改名+删列；migrateByToProvenance 目标表名）
apps/server/src/storage/repo.ts     # appendPipelineEvent/listPipelineEvents/PIPELINE_ORDER（list 升级全字段解析）
apps/server/src/agent0/digest.ts    # kickDigest 置 digesting；elicitChangeList(+db)每轮 digest_trace；sweepOrphanPending 扫双态
apps/server/src/agent0/sweep.ts     # appendPipelineEvent 改名
apps/server/src/executor/executor.ts# 同上（3 处）
apps/server/src/application/chat.ts # chitchatAudit → digest_done 收敛；appendPipelineEvent 改名
apps/server/src/test/*.ts           # 改名跟随 + 新增 digesting/trace/孤儿用例
```

**Structure Decision**: 全在既有文件内，无新目录新依赖。

## Complexity Tracking

无违反项。
