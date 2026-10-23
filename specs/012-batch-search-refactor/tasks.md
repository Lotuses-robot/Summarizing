---
description: "Task list for 批次与检索重构（012）"
---

# Tasks: 批次与检索重构（命名统一 + 全文检索 + 封批三闸）

**Input**: Design documents from `/specs/012-batch-search-refactor/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/search-raws.md

**Organization**: 分四批交付（批 1 → 批 2 → 批 3 → 批 4），每批独立可发布。

## Phase 0: 影响面与脏形态（必填——宪法「边界加固三规矩」的结构性强制）

- [x] T000 [P] 对每个要改的符号跑 `codegraph explore`，全部消费点已并入 plan.md 的影响面清单（A–F 六张表）
- [x] T001 [P] 边界字段脏形态枚举表已写入 spec.md（identity 10 态 / 索引列 4 态 / 查询参数 9 态）

- [x] T002 [P] 先写脏输入测试（**预期 FAIL**）——见各批的「先红后绿」任务

## Phase 1: 批 1 —— 依赖 + 切词模块 + 命名统一 + 迁移 v5

### 1.1 依赖与基建（阶段 0）

- [x] T010 [P] `apps/server/package.json` 加 `nodejieba` 依赖；`npm install` 确认能编译出 `build/Release/nodejieba.node`
- [x] T011 [P] 新建 `apps/server/src/search/tokenize.ts`：
  - `tokenizeContent(content: string): string` —— jieba 切词 + 剔除标点/单字符/控制字符 + 空格分隔；**图片占位 `[图片](url)` 整体替换为「图片」、URL 不入词袋**
  - `tokenizeIdentity(identity: Identity): string` —— 键名 + 值共同构成词袋（形状无关）
  - `MAX_TOKENS_CHARS` 上限（超长截断 + 留痕）
  - JSDoc 人话描述（每个导出函数）
- [x] T012 [P] 新建 `apps/server/src/test/searchTokenize.test.ts`：图片 URL 不进词袋 / 身份词袋含键名 / 部分匹配可搜（切词后「课群」命中「英语课群」）/ 空串 / 超长截断

### 1.2 契约改名（阶段 1）

- [x] T020 [P] `packages/shared/src/index.ts`：
  - `SourceIdentitySchema` → `IdentitySchema`，refine 改「必须含非空 `displayName`」
  - `SourceIdentity` → `Identity`
  - `RawInputSchema.sourceType` → `source`；`.sourceIdentity` → `.identity`
  - `IngestRequestSchema` 同改
  - `UncertainInputSchema` 同改
  - `PipelineRunSchema.sourceType` → `source`；`.sourceLabel` → `.displayName`
  - `sourceLabelOf()` → `displayNameOf()`；`sourceIdentityLabel()` → `displayNameWithDetails()`
  - `normalizeSourceIdentity()`：**兼容读**（先 `displayName` → 再 `sourceLabel` → 再 `name` → 兜「未知来源」）
- [x] T021 [P] `packages/shared/src/ingest-time.test.ts` 等 shared 内测试同步新名
- [x] T022 `apps/server/src/storage/repo.ts`：`insertRawInput` / `rowToRawInput` / `listRecentRawInputs` / `latestRawAtForSourceType` / uncertain 读写路径 —— 字段名同步
- [x] T023 `apps/server/src/storage/schema.ts`：`raw_inputs.source_type`→`source`、`.source_identity`→`identity_json`；`uncertain_inputs` 同改
- [x] T024 `apps/server/src/agent0/digest.ts`：`buildUserBrief` 的「来源身份」行用新键名
- [x] T025 `apps/server/src/application/notice.ts` + 其他服务端消费点同步
- [x] T026 `apps/web/src/`：ItemBody / QuoteOverlay / UncertainReview / PipelineView / api.ts —— 逐处改名（**零业务逻辑变化**）
- [x] T027 `apps/server/src/sources/nc/`：`groupName` → `displayName`（types.ts:69 / index.ts:230 / index.ts:307）
- [x] T028 全仓服务端 + web 测试：旧名 → 新名（**断言行为不变**）

### 1.3 迁移 v5（改名）

- [x] T030 `apps/server/src/storage/migrate.ts`：`SCHEMA_VERSION` 4 → 5
- [x] T031 `apps/server/src/storage/db.ts`：`ensureSchema` 加幂等列改名（参照 `renamePluginColumnIfNeeded`）+ **存量 JSON 键改名**（`json_set` + `json_remove`，只动确为对象的行）
- [x] T032 `apps/server/src/test/migration.test.ts`：存量 `{"sourceLabel":"x"}` → `{"displayName":"x"}` / 旧键直读不崩 / 幂等重跑
- [x] T033 `npm run check` + `npm run check:dead` 全绿

## Phase 2: 批 2 —— FTS5 索引 + `search_raws`

### 2.1 FTS5 索引（阶段 2，迁移 v6）

- [x] T040 [P] `apps/server/src/storage/schema.ts`：`raw_inputs` 加 `tokens` / `identity_tokens` 两列
- [x] T041 `apps/server/src/storage/db.ts`：`ensureSchema` 建 FTS5 虚表 `raw_fts`（`content='raw_inputs'`, `content_rowid='rowid'`）+ **insert/update/delete 三触发器**（**必须先建后插**——实测踩坑）
- [x] T042 `apps/server/src/storage/migrate.ts`：`SCHEMA_VERSION` 5 → 6
- [x] T043 `apps/server/src/storage/repo.ts`：`insertRawInput` 写 `tokens` / `identity_tokens`（用 `search/tokenize.ts`）
- [x] T044 `apps/server/src/storage/repo.ts`：新增 `rebuildSearchIndex(db)`（存量批次补索引 + `raw_fts('rebuild')`）
- [x] T045 `apps/server/src/test/searchIndex.test.ts`：触发器同步（插/改/删）/ 存量 rebuild / MATCH 命中

### 2.2 查询构造器（阶段 2）

- [x] T050 [P] 新建 `apps/server/src/search/query.ts`：
  - 维度 → SQL 的**唯一出处**：内容模糊（MATCH）/ 身份精确（`json_extract` + **键名白名单**）/ 身份模糊（identity_tokens MATCH）/ 时间区间 / 信源
  - `mode: "all"`（交集）/ `"any"`（并集，跨字段用 UNION）
  - FTS5 保留字转义（逐词加引号 + 双引号转义）
- [x] T051 `apps/server/src/test/searchQuery.test.ts`：同列 AND/OR / 跨字段 AND / UNION 并集 / json_extract 精确 / 时间区间 / 前缀匹配 / 保留字 / 引号转义 / 键名白名单拒绝

### 2.3 `search_raws` 工具（阶段 3）

- [x] T060 [P] `packages/shared/src/index.ts`：新增 `SearchRawsArgsSchema` / `SearchRawsResultSchema` / `SearchRawHitSchema`（见 `contracts/search-raws.md`）
- [x] T061 `packages/shared/src/index.ts`：**删除** `SearchRecentRawsArgsSchema` / `SearchRecentRawsResultSchema` / `RecentRawItemSchema`
- [x] T062 `apps/server/src/agent0/tools.ts`：新增 `searchRaws` 实现（调 `search/query.ts`）；`TOOL_DEFS` 加 `search_raws` 描述（讲清并/交、截断标注）
- [x] T063 `apps/server/src/agent0/tools.ts`：**删除** `searchRecentRaws`；`sameIdentity` 改判据 = **除 `sender` 外的全部稳定键**
- [x] T064 `apps/server/src/agent0/digest.ts`：`runTool` 的 `search_recent_raws` 分支 → `search_raws`
- [x] T065 截断与预算：单次结果**总量 ≤ 2,000 字**、单条摘要 ≤ 150 字、每条带 `truncated` + `contentLength`、整体带 `more`
- [x] T066 参数越界**直接报错**（`query` 超长 / 时间格式非法 / 区间反了 / 跨度 > 90 天 / `limit` 超上限或 ≤0 / `mode` 非法 / 身份键名不在白名单）
- [x] T067 `apps/server/src/test/digest.test.ts`：删旧 2 条测试；新增 `search_raws` 用例（各维度 + 并/交 + 截断标注 + 越界报错）
- [x] T068 `npm run check` + `check:dead` + `build -w @summarizing/web` 全绿

## Phase 3: 批 3 —— nc 封批三闸

- [x] T070 [P] `apps/server/src/sources/nc/types.ts`：`dueGroups` 改判据 —— **条数上限 / 字节上限 / 时间上限**任一命中即到期；`windowMinutes` 降级为「静默触发条件」之一
- [x] T071 `apps/server/src/sources/nc/index.ts`：`sealGroup` / `runSweep` 适配新判据；三闸默认值可配（即时生效、不重启）
- [x] T072 `apps/server/src/sources/nc/index.ts`：`settings()` 增三闸设置项（`windowMinutes` 的描述改为「静默触发窗」）
- [x] T073 `apps/server/src/test/nc.test.ts`：三闸各自触发各一条；行协议保真不变；空批守卫不变；多人群不署名不变
- [x] T074 `docs/08-nc对接指南.md`：**订正「崩溃丢最近一个窗口（≤3 分钟）」的假承诺**为实际三闸上界；补三闸设置项说明
- [x] T075 `docs/07-接新源检查单.md`：「打包」节更新为三闸范式 + 新检索工具的形状无关性

## Phase 4: 批 4 —— 提示词与文档

### 4.1 提示词

- [x] T080 `apps/server/src/agent0/prompt.ts`：【检索面】段重写 —— `search_raws`、讲清并/交语义与截断标注（`truncated` / `contentLength` / `more`）
- [x] T081 `apps/server/src/agent0/prompt.ts`：【矛盾决断】段改弱 —— 权威性**只能**来自 `identity` 里实际存在的字段；**无依据不得决断**（一律入库）
- [x] T082 `apps/server/src/test/promptRules.test.ts`：断言新措辞（无依据不得决断 / 检索面提到 `search_raws`）

### 4.2 文档同步（自审三问）

- [x] T090 `docs/00-数据契约.md`：§十一 表结构（列名 + `displayName` 保留键 + 改名说明 + FTS5 索引说明）
- [x] T091 `docs/01-规格.md`：§4.3（检索面/工具）、§4.7（权威性判据）、§4.10（工具表）、§5.3（RawInput 边界 + 索引列）
- [x] T092 `docs/02-决策台账.md`：**新增 D-127**（完整决策记录）
- [x] T093 `docs/03-开放问题.md`：记本轮**不做**项（`search_items` 无上限返回、跨表按元素反查批次、拼音）
- [x] T094 `docs/04-验收.md`：新增本特性验收清单（含真机走查项）
- [x] T095 `CLAUDE.md`：状态行 + 术语（信源/身份/显示名）+ 检索与封批现状
- [x] T096 **自审三问**：①改完了吗（跨文件一处不漏）②删干净了吗（`grep` 旧名 `sourceType|sourceIdentity|sourceLabel|sourceLabelOf|sourceIdentityLabel|groupName` 零残留）③新特性做全了吗

## Phase 5: 部署三处（与批 1/2 并行验证）

- [x] T100 [P] `Dockerfile`：构建阶段装 `python3` / `make` / `g++`；为 nodejieba 开口编译脚本（或改「宿主编好、镜像只拷 `.node`」）
- [x] T101 [P] `scripts/build-release.mjs`：nodejieba 精简拷贝（`package.json` + `build/Release/*.node` + 词典）
- [x] T102 [P] CI：确认 windows runner 能编 nodejieba（`--ignore-scripts` 的影响）
- [x] T103 `npm run build:release` 产出且含 nodejieba 运行时产物；Docker 构建通过

## Phase 6: 收口

- [x] T110 `npm run check` + `npm run check:dead` + `npm run build -w @summarizing/web` 全绿
- [ ] T111 按项目闭环流程：`/review high` → 修阻断项 → `git commit`（回滚点）→ `/simplify` → 行为等价性核对 → 用户 S 审查 → 收口提交
- [ ] T112 CHANGELOG + 版本号 + tag（发布流程见 `docs/12`）
