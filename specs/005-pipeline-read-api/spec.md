# Feature Specification: 流水读口 + 流水视图（C2）

**Feature Branch**: `worktree-speckit-trial`（C1 数据层之上的读口与视图）

**Created**: 2026-10-09

**Status**: Implemented（本档补记实现定稿——行为以下述 FR 为准）

**Input**: User description: "右侧前台能力的升级——追踪一件事情收录到哪里了；进站台账 + 单批详情 + 流水视图（按 action 分频道）"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 进站台账一览 (Priority: P1)

用户打开流水视图，最近 50 个批次按时间倒序排列：状态徽章（排队中/消化中/已消化/未处理）、来源显示名、接收时间、消化结果一句话、流水条数——「一条信息从进站到成事项」全程可查，消化中自动浮出进度（10s 轮询）。

**Why this priority**: 用户走查痛点②「找不到反馈」的本体。

**Independent Test**: 种一条批次 + 两条流水 → GET 台账断言概要字段；空库断言空数组。

**Acceptance Scenarios**:

1. **Given** 一条已消化批次（含 2 条流水），**When** GET /api/pipeline/runs，**Then** 返回概要（sourceLabel=「英语课官方群」/digestState=digested/summary=digest_done detail/eventCount=2）。
2. **Given** 空库，**When** GET 台账，**Then** runs=[]（不是 null/报错）。

---

### User Story 2 - 单批详情与分频道流水 (Priority: P1)

用户展开一条批次：原文 + 全部流水按四频道分组展示（处理结果/落笔动作/agent0 轨迹/拒收与存疑；未知 action 归「其他」不丢内容）。批次不存在 → 404。

**Why this priority**: 透明度的本体——detail 是给人看的一句话，按频道分组让「它查了什么、改了什么、拒了什么」一眼分清。

**Independent Test**: GET /api/pipeline/runs/:id 断言原文与流水 action 序列；不存在 id → 404。

**Acceptance Scenarios**:

1. **Given** 含 digest_done + digest_trace 的批次，**When** GET 详情，**Then** 原文与两条流水按时间升序返回。
2. **Given** 不存在的批次 id，**When** GET 详情，**Then** 404。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: GET /api/pipeline/runs?limit=1..200（默认 50）MUST 返回 `{ runs: PipelineRun[] }`——概要含 sourceLabel（sourceIdentity.sourceLabel）/digestState/summary（末条 digest_done|digest_failed 的 detail）/eventCount。
- **FR-002**: GET /api/pipeline/runs/:id MUST 返回 `{ raw: RawInput, events: PipelineEvent[] }`（时间升序）；不存在 → 404。
- **FR-003**: 两个端点 MUST 为纯只读（无写路径）；契约在边界过 zod（PipelineRunDetailSchema）。

### Key Entities

- `PipelineRun`（shared）：台账概要行（不含正文）。
- `PipelineRunDetail`（shared）：`{ raw: RawInput, events: PipelineEvent[] }`。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 路由注入测试 3 用例（台账字段/详情+404/空库）全绿。
- **SC-002**: 视图测试 3 用例（台账渲染/展开分频道/空态）全绿。
- **SC-003**: `npm run check` + knip + web 构建全绿。

## Assumptions

- 读口不鉴别权限——单机自用定位（与全仓一致）。
- limit 上限 200 与 chat history 同源。
- 流水视图轮询 10s 仅在视图打开期间运行。
