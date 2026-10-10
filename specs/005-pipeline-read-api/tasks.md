# Tasks: 流水读口 + 流水视图（C2）

> **注（2026-10-10 走查，D-95）**：视图形态已被推翻重定（单一时间线 + 常驻大状态卡 + 轮询自适应 3s/10s）——本档任务勾选为实施补记，视图行为以 02 台账 D-95 为准；读口/数据层结构仍为准。

**Input**: Design documents from `/specs/005-pipeline-read-api/`

**Status**: 全部完成（本档为实施后补记——任务勾选反映已落地事实）。

## Phase 0: 影响面与脏形态

- [x] T000 [P] 影响面清单：`PipelineRun` 6 消费点 / `PipelineEventSchema` 全链 / codegraph 索引重建验证
- [x] T001 [P] 脏形态枚举：空库 / 未知 action / 全 null 字段 / 404 id

## Phase 1: 后端

- [x] T002 shared：`PipelineRunSchema` / `PipelineRunDetailSchema`
- [x] T003 repo：`listPipelineRuns`（两查询 + JS 分组 + 末条 digest_done·failed 作 summary）
- [x] T004 routes/pipeline.ts：GET /runs + GET /runs/:id（404；边界 zod）

## Phase 2: 前端

- [x] T005 api.ts：pipelineRuns / pipelineRun
- [x] T006 PipelineView.tsx：台账（状态徽章四态/来源/时间/摘要/计数）+ 展开行懒取 RunDetail（四频道分组）
- [x] T007 ActivityBar + App.tsx 接线（view 联合 + ScrollText 入口）

## Phase 3: 测试与质量门

- [x] T008 路由注入 3 用例（台账字段/详情+404/空库）
- [x] T009 视图 3 用例（台账渲染含消化中/展开分频道/空态文案）
- [x] T010 `npm run check` + knip + web 构建全绿（250 测试）

## Notes

- 本档为**实施后补记**：C2 与轮 C1 同批实施时未先落 tasks（流程欠账，用户指出）——后续特性回到「先三件套后实现」的正轨
- 剩余观察项：trace payload.round 跨次重试从 1 重计（D-93 已记录，视图按 at 排序可读）
