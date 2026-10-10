# Implementation Plan: 流水读口 + 流水视图（C2）

**Branch**: `worktree-speckit-trial` | **Date**: 2026-10-09

**Status**: 补记（implemented 先于本档——C2 与轮 C1 同批实施；本档如实记录已落地结构，后续迭代以它为基线）

> **注（2026-10-10 走查，D-95）**：视图形态已被推翻重定（单一时间线 + 常驻大状态卡 + 轮询自适应 3s/10s）——本档的**读口/数据层结构仍为准**；视图行为以 02 台账 D-95 为准。

**Input**: Feature specification from `/specs/005-pipeline-read-api/spec.md`

## Summary

两个只读端点（台账 + 详情）+ 活动栏「流水」视图（台账行 10s 轮询、展开行懒取详情、按 action 四频道分组）。

## Technical Context

**Language/Version**: TypeScript 5.x strict / React 19 / Fastify 5

**Primary Dependencies**: 无新增

**Storage**: 只读（raw_inputs + pipeline_events）

**Testing**: Vitest（路由注入 3 用例 + 视图 3 用例）

**Target Platform**: server + web

**Project Type**: monorepo 既有结构内增量

## Constitution Check

| 宪法条款 | 合规 | 说明 |
|----------|:---:|------|
| IV 不写没有调用者的东西 | ✅ | `PipelineRunSchema` 被 repo/前端双侧消费；`PipelineRunDetailSchema` 被路由边界消费 |
| 边界加固三规矩 | ✅ | 影响面清单先于实现（PipelineRun 6 消费点已核）；无新增边界字段 |
| V 真实入口验证 | ✅ | 路由 inject 测试 + 视图 testing-library 测试 |
| 注释可溯源 | ✅ | 全部标注 specs/005 与评审轮次 |

**结论**：通过。

## Project Structure

```text
packages/shared/src/index.ts        # PipelineRun/PipelineRunDetail schema
apps/server/src/storage/repo.ts     # listPipelineRuns（两查询+JS 分组）
apps/server/src/routes/pipeline.ts  # GET /runs、GET /runs/:id（边界 zod）
apps/web/src/api.ts                 # pipelineRuns/pipelineRun
apps/web/src/components/pipeline/PipelineView.tsx  # 台账 + 展开详情（四频道分组）
apps/web/src/components/ActivityBar.tsx            # ScrollText 流水入口
apps/web/src/App.tsx                               # view 联合 + 渲染分支
tests: pipeline.test.ts / pipelineView.test.tsx
```

**Structure Decision**: 全在既有结构内；无新目录（pipeline/ 组件目录为首件）。

## Complexity Tracking

无违反项。
