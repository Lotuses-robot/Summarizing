# Implementation Plan: 信息分流（通知类别）+ 回收站 + 取消归档

**Branch**: `007-information-notice-trash` | **Date**: 2026-10-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/007-information-notice-trash/spec.md`

> 本计划覆盖 spec 的**全部** user story：Story 1/2/4（通知 + 信息统一载体 + 图标）＋ **FR-018 取消归档** ＋ Story 3（回收站）。用户 2026-10-16 定「就这些」后把六个未决项一次拍齐（见 spec 末尾已定备忘），无遗留待问项。
>
> **交付顺序**（spec「交付拆分」）：第一刀 = 通知 + 取消归档（改同一批看板/status 枚举，合并没有额外 schema 成本）；第二刀 = 回收站。两刀都在本 plan 内编排，实现仍按任务的 Phase 边界分批推进、每批完 `npm run check` 绿。

## Summary

在既有 `Item` 追加式版本链 + 证据框架上加一个 `kind` 字段（`task`/`notice`）作分类轴，与既有 `status` 演化轴正交；通知经独立活动栏入口查看、不进看板、无 ddl。回收站不做新表，复用 `status=trashed` 版本追加 + 独立入口 + 一键清理 >15d。同时**收缩**既有能力：取消 `archived` 状态、看板四段并回三段、存量 `archived` 迁移为 `done`。

三条主线共享同一处地基改动——`ItemSchema.status` 枚举 + `kind` 增量——故合成一个 plan，但按任务 Phase 分成可独立验收的阶段。

## Technical Context

**Language/Version**: TypeScript 5.x，strict（`no-explicit-any` / 无 `as` 绕过 / 无 `!`，唯一例外网络边界单层 `as` 隔离在 `apps/web/src/api.ts`）

**Primary Dependencies**: React 19 + Vite + Tailwind v4 + lucide-react（前端）；Fastify 5 + Drizzle + better-sqlite3（后端）；zod（契约唯一来源，`packages/shared`）；Vitest + happy-dom + @testing-library（测试）；openai SDK（agent0 LLM）

**Storage**: SQLite 每账户一库 `data/users/<uid>.db`；`item_versions` 追加式版本链（`snapshot` JSON 列含 `status`）；`PRAGMA user_version` 门控迁移（`storage/migrate.ts`）

**Testing**: 真实入口断言（HTTP 端点 / 真实组件渲染）；`apps/server/src/test/*`（board/repo/digest/nc/isolation/schema-migrate/migration…）+ `apps/web/src/test/*`

**Target Platform**: Linux 服务器（Docker，sum.lotuses.cn）+ 本地 dev；单机自用 = 一个账户的实例

**Project Type**: web application（React SPA + Fastify API，monorepo `apps/server` + `apps/web` + `packages/shared`）

**Performance Goals**: 看板派生是 10s 轮询热路径——`kind` 过滤在看板装配期完成，不引入 N+1 或额外全表扫；通知页倒序同 `deriveItemsWithVersion` 一次派生后内存排序

**Constraints**:
- 🔴 类型红线：禁 `as`/`as unknown as`/`!`/`any`；zod 解析 + 类型守卫。`kind`/`status` 都是 zod enum，编译期 + 运行时同源。
- 🔴 读路径零容忍：`ItemSchema.status` 收窄后，存量 `archived` 快照会让 `ItemSchema.parse`（`deriveItemsWithVersion`/`deriveItem` 必经）抛错 → 全站读路径 500。**必须随批迁移**，无"以后再说"选项。
- 🔴 归档/悬置语义铁律不可破：搁置 ≠ 待删除（01§4.13）。回收站是 `status=trashed`（删除态），与"搁置/归档/完成"是不同语义轴，不混。
- 数据不迁移红线之外：`raw_inputs`/`fragments`/`uncertain_inputs` 永不物理删。

**Scale/Scope**: 单机单人为主；通知/回收站按账户隔离走现有 Space 构造；存量数据量小（个人库），JSON 列 UPDATE 迁移可直接全表跑。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 宪法条 | 结论 | 说明 |
|--------|------|------|
| I 先跑通完整业务循环 | ✅ | 通知闭环（digest→kind=notice→通知页可见）是第一刀的独立可验收循环；取消归档同步落地，系统每阶段可独立使用 |
| II 每阶段结束可独立使用 | ✅ | 第一刀完 = 三段看板 + 通知可用；第二刀完 = 回收站可用。拆成两个 commit 回滚点 |
| III 模块数量受控 | ✅ | 不新增顶层抽象。通知/回收站复用 Item/版本链/证据/FilterBar；新代码 = 共享 schema 增量 + 1 个 NoticePanel 视图组件 + trash 派生/purge；不开 utils 类含糊目录 |
| IV 不写没有调用者的东西 | ✅ | 每个新函数都有本轮调用者；不预留"知识库/全局搜索/自定义分栏"触点（spec 明确不做） |
| V 真实入口验证 | ✅ | 通知经 HTTP `get_board`/通知端点 + 真实组件；trashed 改写/复活/purge 走真实 repo + 路由；断言用户所见 |
| VI 不确定先问 | ✅ | spec 六 OQ 已全部由用户拍定；plan 不引入新未决项 |
| 产品不变量（原文先行/证据链/不静默/LLM 不裸写/粘贴≠指令/零变更合法） | ✅ | 通知与事项同走证据链 + 版本链；purge 删前 stderr 留痕；通知判定仍归 agent0（提示词描述），围栏只校验 ddl 形状/ID 真实/引文逐字 |
| 高频禁区 | ✅ | 无日期继承、无打分、无裸日期、无"还有 N 件没看"式措辞（OQ-10 定：纯数字计数）、搁置区不当待删除 |
| 工程红线 | ✅ | 类型严格；`kind`/`status` 单一来源 `packages/shared`；迁移留痕 + 幂等；边界字段先列脏形态（见下） |
| 质量门 | ✅ | `npm run check` + `check:dead` + web build 全绿才收口 |

**无违规需进 Complexity Tracking。**

## Project Structure

### Documentation (this feature)

```text
specs/007-information-notice-trash/
├── plan.md              # 本文件
└── tasks.md             # Phase 2 产出（/speckit-tasks，本 plan 不含）
```

### Source Code (repository root)

```text
packages/shared/src/index.ts   # ItemSchema 加 kind；status 枚举收窄；BoardView/ChangeItem 同步
apps/server/src/
├── storage/schema.ts          # item_versions.snapshot 注释同步（DDL 无结构变）
├── storage/db.ts              # ensureSchema 追加 archived→done 迁移；migrate.ts SCHEMA_VERSION=2
├── storage/migrate.ts         # SCHEMA_VERSION 1→2
├── storage/repo.ts            # trashedAt 派生（同 completedAtOf）；purge 物理删
├── application/board.ts       # 三段装配 + 排除 notice/trashed；NoticeView 派生
├── executor/executor.ts       # update_item kind 切换校验（ddl 形状）；complete_item 拒 notice
├── executor/fence.ts          # notice+dueDate 整条拒收；trashed 写拒收（OQ-12）
├── agent0/prompt.ts           # 【准入】段：非事项但有用→通知；检索面含 notice
├── agent0/tools.ts            # search_items 覆盖 notice、排除 trashed
├── routes/items.ts            # 删 archive 路由；加删除/恢复/trash 列表/purge 路由
├── routes/trash.ts            # 新：GET 列表 + POST purge（或并入 items.ts，实现时按调用方定）
└── ...
apps/web/src/
├── components/ActivityBar.tsx # 加 通知(Inbox)/回收站(Trash2) 一级入口 + 徽标
├── components/NoticePanel.tsx # 新：通知页（复用 ItemBody/FilterBar）
├── components/TrashPanel.tsx  # 新：回收站页（恢复 + 一键清理）
├── components/Board.tsx       # 四段→三段；删归档按钮；加删除按钮；行标 kind
├── api.ts                     # 删 archive；加 trash/purge
└── App.tsx                    # view 类型加 notice/trash 分支
```

**Structure Decision**: 沿用既有「事件槽 apps/web + apps/server + 共享 packages/shared」结构，不新增顶层目录。通知/回收站在 server 侧是 `application/` 的派生视图 + `routes/` 的薄路由；在 web 侧各一个视图组件，与 Board 平级。回收站路由是并入 `items.ts` 还是独立 `trash.ts`，实现时按"文件只说得出它是什么"判断（倾向并入 items.ts——trashed 是 item 状态的一种投影，避免为 2 个端点单开文件）。

## 影响面清单（必填——改值形状/函数签名/枚举值前生成）

> 用 `codegraph explore` + grep 列出全部消费者。**改动前逐项同步，改完 grep 复核零残留。**

### A. `ItemSchema.status` 枚举 `["todo","done","archived"]` → `["todo","done"]`

| 变更的符号/值/枚举 | 全部消费点（file:line） | 本轮同步动作 |
|---------------------|------------------------|-------------|
| `ItemSchema.status`（shared） | packages/shared/src/index.ts:109 | 收窄枚举 |
| `ItemVersionSchema.snapshot.status` | packages/shared/src/index.ts:303 | 同步收窄（注释去 archived） |
| 存量 `archived` 数据行 | item_versions 表 JSON 列 | ensureSchema 加迁移（见迁移设计） |
| `buildBoard` archived 段 | apps/server/src/application/board.ts:52-55,75 | 删段 + 装配三段 |
| `completedAtOf`（done 派生） | repo.ts:152；board.ts:46 | 不变（archived 从无 completedAt，迁移后 archived→done 会派生 completedAt=迁移时新造版本 at——需确认 semantic，见脏形态） |
| `preArchivedStatus` | repo.ts:167；routes/items.ts:56 | 删（归档取消后无"撤回归档"） |
| `manualSetStatus` archive 分支 | routes/items.ts:13-30,78-83 | 删 archive 路由 + action 联合成员 |
| Board 四段元数据 `archived` | apps/web/src/components/Board.tsx:23-54,349 | 删段；`RowAction` 去 archive |
| 归档按钮 + reopen 文案 | Board.tsx:99,192-200,217-222 | 删归档钮；reopen 只"恢复待办" |
| `api.archive` | apps/web/src/api.ts:177-178 | 删 |
| `ItemBody` action 名 `archive_item` | apps/web/src/components/board/ItemBody.tsx:24 | 删映射项（存量版本史里 archive_item 的 detail 仍在库里，渲染层要能显示旧 action 名——见脏形态） |
| seed-demo `arch` | scripts/seed-demo.ts:384-404 | 去归档示例 |
| 测试断言 archived | apps/server/src/test/board.test.ts, apps/web/src/test/board.test.tsx, isolation.test.ts, helpers/board-fixtures.ts, lib/appearance.ts(loadSectionFold archived) | 逐项改三段 |
| 文档 归档措辞 | docs/00 §三/§四/§十/§十三、docs/01 §4.3、docs/02(D-26/D-83)、docs/03、docs/04、CLAUDE.md | 全部同步去归档；D-83 记"已取消" |

### B. 新增 `kind` 字段（task/notice）

| 变更的符号/值/枚举 | 全部消费点（file:line） | 本轮同步动作 |
|---------------------|------------------------|-------------|
| `ItemSchema` 加 `kind` | shared index.ts:104 | 加字段 + `.default("task")`（存量快照兼容，不迁移 kind） |
| `ItemSnapshotSchema` | shared index.ts:126 | 加 kind |
| `ItemVersionSchema.snapshot` | shared index.ts:300 | 加 kind |
| `appendItemVersion` 参数 | repo.ts:83-113 | snapshot 加 kind 透传 |
| `create_item` / `update_item` | executor.ts:53-102 | create 落 kind；update 校验 ddl 形状并承载切换 |
| `ChangeItemSchema` 成员 | shared index.ts:323-386 | create_item/update_item 加 kind 可选字段 |
| 围栏校验 | fence.ts:47-79 | notice+dueDate 整条拒；update 切换查 ddl 形状 |
| `buildBoard` / 通知派生 | board.ts | board 过滤 `kind==="task"`；新 NoticeView 取 `kind==="notice"` |
| `search_items`（agent0） | agent0/tools.ts | 结果覆盖 notice、排除 trashed |
| 【准入】段 prompt | agent0/prompt.ts | 非事项但有用→建 notice；描述"什么值得保留" |
| ItemBody / Board 行 | web board/ItemBody.tsx, Board.tsx | 行标 kind；通知行无 ddl 位 |
| ActivityBar / NoticePanel | web | 新入口 + 新视图 |
| 文档 | docs/00（Item 结构）、docs/01 §4.x、CLAUDE.md | 加 kind 轴、去归档、通知入口 |

### C. `trashed` 删除态（第二刀，正交）

| 变更的符号/值/枚举 | 全部消费点（file:line） | 本轮同步动作 |
|---------------------|------------------------|-------------|
| `ItemSchema.status` 加 `trashed` | shared index.ts（第一刀同处改） | status = todo/done + trashed（两 kind 共有） |
| 所有 status 消费点派生 | board.ts / repo.ts / web | 看板/通知排除 trashed；trash 视图专取 |
| purge 物理删 | repo.ts 新函数 | 删 item_versions/evidence/item_views，raw/fragments/uncertain 不动，stderr 留痕 |
| 删除入口 | Board 行/NoticePanel 行/对话围栏工具 | 行右缘删 + 前台围栏 `delete_item`（OQ-8） |

### D. schema 迁移（跨 A/B，最关键）

| 变更的符号/值/枚举 | 全部消费点（file:line） | 本轮同步动作 |
|---------------------|------------------------|-------------|
| `SCHEMA_VERSION` 1→2 | apps/server/src/storage/migrate.ts:13 | +1 |
| `ensureSchema` 加迁移 | apps/server/src/storage/db.ts:31,120-170 | 追加 `archived→done` JSON 列 UPDATE（先例 migrateByToProvenance:185） |
| 迁移测试 | apps/server/src/test/schema-migrate.test.ts, migration.test.ts, backup.test.ts | 加 v1→v2 archived 迁移用例 |

## Phase 0: 脏形态枚举（边界加固三规矩①——先于任何 schema 改动）

> spec 每处边界字段，一次枚举 dirty form 全修，不逐场景返工。

### `kind` 字段（读路径 `ItemSnapshotSchema.parse`）

| 形态 | 处置 |
|------|------|
| 存量快照**缺席** kind | `.default("task")` —— 存量全为事项，默认 task 与本条件一致（spec Edge Cases 已定，非语义兜底：默认值与数据事实相符） |
| `kind` 非枚举值（脏值，如 "Task"/""） | zod enum 拒收 → 该条 `ItemSchema.parse` 抛错 → 与现状非法 status 同路径（投毒拒收，非静默） |
| `kind: null` | enum 不含 null → 拒收（不用 `.nullable()`——字段要么合法要么拒，不造第三态） |
| update_item 只改 kind 不改元素 | 合法：kind 切换本身就是变化，落版本（区别于"空变化不落版本"的既有 guard 要放行 kind 变化） |

### `status` 收窄（archived → todo/done）

| 形态 | 处置 |
|------|------|
| 存量快照 `status:"archived"`（**迁移前**） | 读路径 500 的根因 → 迁移负责清零，**不留读路径兜底**（兜底=把删除的状态偷偷复活成语义外值，违冗余红线） |
| 存量快照 `status:"archived"`（**迁移后**） | 已不存在（迁移把 JSON 列 archived→done）；若有漏网（如迁移中途写入）→ 同上拒收 |
| `status:"trashed"` 第二刀引入 | 第二刀同处枚举加；第一刀不动 trashed |
| detail 文本里含历史 action `archive_item` | 纯字符串 detail，不受枚举影响；UI 旧版本史仍显示"归档"字样（历史如实，不清洗）—— 见下方"历史版本如实" |

### `archived→done` 数据迁移（JSON 列）

| 形态 | 处置 |
|------|------|
| `snapshot` 非合法 JSON | `json_valid(snapshot)=0` 的行不匹配 WHERE（用 `json_extract`），跳过——这些行本就在读路径抛错，迁移不新增破坏 |
| 多版本链：v1 archived → v2 archived（同 item 多版本都 archived） | `UPDATE ... WHERE json_extract(snapshot,'$.status')='archived'` 全改——**链末才决定当前状态**，中间版本改 done 不影响"当前=done"的派生结果 |
| 中间版本 archived、末版 done（已撤销归档） | 只改 status='archived' 的行，末版 done 不动 → 当前仍是 done，正确 |
| 中间版本 done、末版 archived（归档了已完成项） | 末版 archived→done，当前变 done（语义：归档态并入完成态，符合用户"归档≈完成"判断） |
| 空库 / 全新库 | WHERE 无匹配行，0 行更新，幂等无害 |
| 重复迁移 | 幂等：第二次已无 archived 行 |

### 彻底删（purge）边界

| 形态 | 处置 |
|------|------|
| 删一个 trashed≤15d 的 item | purge 不动它（WHERE trashed>15d）；回收站内无单条彻底删入口（FR-008） |
| 删一个 item 的版本链 + evidence + item_views | 逐表 `DELETE WHERE item_id=?`；raw_inputs/fragments/uncertain_inputs **不碰**（FR-009） |
| purge 时该 item 又被并发写（digest 竞态） | 第二刀事务内删；trashed 写拒收（OQ-12）已在前序挡掉大部分；删前留痕含原状态 |

## Phase 1: 设计

### 数据模型变更

**Item 增加分类轴 `kind`；`status` 收缩 + 增删态：**

```ts
// shared/index.ts
ItemSchema = z.object({
  id, elements, tags,
  status: z.enum(["todo", "done", "trashed"]),   // archived 取消（FR-018）+ trashed 新增（Story3）
  kind: z.enum(["task", "notice"]).default("task"), // 分类轴；存量无此字段→task
  doubtNote,
})
```

- `kind` 用 `.default("task")`：存量快照无该字段时按 task 读（spec Edge Cases：存量全事项）。**不写 kind 数据迁移**（读路径 default 已覆盖，与 preArchivedStatus 的"读时派生"同哲学）。
- `status`：事项 todo→done，通知恒 todo（"活跃"= 未被删，不造 `active` 字面量），两者删除→trashed；口径见下方「通知 status 口径」。
- `task` 必须有 ddl（可留空）、`notice` 必无 ddl：**在围栏 + update 承载切换时查 ddl 形状**执行（FR-003/FR-014）。

**迁移 `archived→done`**（db.ts ensureSchema 末尾，先例 migrateByToProvenance）：

```ts
// 取消归档（FR-018 / D-83 反转）：存量 archived 快照并入完成态。
// 读路径 ItemSchema.status 收窄后零容忍 archived——不迁则全站读路径 500。
sqlite.exec(`
  UPDATE item_versions
  SET snapshot = json_set(snapshot, '$.status', 'done')
  WHERE json_valid(snapshot) AND json_extract(snapshot, '$.status') = 'archived'
`);
```

幂等（第二次 0 行）。随 `SCHEMA_VERSION` 1→2 走迁移前自动备份。

### 派生视图

- `buildBoard(db)`：`rows.filter(r => r.item.kind === "task" && r.item.status !== "trashed")` 后续按三段装配；notice/trashed 天然排除。
- 新 `deriveNotices(db)`（application/notice.ts 或并入 board.ts 导出）：`kind==="notice" && status!=="trashed"`，按 updatedAt 倒序，每行带 viewed（复用 `item_views`——OQ-11 已读）+ kind badge。
- 回收站 `deriveTrashed(db)`：`status==="trashed"`，两类混合，`trashedAt` 派生（同 completedAtOf：版本链末条 trashed 版本的 at）。

### 围栏（fence.ts）新增校验

1. `create_item(kind=notice)` 且 elements 含 `dueDate` → 整条拒（FR-003 / OQ-2）。
2. `update_item` 若改 kind：按目标 kind 查结果 ddl 形状执行——元素**只增改不删**，故 task 已带 dueDate 时元素集里 dueDate 删不掉 → **task（ddl 有值）→ notice 必拒整条**（"通知必无 ddl"的执行，spec 已定）；task（dueDate 留空/无）→ notice 允许；notice → task 不限（事项必须有 ddl、可留空）。task→任意方向都以"改动应用后的元素集"判。
3. `complete_item(kind=notice)` → 拒（US2-2，靠 kind 判不靠 status）。
4. 写 `trashed` item → 拒（OQ-12）。

### agent0 转向（prompt.ts）

【准入】段从"只是告知→不建"改为"非事项但有用 → create_item(kind=notice)"；提示词尽量描述"什么值得保留为通知"（U1：判据归 AI，无机械规则）。检索工具 search_items 结果含 notice、排除 trashed（OQ-9）。

### 前端

- ActivityBar 加两个一级入口（Inbox / Trash2 图标），排位 看板→通知→存疑库→流水→回收站（OQ-4）；通知入口未读徽标纯数字（OQ-10），回收站不显示。
- NoticePanel：倒序通知列表，复用 ItemBody 展开 + FilterBar（tag+文本，同看板）；行右缘删除；点开报 viewed。通知无 ddl 位显示。
- TrashPanel：混合列表行标 kind、按 trashedAt 倒序；每行「恢复」；页级唯一「一键清理 >15d」二次确认按钮；无删除/清空入口（OQ-8/FR-017）。
- Board：四段→三段的段元数据 + allRows 过滤；删归档按钮，加删除按钮（一步进回收站）；reopen 只"恢复待办"。

## 通知 status 口径（已定：方案甲，2026-10-16 用户拍）

- **通知恒 `todo`**：通知"活着但没删"时 status = `todo`；删除 → `trashed`；复活 → `todo`。**不引入 `active` 字面量**——"这是通知、不用你去完成"由 `kind=notice` 表达，不靠 status。
- status 全集最小化：`todo` / `done` / `trashed`（trashed 第二刀引入，两 kind 共有）。事项照常 todo→done；通知恒 todo 不进 done。
- "拒通知被完成"的判据 = `kind==="notice"`（围栏/fence + UI 按钮隐藏都按 kind 判），**不靠 status 白名单**——因为通知 status 与事项活跃态同值 todo，status 区分不了。
- spec 已按甲回改（Key Entities 两行 + US2-2 + FR-018 的三阶段枚举演进），spec 与实现不再有两套真相。

## 待落地检查（收尾自检，§十 纪律）

- [ ] `npm run check`（tsc+eslint+vitest）绿
- [ ] `npm run check:dead`（knip）零死代码（尤其删净的 archive* / preArchivedStatus）
- [ ] `npm run build -w @summarizing/web` 出包
- [ ] grep 旧术语零残留：`archived` / `归档` / `archive_item`（代码注释里的历史说明除外，需逐条确认是"迁移对照/历史记录"还是真残留）
- [ ] 00 契约 / 01 规格 / 02 台账（D-83 记取消、D-xx 记通知立项）/ 03 / 04 / CLAUDE.md 全部同步
- [ ] 存量归档事项迁移后进"已完成"段，有真实入口测试断言
