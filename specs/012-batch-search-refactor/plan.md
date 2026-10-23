# Implementation Plan: 批次与检索重构（命名统一 + 全文检索 + 封批三闸）

**Branch**: `012-batch-search-refactor` | **Date**: 2026-10-22 | **Spec**: [spec.md](./spec.md)

## Summary

三件事一起做（用户定：「一起吧，都是紧密相关的」）：

1. **命名统一**（用户的第一诉求：「代码中充满了 sourceLabel、source name、各种稀奇古怪的名称，有点混乱，这是我想要修好的主要原因」）——`sourceType`→`source`（信源）、`sourceIdentity`→`identity`（身份）、`sourceLabel`→`displayName`（显示名）；`sourceLabelOf`→`displayNameOf`、`sourceIdentityLabel`→`displayNameWithDetails`；nc 内部 `groupName`→`displayName`。**迁 schema**（存量 JSON 键一并迁）。
2. **检索重构**——`search_recent_raws` → **`search_raws`**：底层 FTS5（内容切词 + 身份词袋两列），支持**关键词 / 身份键值 / 信源 / 时间**任意组合，条件间可**交集（all）/ 并集（any）**；模糊与精确**同一工具**天生支持；截断必须标注（`truncated` + `contentLength` + `more`）。
3. **封批三闸**——nc 封批从「只按静默窗」改为**条数 / 字节 / 时间**三闸任一命中即切（忙群也定期切段），并订正 docs/08 那条**假的**「崩溃丢 ≤3 分钟」承诺。

**分词**用 `nodejieba`（用户拍板）。**部署三处**（用户已确认）：Docker 构建阶段装 node-gyp 工具链、便携包精简拷贝运行时产物、CI 可编译。

## Technical Context

**Language/Version**: TypeScript / Node 22+
**Primary Dependencies**: 新增 `nodejieba`（原生模块，源码编译）；其余沿用（better-sqlite3 / drizzle / zod / vitest）
**Storage**: SQLite（每账户一库）——**新增 FTS5 虚表 + 2 个索引列**；schema v4 → v5（改名）→ v6（索引）
**Testing**: Vitest（服务端 `makeTestRealm`/`inject`；web happy-dom）
**Target Platform**: 自托管服务器（Linux/Docker）+ Windows 便携包 + 本地开发
**Project Type**: 单仓多包（apps/server / apps/web / packages/shared）
**Performance Goals**: 单次检索 < 100ms（实测 20 万行 LIKE+JOIN+limit = 0–31ms；FTS5 走索引）
**Constraints**: 原文逐字不可变（01§5.3）；类型 strict 无 `as` 绕过；共享契约单一来源（D-52）；不写无调用者的东西
**Scale/Scope**: 单用户单账户量级（当前库 18 批 / 2.9KB；一年也就几千条）；但按 20 万批设计索引

## Constitution Check

| 门 | 结论 |
|---|---|
| I. 先跑通完整业务循环 | ✅ 本特性是**增强**现有循环（消化），不新增并行流程；不引入第二个写入路径 |
| II. 每阶段结束系统可独立使用 | ✅ 四批（改名 / 检索 / 封批 / 文档）各自可发布 |
| III. 模块数量受控 | ✅ 新增**一个**目录 `apps/server/src/search/`（切词 + 查询构造器），名字说得出是什么；不加 utils/features 兜底目录 |
| IV. 不写没有调用者的东西 | ✅ 删 `search_recent_raws`；**不**开 `search_exact_raws`（用户定：search_raws 天生支持模糊+精确）；**不**做拼音；**不**做跨表按元素反查 |
| V. 在真实入口验证 | ✅ 走真实 `makeAgentTools` + 真实 SQLite（内存库跑 FTS5）；断言 AI 看到的返回体字段 |
| VI. 不确定先问 | ✅ 命名方案 / 分词 / 并交语义 / 截断量 / 是否合并工具 均已与用户确认 |
| 产品不变量 | ✅ 原文先行（不改 `content`）；证据链不打折（围栏不动）；静默禁止（截断必须标注）；LLM 不裸操作存储（仍是只读真代码工具） |
| 工程红线 | ✅ 契约改字段名 → 前后端同时编译失败（D-52 真共享）；`json_extract` 的键名走白名单（不拼 SQL）；迁移用既有门控 |
| 边界脏形态枚举 | ✅ 见 spec「边界字段脏形态」两表（identity 10 态 / 索引列 4 态 / 查询参数 9 态） |
| 变形状回查消费者 | ✅ 见下方「影响面清单」 |

**Complexity Tracking**（填此表说明有偏离）：

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| 新增原生依赖 `nodejieba`（源码编译） | 中文分词是 FTS5 可用的前提（自带 unicode61/trigram 实测对 2 字中文全落空） | 纯 LIKE：模糊搜只能靠子串，中文体验差且无法按词组合；2-gram 零依赖但需自研切分器，与 jieba 词典质量有差距——**用户已拍板 jieba** |
| schema 连升两级（v4→v5→v6） | 改名与建索引是两类变更，分开可各自验证与回滚 | 合并一级：迁移失败时无法定位是改名还是索引出错，且回滚粒度变粗 |

## Project Structure

### Documentation (this feature)

```text
specs/012-batch-search-refactor/
├── spec.md          # 用户故事 + 功能需求 + 脏形态表（已写）
├── plan.md          # 本文件
├── tasks.md         # 任务清单（Phase 0 脏形态枚举 → Phase N 实现）
├── research.md      # 技术调研：FTS5 能力实测 + jieba 选型 + 缓存实测
├── data-model.md    # 实体与字段变更（改名 + 新增索引列 + FTS5 表）
└── contracts/
    └── search-raws.md   # search_raws 工具契约（args/result/错误）
```

### Source Code (repository root)

```text
apps/server/src/
├── search/                     # 新增：检索与切词（目录名说得出是什么）
│   ├── tokenize.ts             #   内容切词 + 身份词袋 + 图片占位处理（单一出处）
│   └── query.ts                #   查询构造器：维度 → SQL（并/交、模糊/精确）
├── agent0/
│   ├── tools.ts                # 改：search_raws 取代 search_recent_raws
│   └── prompt.ts               # 改：检索面段重写 + 矛盾决断段改弱
├── sources/nc/
│   ├── index.ts                # 改：封批三闸 + groupName→displayName
│   └── types.ts                # 改：dueGroups 判据 + 组批字段
├── storage/
│   ├── schema.ts               # 改：列改名 + 新增 tokens/identity_tokens
│   ├── db.ts                   # 改：ensureSchema（DDL + 触发器 + 存量变换）
│   └── migrate.ts              # 改：SCHEMA_VERSION 4→6
└── executor/fence.ts           # 不动

packages/shared/src/index.ts    # 改：契约改名 + search_raws 的 args/result schema
apps/web/src/                   # 改：跟随契约改名（前端零业务逻辑变化）
```

**Structure Decision**: 沿用现有单仓多包结构。`search/` 放在 server 侧（切词与查询是服务端职责；web 不做检索）。**不**新建顶层目录。

## 影响面清单（必填——改值形状/函数签名/枚举值前生成）

> 用 `codegraph explore` 列出全部消费者，逐项列入下表。**改名前必须先跑完本表**。

### A. 契约层（`packages/shared/src/index.ts`）

| 变更的符号/值 | 全部消费点 | 本轮同步动作 |
|---|---|---|
| `SourceIdentitySchema` → `IdentitySchema` | `shared:214`（定义）、`shared:225`（RawInputSchema 内）、`shared:237`（IngestRequestSchema 内）、`shared:420`（UncertainInputSchema 内）、`shared:504`（RecentRawItemSchema 内）、`shared:527`（UncertainHitSchema 内） | 逐处改名 + refine 改「必须含非空 `displayName`」 |
| `SourceIdentity`（类型）→ `Identity` | 同上 6 处 + `shared:265/271`（两个 label 函数签名）+ `shared:265` 的 `sourceLabelOf` 参数 | 逐处改名 |
| `sourceType` → `source` | `shared:224`（RawInputSchema）、`shared:235`（IngestRequestSchema）、`shared:419`（UncertainInputSchema）、`shared:506`（RecentRawItemSchema）、`shared:899`（PipelineRunSchema） | 逐处改名 |
| `sourceIdentity` → `identity` | 同上 5 处 | 逐处改名 |
| `sourceLabel`（保留键）→ `displayName` | `shared:216`（refine）、`shared:243/250/251/260`（normalizeSourceIdentity 四处）、`shared:266`（sourceLabelOf）、`shared:273`（displayNameWithDetails 的过滤） | 逐处改名 + **读路径兼容旧键**（FR-005） |
| `sourceLabelOf()` → `displayNameOf()` | `shared:265`（定义）、`shared:271`（sourceIdentityLabel 内）、`web/board/ItemBody.tsx`（引文旁标）、`server/application/notice.ts`、`server/storage/repo.ts`（8 处调用，含测试） | 逐处改名 |
| `sourceIdentityLabel()` → `displayNameWithDetails()` | `shared:271`（定义）、`web/board/ItemBody.tsx`（来源信息区）、`web/board/QuoteOverlay.tsx`、`web/UncertainReview.tsx`（6 处调用） | 逐处改名 |
| `normalizeSourceIdentity()` | `shared:246`（定义）、`server/storage/repo.ts:295`（rowToRawInput）、`repo.ts`（uncertain 读路径）等 5 处 | 改名保留 + **兼容旧键**（先试 `displayName`，再试 `sourceLabel`，再试 `name`） |
| `SearchRecentRawsArgsSchema` / `SearchRecentRawsResultSchema` / `RecentRawItemSchema` | `shared:496/502/512`、`server/agent0/tools.ts:125`（实现）、`server/agent0/digest.ts:565`（调用）、`server/agent0/prompt.ts:114/123`（提示词）、`server/test/digest.test.ts:915`（2 条测试） | **删除**（FR-018），由 `SearchRawsArgsSchema` / `SearchRawsResultSchema` 取代 |
| `PipelineRunSchema.sourceType` / `.sourceLabel` | `shared:899/900`、`server/storage/repo.ts:453`（构造）、`web/pipeline/PipelineView.tsx` | 改名（`source` / `displayName`） |
| 新增 `SearchRawsArgsSchema` / `SearchRawsResultSchema` | — | 新建（契约见 `contracts/search-raws.md`） |

### B. DB 层

| 变更 | 全部消费点 | 本轮同步动作 |
|---|---|---|
| `raw_inputs.source_type` → `source` | `server/storage/schema.ts:51`、`db.ts`（DDL）、`repo.ts`（rowToRawInput / insertRawInput / listRecentRawInputs / latestRawAtForSourceType） | 列改名（幂等）+ 全部读写点同步 |
| `raw_inputs.source_identity` → `identity_json` | `server/storage/schema.ts:52`、`repo.ts:284`（insert）、`repo.ts:295`（读）、`db.ts`（DDL） | 列改名 + 存量 JSON 键迁移（FR-006） |
| `uncertain_inputs.source_type` / `.source_identity` | `server/storage/schema.ts:92/93`、`repo.ts:838/851/868` | 同上 |
| 新增 `raw_inputs.tokens` / `.identity_tokens` | — | 新增 + 触发器同步 |
| 新增 FTS5 虚表 `raw_fts` | — | 新建 + insert/update/delete 三触发器（**先建后插**——实测踩坑） |
| `SCHEMA_VERSION` 4 → 6 | `server/storage/migrate.ts:19` | 升两级（改名 v5 / 索引 v6） |

### C. 应用层

| 变更 | 全部消费点 | 本轮同步动作 |
|---|---|---|
| `search_recent_raws` 工具 | `server/agent0/tools.ts:54`（TOOL_DEFS）、`:125`（实现）、`server/agent0/digest.ts:565`（runTool 分支）、`server/agent0/prompt.ts:114/123`（提示词两处）、`server/test/digest.test.ts:915`（2 条测试） | 删旧、加 `search_raws`（含新 TOOL_DEFS 描述） |
| `sameIdentity()` | `server/agent0/tools.ts:230`（定义）、`:128`（searchRecentRaws）、`:145`（searchUncertain）、`:243/244`（byProximity） | 改判据 = **除 `sender` 外的全部稳定键**（P-4 修复） |
| `listRecentRawInputs()` | `server/storage/repo.ts:352`（定义）、`tools.ts:126` | 改名/替换为 FTS5 查询路径（新 `search/query.ts`） |
| `byProximity()` | `server/agent0/tools.ts:236`（定义）、`:150`（searchUncertain） | 保留（search_uncertain 不动） |
| `buildUserBrief()` | `server/agent0/digest.ts:713` | 字段名同步（`来源身份`→新键名） |
| nc `groupName` | `server/sources/nc/types.ts:69`（BufferedEvent 字段）、`index.ts:230`（赋值）、`index.ts:307`（groupNameOf） | 改名 `displayName` |
| nc `dueGroups()` | `server/sources/nc/types.ts:92`（定义）、`index.ts:180`（runSweep 调用）、`server/test/nc.test.ts:128`（1 条测试） | 改判据：三闸任一命中 |
| nc `assembleBatch()` | `server/sources/nc/types.ts:147`（定义）、`index.ts:143`（sealGroup 调用）、`server/test/nc.test.ts`（6 条测试） | 字段名同步（`sender` 语义不变） |
| nc 设置项 | `server/sources/nc/index.ts:263`（settings()）、`packages/shared`（SettingFieldSchema） | 新增三闸的可配项；`windowMinutes` 语义变更（FR-031） |
| 提示词【检索面】段 | `server/agent0/prompt.ts:114` | 重写（FR-040） |
| 提示词【矛盾决断】段 | `server/agent0/prompt.ts:94` | 改弱（FR-041） |

### D. 前端（web）

| 变更 | 全部消费点 | 本轮同步动作 |
|---|---|---|
| `sourceIdentity` → `identity` | `web/board/ItemBody.tsx`（来源信息区、引文旁标）、`web/board/QuoteOverlay.tsx`、`web/UncertainReview.tsx`、`web/pipeline/PipelineView.tsx` | 逐处改名（**零业务逻辑变化**） |
| `sourceLabelOf` → `displayNameOf` | 同上 4 处 | 改名 |
| `sourceIdentityLabel` → `displayNameWithDetails` | 同上 3 处 | 改名 |
| `PipelineRun.sourceType` / `.sourceLabel` | `web/pipeline/PipelineView.tsx` | 改名 |
| `RawInput.sourceType` / `.sourceIdentity` | `web/board/ItemBody.tsx`、`web/board/QuoteOverlay.tsx`、`web/api.ts`（类型引用） | 改名 |

### E. 文档

| 文件 | 需改内容 |
|---|---|
| `docs/00-数据契约.md` | §十一 表结构（列名 + 保留键 `displayName` + 保留键改名说明 + FTS5 索引说明） |
| `docs/01-规格.md` | §4.3（检索面/工具）、§4.7（权威性判据改弱）、§4.10（工具表）、§5.3（RawInput 边界 + 索引列） |
| `docs/02-决策台账.md` | 新增 **D-127**（本特性的完整决策记录） |
| `docs/03-开放问题.md` | 记录本轮**不做**项：`search_items` 无上限返回、跨表按元素反查批次 |
| `docs/04-验收.md` | 新增本特性的验收清单（含真机走查项） |
| `docs/07-接新源检查单.md` | 「打包」节：封批三闸的新范式 + 新检索工具的形状无关性 |
| `docs/08-nc对接指南.md` | 封批三闸设置项 + **订正「崩溃丢 ≤3 分钟」的假承诺** |
| `CLAUDE.md` | 状态行 + 术语（信源/身份/显示名）+ 检索与封批的现状描述 |

### F. 测试（267 处旧名 + 新增）

| 文件 | 需改内容 |
|---|---|
| `apps/server/src/test/{board,chat,digest,media,pipeline,repo,sources,nc,isolation,gateway,mediaIngest,dashboard}.test.ts` | 旧名 → 新名（断言行为不变） |
| `apps/server/src/test/migration.test.ts` | 新增：存量 `{"sourceLabel":...}` → `{"displayName":...}`；旧键直读不崩；幂等重跑 |
| `apps/server/src/test/digest.test.ts` | 删 `search_recent_raws` 2 条测试；新增 `search_raws` 用例（并/交、模糊/精确、截断标注、参数越界报错） |
| `apps/server/src/test/nc.test.ts` | `dueGroups` 三闸各一条；`groupName` 改名同步 |
| `apps/web/src/test/{itemBody,pipelineView,uncertainReview}.test.tsx` | 旧名 → 新名 |

## 分批交付（每批可独立验证、可回滚）

| 批 | 内容 | 主要风险 | 回滚点 |
|---|---|---|---|
| **批 1** | 阶段 0（依赖 + `search/tokenize.ts`）+ 阶段 1（命名统一 + 迁移 v5） | **迁移**（主要风险；机制现成：自动备份 + 幂等 + 先例） | 提交后打 tag |
| **批 2** | 阶段 2（FTS5 索引 + 触发器，迁移 v6）+ 阶段 3（`search_raws` + 删旧工具） | 新表 + 触发器（顺序敏感） | 提交后打 tag |
| **批 3** | 阶段 4（nc 封批三闸 + 设置项 + docs/08 订正） | 低（纯适配器内） | 提交后打 tag |
| **批 4** | 阶段 5（提示词两段 + 文档同步 + 自审三问） | 低，但**改提示词 = 改行为** | 提交后打 tag |

**批 1 与批 2 的顺序不可换**：改名会动到 `RawInputSchema`，而索引列要挂在改名后的列上。

## 关键技术决策与实测依据

| 决策 | 依据（已实测） |
|---|---|
| FTS5 一个表同时支持模糊 + 精确 | `MATCH '高数'`（切词后）✅；`group_id = '10001'` ✅；两者 AND ✅；查询计划 `SCAN raw_fts VIRTUAL TABLE INDEX` ✅ |
| JSON 列可直接进 FTS5 | `MATCH '英语课群' / '10001' / 'sourceLabel'` 全命中 ✅（**上一轮说「JSON 不可索引」是错的**） |
| 身份须切词（不切则部分匹配失效） | 未切词的 JSON 列搜「课群」→ **0 命中**（「英语课群」内部子串搜不到）❌ → 必须做词袋 |
| 跨字段 OR 必须 UNION | 单条 `MATCH` 只能同列 OR；跨列 OR 用两条查询 UNION ✅ |
| `MATCH` 在 JOIN 里必须用表名 | 用别名 `f match ?` → `no such column` ❌ → 必须 `raw_fts match ?` |
| 外部内容表触发器必须先建后插 | 先插后建 → 索引空、`MATCH` 静默落空 ❌（实测踩坑） |
| nodejieba 而非 ICU 扩展 | ICU 需每部署环境带 `.so`（Docker/便携包/CI 三处）→ 运维负担；jieba 纯 npm ✅ 用户已拍板 |
| nodejieba 走源码编译 | 无 prebuilds（实测 `build/Release/nodejieba.node` 由 node-gyp 产出）→ 三处构建都要处理 |
| 2 字中文靠前缀匹配兜底 | jieba 把「高数」切成「高/数」→ `MATCH '高* 数*'` 仍命中 ✅ |
| 图片 URL 不进词袋 | 保留则搜「rkey」「multimedia」命中 QQ 图链接（纯噪音）❌ → 整体替换为「图片」 |
| 单次工具结果总量 2,000 字 | 实测 prompt 涨 5,000 token 时缓存命中率 95%→55% → 增量要小 |
| FTS5 保留字需转义 | `AND`/`OR`/`NOT`/`NEAR` 是语法 → 逐词加引号 |

## 部署三处（nodejieba）

| 处 | 做法 |
|---|---|
| **Docker** | 构建阶段装 `python3` / `make` / `g++`；`npm ci` 对 nodejieba **必须允许跑编译脚本**（现有 `--ignore-scripts` 是为 better-sqlite3 定的，需为 nodejieba 开口——或改用「宿主编好、镜像只拷 `.node`」） |
| **便携包** | `scripts/build-release.mjs` 加 nodejieba 精简拷贝（跟 better-sqlite3 / sharp 同款先例）：`package.json` + `build/Release/*.node` + 词典文件 |
| **CI** | windows runner 有 VS 工具链，可编；需确认 `--ignore-scripts` 不影响 |

## 验证计划

- **单元**：切词（图片占位/身份词袋/部分匹配/标点过滤/超长截断）；FTS5（AND/OR/UNION/json_extract/时间区间/前缀匹配）；迁移（键改名/兼容读/幂等）；工具（截断标注/more/参数越界报错）；封批（三闸各自触发/行协议保真不变/空批守卫不变）
- **集成**：`makeAgentTools` + 真实内存库跑通 `search_raws` 全维度；`digest` 走真实 `search_raws` 路径（删旧工具后提示词仍自洽）
- **质量门**：`npm run check` / `npm run check:dead` / `npm run build -w @summarizing/web` / `npm run build:release` / Docker 构建
- **自审三问**：改完了吗（跨文件一处不漏）/ 删干净了吗（`grep` 旧名零残留）/ 新特性做全了吗（每处引用真落地）
- **真机**：04 验收清单新增走查项（手机端封批表现、检索命中体感、并发消化与缓存命中率）
