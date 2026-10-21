# Tasks: 信息分流（通知类别）+ 回收站 + 取消归档

**Input**: Design documents from `/specs/007-information-notice-trash/`

**Prerequisites**: plan.md (required), spec.md (required)

**Tests**: 本特性**要求测试**（spec SC-005：`npm run check` 全绿、真实入口断言用户所见）。每个 story 的关键行为都配真实入口测试（HTTP 端点 / 真实组件渲染）。

> **状态（2026-10-18 对账）**：T001–T041 已全部落地（代码/测试/CHANGELOG/seed；两轮 /code-review 的修复也含在内），
> 逐条勾选以实际交付为准。**T042（真实入口走查）仍待用户真机执行**——见 docs/04 §七 N1–N9。
> T002 的「脏形态基线」以落地测试为准：kind 缺席/脏值与 archived 迁移形态覆盖在
> `apps/server/src/test/schema-migrate.test.ts` 与 `fence.test.ts`（基线式 TDD 未单独留存，说明在此）。

**Organization**: 任务按用户故事分组，每个故事可独立实现与验收。交付按 plan「交付拆分」切两个 commit 回滚点：**第一刀 = 通知 + 取消归档（FR-018）**，**第二刀 = 回收站**。US4（图标）并入第一刀（无入口则无门牌）。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- All paths shown relative to repository root

## Path Conventions

- 共享契约: `packages/shared/src/index.ts`
- 后端: `apps/server/src/`
- 前端: `apps/web/src/`

---

## Phase 0: 影响面与脏形态（必填——宪法「边界加固三规矩」）

> 已由 plan.md 的「影响面清单」+「Phase 0 脏形态枚举」承载（A/B/C/D 四组消费点已列到 file:line）。本阶段把其中最易漏的两类固化成显式检查任务，实现前必须完成。

- [x] T001 [P] 复跑 `codegraph explore "ItemSchema ItemVersionSchema appendItemVersion buildBoard completedAtOf preArchivedStatus"`，核对 plan 影响面清单 A/B 两组消费点在当前 HEAD 上无漂移（spec/plan 写于 HEAD，若期间有人改过这些符号先停下同步）
- [x] T002 [P] 写「脏形态测试（预期 FAIL）」：kind 缺席存量快照、kind 脏值（"Task"/""/null）、存量 status=archived 未迁移、迁移后多版本链 archived/done 混排——先确认这些输入在当前代码下的真实行为，作为实现前的基线

---

## Phase 1: Foundational（阻塞所有故事的地基）

**Purpose**: 共享契约 + 数据迁移基建——`kind`/`status` 枚举形状与存量迁移。**两个故事（通知、回收站）都依赖这层的枚举终态**，必须先完成。

**⚠️ CRITICAL**: 本Phase未完成，US1（通知）与 US3（回收站）都不许开工——二者都读写 `kind`/`status`。

- [x] T003 在 `packages/shared/src/index.ts` 的 `ItemSchema` 加 `kind: z.enum(["task", "notice"]).default("task")`（分类轴；存量快照无该字段→task，spec Edge Cases），`status` 枚举由 `["todo","done","archived"]` 改为 `["todo","done"]`（FR-018，第一刀先不加 trashed）
- [x] T004 同步 `packages/shared/src/index.ts` 的 `ItemSnapshotSchema`（加 kind）与 `ItemVersionSchema.snapshot`（status 收窄注释去 archived + 加 kind）——契约单一来源，改字段名前后端必须同时编译失败
- [x] T005 `apps/server/src/storage/migrate.ts`：`SCHEMA_VERSION` 1 → 2；`apps/server/src/storage/db.ts` 的 `ensureSchema` 末尾追加迁移 `UPDATE item_versions SET snapshot = json_set(snapshot,'$.status','done') WHERE json_valid(snapshot) AND json_extract(snapshot,'$.status')='archived'`（先例 `migrateByToProvenance`；幂等，随 v1→v2 走迁移前自动备份）
- [x] T006 `apps/server/src/storage/repo.ts` 的 `appendItemVersion` snapshot 参数加 `kind: Item["kind"]` 透传；`schema.ts` 的 `snapshot` 列注释补 kind
- [x] T007 `apps/server/src/executor/executor.ts` 的 `create_item` 分支：落笔 `kind`（来自 ChangeItem，缺省 task）；`update_item` 分支：snapshot 透传 kind 并支持切换（ddl 形状校验见 T013，此处先透传）

**Checkpoint**: `kind`/`status` 契约与迁移就绪；`npm run check` 应仍绿（存量测试里的 archived 断言在此步会红——那是 Phase 1 收尾预期的，下一步统一改）。

---

## Phase 2: User Story 1 + 取消归档（第一刀 🎯 MVP）

**Goal**: 群里的非动作类通知（如"课改到明理楼3楼"）进站 → agent0 判为通知 → 「通知」独立入口可见、不进三段看板；同时取消归档、看板四段并回三段、存量归档迁到已完成。

**Independent Test** (spec US1): 一条 nc 白名单群的非动作类消息进站 → agent0 判为通知 → 「通知」页出现（含来源徽标、时间、原文入口）；看板三段均不出现它。另：存量 archived 事项迁移后进「已完成」段。

### Tests（真实入口，先写并确认 FAIL）

- [x] T008 [P] [US1] `apps/server/src/test/board.test.ts`：加「通知不进看板任一段」断言（seed 一条 kind=notice → buildBoard 三段的 undated/scheduled/done 均不含它）
- [x] T009 [P] [US1] `apps/server/src/test/schema-migrate.test.ts`：加 v1→v2「archived→done」迁移用例（造 v1 库：一条末版 archived 事项 + 一条中间 archived/done 混排链 → 迁移后当前均派生为 done）
- [x] T010 [P] [US1] `apps/server/src/test/executor.test.ts`（若无此文件则并入 board.test.ts）：加「create_item(kind=notice) 带 dueDate → 围栏整条拒收」断言
- [x] T011 [P] [US1] `apps/web/src/test/board.test.tsx`：改四段断言为三段；`helpers/board-fixtures.ts` 去掉 archived 夹具、加 notice 夹具

### 后端实现

- [x] T012 [US1] `apps/server/src/application/board.ts`：`buildBoard` 删 archived 段；rows 过滤加 `r.item.kind === "task"`；`BoardViewSchema`（shared）删 `archived` 字段——三段成型
- [x] T013 [US1] `apps/server/src/executor/fence.ts`：加 4 条校验——① `create_item(kind=notice)` 含 dueDate → 整条拒（FR-003/OQ-2）；② `update_item` 改 kind 时按目标 kind 查结果 ddl 形状（task 带值→notice 拒、留空→notice 允许、notice→task 不限，FR-014）；③ `complete_item(kind=notice)` → 拒（US2-2，按 kind 判）；④ 元素只增改不删前提下 task→notice 无删 dueDate 路径
- [x] T014 [US1] `apps/server/src/agent0/prompt.ts`：【准入】段从"只是告知→不建"改为"非事项但有用 → create_item(kind=notice)"，提示词尽量描述"什么值得保留为通知"（U1：判据归 AI，不加机械规则）
- [x] T015 [US1] `apps/server/src/agent0/tools.ts`：`search_items` 结果覆盖 notice、排除 trashed（OQ-9；trashed 第二刀才有，此处先不过滤留待 T026）；@ 提及候选含 notice
- [x] T016 [US1] 新 `apps/server/src/application/notice.ts`（或并入 board.ts，按"文件说得出是什么"定）：`deriveNotices(db)` 取 `kind==="notice"`，按 updatedAt 倒序，每行带 viewed（复用 `repo.listViewedItemIds`）
- [x] T017 [US1] `apps/server/src/routes/items.ts`：删 `archive` 路由 + `manualSetStatus` 的 archive 分支 + reopen 的 archived 语义（`preArchivedStatus` 调用删除；reopen 只"恢复待办"）；`apps/server/src/storage/repo.ts` 删 `preArchivedStatus`

### 前端实现

- [x] T018 [P] [US1] `apps/web/src/api.ts`：删 `archive`；`BoardView` 类型随 shared 去 archived
- [x] T019 [P] [US1] `apps/web/src/components/Board.tsx`：四段元数据删 archived 段（`SECTIONS`）；rows 过滤 kind==="task"；删归档按钮、`RowAction` 去 archive；reopen 文案只"恢复待办"；`lib/appearance.ts` 的 `loadSectionFold` 去 archived
- [x] T020 [P] [US1] `apps/web/src/components/ActivityBar.tsx`：加「通知」一级入口（lucide `Inbox`），view 联合类型加 `"notice"`；未读徽标纯数字（OQ-10，复用轮询 uncertain 同款计数机制）
- [x] T021 [US1] 新 `apps/web/src/components/NoticePanel.tsx`：通知列表（倒序）、复用 `ItemBody` 展开 + `FilterBar`（tag+文本同看板）；行右缘删除占位（回收站未建前先注：T026 接）；点开报 viewed；通知行无 ddl 位
- [x] T022 [US1] `apps/web/src/App.tsx`：view 分支加 notice → NoticePanel

**Checkpoint（第一刀 commit 回滚点）**: `npm run check` + `check:dead` + web build 全绿；通知闭环可独立演示；看板三段；存量归档迁移有真实入口断言。**此处建 rollback commit。**

---

## Phase 3: User Story 4 - 图标与分类表述（P3，随第一刀落）

**Goal**: 活动栏各入口图标语义清晰、不互冒充；文档术语统一、无新旧并存。

**Independent Test** (spec US4): 活动栏 看板/通知/回收站/存疑库/流水 各有独立且语义清晰的图标；涉及"事项/通知/回收站"的文档与界面文案口径统一、无旧术语残留。

- [x] T023 [P] [US4] `apps/web/src/components/ActivityBar.tsx`：确认「通知」=`Inbox`、「回收站」=`Trash2`（OQ-4 已定），排位 `看板 → 通知 → 存疑库 → 流水 → 回收站`；消化"状态"不用事项图标冒充
- [x] T024 [US4] 文档术语统一：`docs/00-数据契约.md`（Item 加 kind/status 现状、去 archived）、`docs/01-规格.md` §4.x、`docs/02-决策台账.md`（D-83 记"归档已取消"+ 新决策编号记通知立项）、`docs/03-开放问题.md`、`docs/04-验收.md`、`CLAUDE.md`——grep `archived`/`归档` 逐条复核是"迁移对照/历史记录"还是真残留

---

## Phase 4: User Story 3 - 回收站（第二刀，P2）

**Goal**: 删除 = 追加 trashed 版本（不进新表）；独立「回收站」入口可复活；唯一批量操作「一键清理 >15d」，物理删但原文档案不动。

**Independent Test** (spec US3): 删一条事项 → 回收站可见、版本链可查删除留痕 → 复活回删前状态；「一键清理」后 >15d 物理删（raw_inputs 仍在、可检索）、≤15d 保留；无"清空全部"/无单条彻底删。

### Tests（真实入口，先写并确认 FAIL）

- [x] T025 [P] [US3] `apps/server/src/test/repo.test.ts`：加「删除追加 trashed 版本、原视图消失、版本链可查删前状态」+「trashedAt 派生（版本链末条 trashed 的 at）」断言
- [x] T026 [P] [US3] `apps/server/src/test/`（purge 端点测试）：加「purge 只物理删 >15d、≤15d 保留、raw_inputs/fragments/uncertain_inputs 不被删、删前 stderr 留痕」断言
- [x] T027 [P] [US3] `apps/server/src/test/digest.test.ts`（或 fence 相关）：加「写 trashed 条目 → 围栏拒收」（OQ-12）

### 后端实现

- [x] T028 [US3] `packages/shared/src/index.ts`：`status` 枚举加 `trashed`（第二刀，两 kind 共有删除态）；`Item["status"]` 相应更新
- [x] T029 [US3] `apps/server/src/storage/repo.ts`：新 `trashedAtOf(db, itemId)`（同 `completedAtOf`：版本链末条 status=trashed 的 at）；新 `purgeTrashed(db, olderThan)`：物理删 >阈值的 item_versions/evidence/item_views 行，删前 stderr 留痕"删了什么、原状态"，**不碰** raw_inputs/fragments/uncertain_inputs；事务内执行
- [x] T030 [US3] `apps/server/src/routes/items.ts`：加删除路由（`POST /api/items/:id/trash`，追加 trashed 版本、复活反向）；`deriveTrashed`/purge 路由并入本文件或独立 `trash.ts`（按 T016 同款判判定）
- [x] T031 [US3] `apps/server/src/executor/fence.ts`：trashed 条目写操作拒收（OQ-12：要改先恢复）；`complete_item`/`update_item` 目标为 trashed 即拒
- [x] T032 [US3] `apps/server/src/agent0/prompt.ts` + `tools.ts`：检索面排除 trashed（OQ-9 补齐）；前置围栏工具 `delete_item`（同 `resolve_uncertain` 款式，OQ-8 对话删除）

### 前端实现

- [x] T033 [P] [US3] `apps/web/src/api.ts`：加 `trash(id)` / `restore(id)` / `purge()`；BoardView/NoticeView 类型随 shared 感知 trashed
- [x] T034 [P] [US3] `apps/web/src/components/ActivityBar.tsx`：加「回收站」一级入口（`Trash2`，不显示计数）；view 联合类型加 `"trash"`
- [x] T035 [US3] 新 `apps/web/src/components/TrashPanel.tsx`：混合列表（两类、行标 kind）、按 trashedAt 倒序、复用 ItemBody 查看；每行「恢复」；页级唯一「一键清理 >15d」按钮（二次确认，文案说明原文档案不受影响）；**无删除/清空入口**（FR-017）
- [x] T036 [US3] `apps/web/src/components/Board.tsx` + `NoticePanel.tsx`：行右缘删除按钮接 `api.trash(id)`（一步进回收站、不弹确认，OQ-8）——NoticePanel 的删除占位在此落地
- [x] T037 [US3] `apps/web/src/App.tsx`：view 分支加 trash → TrashPanel

**Checkpoint（第二刀 commit 回滚点）**: 回收站闭环可独立演示；`npm run check` 全绿。**此处建 rollback commit。**

---

## Phase 5: Polish & Cross-Cutting Concerns

- [x] T038 [P] 全量 grep 旧术语零残留复核：`archived`/`归档`/`archive_item`/`四段`（代码注释里的"迁移对照/历史记录"除外，逐条确认性质）；`kind`/`trashed` 每处引用真落地
- [x] T039 [P] `npm run check`（tsc+eslint+vitest）+ `npm run check:dead`（knip，删净的 archive*/preArchivedStatus 零死代码）+ `npm run build -w @summarizing/web` 全绿
- [x] T040 `scripts/seed-demo.ts`：去 arch 示例、加 notice + trashed 演示数据（demo 账户可演示通知闭环 + 回收站）
- [x] T041 CHANGELOG.md 记本批（通知类别 / 取消归档 / 回收站）；版本号按 docs/12 规范（次版本：重大功能/体验重构）
- [ ] T042 真实入口走查（spec SC-001~006）：一条"课改地点"群消息→分钟级进通知页；通知 100% 不看板；删除→复活→清理链路；raw_inputs 可检索被清项

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 0 (影响面/脏形态)**: 无依赖，立即开工——**合并/删除符号前必做**
- **Phase 1 (Foundational)**: 依赖 Phase 0；**阻塞 US1 与 US3**（都读写 kind/status 终态）
- **Phase 2 (US1 + 取消归档，第一刀 MVP)**: 依赖 Phase 1
- **Phase 3 (US4 图标)**: 依赖 Phase 2（图标是入口的门牌，无入口则无图标）
- **Phase 4 (US3 回收站，第二刀)**: 依赖 Phase 1；其「删除按钮接线」（T036）依赖 Phase 2 的 Board/NoticePanel
- **Phase 5 (Polish)**: 依赖所有 desired stories 完成

### User Story Dependencies

- **US1 + FR-018（第一刀，P1）**: Phase 1 完成后可独立实现与验收——**MVP**。通知闭环 + 三段看板 + 存量迁移。
- **US4（P3）**: 随第一刀落（入口先于门牌），并入第一刀验收。
- **US3（第二刀，P2）**: 与通知正交，Phase 1 后可独立实现；唯删除按钮要接到第一刀已建的 Board/NoticePanel 行上（T036）。

### 关键串行点（不可并行）

- T003–T007（契约 + 迁移）是硬前置：US1 与 US3 都在它之后。
- T013（ddl 形状围栏）依赖 T003 的 kind 进入 ChangeItemSchema（T007 同批）。
- T028（status 加 trashed）是第二刀独立枚举步，与第一刀的"status=만 todo/done"不冲突但**必须在第二刀 tests 前**落。

### Parallel Opportunities

- Phase 2 的 tests（T008–T011）可并行写（不同测试文件）。
- Phase 2 后端（T012–T017）与前端（T018–T022）在 T018/T019 之后可分叉并行（前端 mock shared 新类型）。
- Phase 4 的 tests（T025–T027）可并行；repo（T029）与 routes（T030/031）顺序依赖，前端（T033–T037）可并行。
- T023 与 T024 可并行（图标 vs 文档，互不踩文件）。

---

## Parallel Example: 第一刀（US1 + 取消归档）

```bash
# 三个真实入口测试一起写（不同文件）：
Task: "board.test.ts 加「通知不进看板」断言"
Task: "schema-migrate.test.ts 加 v1→v2 archived→done 迁移用例"
Task: "board.test.tsx 四段断言改三段 + 夹具去 archived / 加 notice"

# 契约落定后，前后端分叉：
Task(后端): "board.ts 删 archived 段 + 过滤 kind=task"
Task(前端): "Board.tsx SECTIONS 删 archived 段 + rows 过滤"
```

## Parallel Example: 第二刀（US3 回收站）

```bash
Task: "repo.trashedAtOf + purgeTrashed（事务 + stderr 留痕）"
Task: "TrashPanel.tsx 混合列表 + 恢复 + 一键清理二次确认"
Task: "api.ts trash/restore/purge + ActivityBar Trash2 入口"
```

---

## Implementation Strategy

### MVP First（第一刀 = US1 + 取消归档）

1. Phase 0（影响面/脏形态核对）
2. Phase 1（Foundational：kind/status 契约 + archived→done 迁移）——**最关键、唯一有数据风险**
3. Phase 2（US1 通知闭环 + 三段看板 + 存量迁移）
4. Phase 3（US4 图标 + 文档统一）
5. **STOP and VALIDATE**：演示通知闭环 + 三段看板；`npm run check` 全绿 → **建 rollback commit**

### Incremental Delivery

1. 第一刀交付：通知可用、看板三段、存量归档已迁移、无旧术语残留。
2. 第二刀交付：回收站可用（删除/复活/一键清理），与通知正交、不破坏第一刀。
3. Pol全绿收口 + CHANGELOG + 版本号。

### 单人执行顺序（本项目为单人 pace）

Phase 0 → 1 → 2 → 3（第一刀 commit）→ 4（第二刀 commit）→ 5（收口 commit）。两刀之间系统始终可独立使用（纪律 II）。

---

## Notes

- [P] = 不同文件、无未完成依赖，可并行。
- [Story] 标签用于追溯；Foundational 任务无 Story 标签（阻塞所有故事）。
- **测试先写并确认 FAIL 再实现**（宪法 V：真实入口断言用户所见；spec SC-005）。
- 每刀收口建 commit（**回滚点建在动刀简化之前**——CLAUDE.md 最终审查方法）。
- 🔴 类型红线：禁 `as`/`as unknown as`/`!`/`any`；`kind`/`status` 都是 zod enum，编译期+运行时同源。新增路由/端点走 zod parse。
- 🔴 迁移只改 `status` 值、不删版本链；`raw_inputs`/`fragments`/`uncertain_inputs` 永不物理删（除 purge 环节删挂 item 的行）。
- 全量换词（item→…）**不在本批**（用户：先不改）。
