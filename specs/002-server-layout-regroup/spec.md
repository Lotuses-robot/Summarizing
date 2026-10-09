# Feature Specification: 服务端目录重组（模块边界归位）

**Feature Branch**: `002-server-layout-regroup`

**Created**: 2026-10-09

**Status**: Draft

**Input**: User description: "按布局定稿重组服务端目录：agent0 归位执行者、fence+executor 独立成变更写通道、features/ 改名 application/；行为零变化"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 打开 src 一眼看出模块职责 (Priority: P1)

维护者打开 `apps/server/src/`，目录名各自说明职责：`agent0/`（消化执行者）、`executor/`（变更写通道：围栏+落笔）、`application/`（对外能力的编排层）。不再有「features」这类无判据的兜底目录。

**Why this priority**: 这是本轮的唯一目的——认知落地；后续所有批次都在这个骨架上施工。

**Independent Test**: 列目录 + 看各文件首行注释，能说出每个目录「是什么」；全量测试绿（行为零变化）。

**Acceptance Scenarios**:

1. **Given** 重组完成，**When** 列出 `apps/server/src/`，**Then** 顶层为 `agent0/ executor/ application/ sources/ storage/ routes/ shared/`，无 `features/`。
2. **Given** 重组完成，**When** 全量 `npm run check` + web 构建 + knip，**Then** 全绿（行为零变化）。

---

### User Story 2 - 写权边界结构可见 (Priority: P1)

维护者看目录即知「变更清单的守门（fence）与落笔（executor）不属于任何单个 agent」——agent0 产变更，但必须经 `executor/` 通道。

**Why this priority**: 「门在门外」是布局定稿的核心认知，结构要表达它。

**Independent Test**: `fence.ts`/`executor.ts` 位于 `executor/`，被 `agent0/digest` 与 `agent0/sweep` 双方引用。

**Acceptance Scenarios**:

1. **Given** 重组完成，**When** grep `executor/fence` 的引用方，**Then** digest 与 sweep 都在（≥2 消费者）。

### Edge Cases

- `application/` 与根 `src/app.ts`（Fastify 装配）并存：import 均带子路径（`./application/...`），无解析歧义。
- `docs/02-决策台账` 的历史路径记载不改（历史记录如实）。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `src/features/agent0` MUST 迁为 `src/agent0`（digest/prompt/tools/sweep）。
- **FR-002**: `fence.ts` 与 `executor.ts` MUST 迁为 `src/executor/`，双方引用方 import 同步。
- **FR-003**: 其余 `features/` 文件（ingest/board/chat）MUST 迁为 `src/application/`。
- **FR-004**: `errText` MUST 迁出 digest.ts（app/chat/settings 多处使用，与消化无关），原导出删除。~~迁至 `src/shared/err.ts`~~ **/simplify 轮最终上移 `packages/shared/src/index.ts` 通用工具区**（web/server 双侧消费，relativeDueText 先例）。
- **FR-005**: `chat.ts`（内含未拆前台 agent）与 `sweep.ts`（第二执行者任务）MUST 注释标记观察项。
- **FR-006**: `docs/07` 中指向 `features/chat.ts` 的现行引用 MUST 更新；`docs/02` 历史记载不动。
- **FR-007**: 全部相对 import MUST 同步更新，无 `features/` 残留（src 与 scripts 内）。

### Key Entities

无数据实体变化——纯结构重组，零行为变化。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `grep -r "features/" apps/server/src scripts` 零命中（docs/02 历史记载除外）。
- **SC-002**: `npm run check`（tsc+eslint+229 测试）全绿。
- **SC-003**: `npm run build -w @summarizing/web` 与 `npm run check:dead` 通过。

## Assumptions

- 目录名 `application/` 为用户暂定拍板（2026-10-09）；`app/` 因与 `app.ts` 撞名弃用。
- 本轮不改任何运行时行为、不改公共 API、不改数据库。
