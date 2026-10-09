# Feature Specification: 流水数据层（pipeline_events 改名 + digesting 态 + digest_trace）

**Feature Branch**: `004-pipeline-events-data`

**Created**: 2026-10-09

**Status**: Draft

**Input**: User description: "批次审计正名为流水（replay_nodes→pipeline_events）、消化加「处理中」中间态、agent0 每轮思维落一条流水事件——六轮评审已定稿的全部数据层收口，不含读口 API 与前端视图（C2）"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 流水正名与死列清理 (Priority: P1)

维护者查库/读代码，看到的是 `pipeline_events` 表（无 `entity_type` 死列）、`appendPipelineEvent`/`listPipelineEvents` 函数——名字与语义一致（六轮评审定稿）。行为零变化：既有审计记录的写入点与内容不变（`chitchat_discard` 收敛为 `digest_done` 除外）。

**Why this priority**: 名实相一是本轮的立轮之本；C2 读口直接建在其上。

**Independent Test**: `grep -rn "replay\|entity_type\|chitchat_discard" apps/server/src` 零命中（docs/02 历史记载除外）；全量测试绿。

**Acceptance Scenarios**:

1. **Given** 重组完成，**When** 列 `apps/server/src/storage` schema，**Then** 表 `pipeline_events(id, action, detail, payload, at, by)`，索引仅 `(entity_id)` 方向。
2. **Given** 纯寒暄走前台，**When** 落流水，**Then** action=`digest_done`、detail 含「寒暄」。

---

### User Story 2 - 消化「处理中」可见 (Priority: P1)

批次进站被发射消化后，`digest_state` 立即变为 `digesting`（区别于排队中的 `pending`）；进程中断留下的 `digesting` 孤儿在下次启动时与 `pending` 一样被清扫为 `failed`（横幅可见、可重试）。

**Why this priority**: 「正在处理 vs 还没轮到」不可见是用户走查痛点②的一半。

**Independent Test**: kickDigest 发射后立刻查状态 = `digesting`；构造 `digesting` 孤儿跑 sweepOrphanPending → 变 `failed` 且留痕。

**Acceptance Scenarios**:

1. **Given** 一条 pending 批次，**When** kickDigest 发射，**Then** 状态立即为 `digesting`（同步、确定性）。
2. **Given** 库中有一条 `digesting` 孤儿，**When** 启动清扫，**Then** 置 `failed` 并写 `startup_sweep` 流水。

---

### User Story 3 - agent0 思维轨迹落库 (Priority: P2)

agent0 消化的工具循环每轮落一条 `digest_trace` 流水：`payload = { round, thought(≤500字), tools: [工具名] }`——用户将来在流水视图能看到「它先查了什么、后查了什么」。轨迹写入失败 MUST NOT 拖垮消化（只记 stderr）。

**Why this priority**: 可观测性的核心增量；数据先行的前提下 C2 才有东西可展示。

**Independent Test**: FakeLlm 带 toolCalls 跑一次消化，断言每轮一条 `digest_trace`、payload 含 round 与工具名。

**Acceptance Scenarios**:

1. **Given** 两轮工具循环后产出变更清单，**When** 消化完成，**Then** `pipeline_events` 恰有两条 `digest_trace`（round 0/1）。
2. **Given** 轨迹写入抛错（人为破坏），**When** 消化继续，**Then** 消化正常完成、stderr 有痕。

### Edge Cases

- 重试批次（failed→pending→发射）：`digesting` 照常置上，不再有双跑窗口（`setDigestStateIf` 原子前置已保证）。
- 既有库（含 `replay_nodes` 旧表）：开发版无存量用户——`npm run db:reset` 重建，不做迁移。
- `listPipelineEvents` 读取时 `by` 列按 D-88 迁移后的结构化 JSON 解析为 Provenance。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 表 `replay_nodes` MUST 更名 `pipeline_events`（Drizzle 常量、`REPLAY_ORDER→PIPELINE_ORDER`、索引 `replay_entity_idx→pipeline_entity_idx` 同步），**删除 `entity_type` 列**（Q20 改「需要时再加列」），索引改为仅 `(entity_id)`。
- **FR-002**: repo 函数 `appendRawAudit→appendPipelineEvent`、`listRawAudit→listPipelineEvents`；后者升级为返回完整 `PipelineEvent[]`（zod 解析，含 by/payload）。
- **FR-003**: shared 增 `PipelineEventSchema`（id/action/detail/payload/at/by:Provenance；payload 用 `z.unknown()`——自由形状原则 3）。
- **FR-004**: `chitchat_discard` action MUST 收敛为 `digest_done`（detail 含「寒暄」字样），`chitchatAudit` 函数与断言同步。
- **FR-005**: `DigestState` 增 `"digesting"`；`kickDigest` 发射时同步置 `digesting`；`sweepOrphanPending` MUST 同时清扫 `pending` 与 `digesting` 孤儿。
- **FR-006**: 工具循环每轮 MUST 落一条 `digest_trace`（payload `{round, thought≤500字, tools}`）；`elicitChangeList` 以参数接 db（**禁入 ToolContext**）；轨迹写入失败 MUST 只记 stderr 不影响消化。

### Key Entities

- **PipelineEvent**（shared）: `{id, action, detail, payload: unknown|null, at, by: Provenance}`——C2 读口的响应契约。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `grep -rn "replay\|chitchat_discard\|entity_type" apps/server/src packages` 零命中（docs/02 历史记载除外）。
- **SC-002**: `npm run check` 全绿（含新增：digesting 置位/孤儿清扫/digest_trace/混批—已有/寒暄收敛断言）。
- **SC-003**: `npm run db:reset` 后 dev 栈可正常起（新表结构自洽）。
- **SC-004**: knip 干净（`PipelineEventSchema` 由 `listPipelineEvents` 真实消费）。

## Assumptions

- 开发版无存量用户：表结构变更走 `db:reset`，不写迁移（迁移基建仅存 D-88 既有项）。
- C2（读口 API + 流水视图）另立 feature；本轮交付数据层与其单测。
- `digest_trace` 只记轮次/思考摘要/工具名，不记工具参数与结果（体积与隐私边界，五轮原则「payload 扁平」）。
