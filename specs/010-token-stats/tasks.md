# Tasks: Token 用量统计

**Input**: Design documents from `/specs/010-token-stats/`

**Prerequisites**: plan.md (required), spec.md (required)

**Tests**: 要求测试（SC-004：`npm run check` 全绿、真实入口断言界面数字）。

> **规模**：一刀可完成（单 commit 回滚点）。**010 先落地**，占 `SCHEMA_VERSION` 2→3；
> 随后的 009 再 3→4。两特性顺序做，不合并迁移。

## Phase 0: 脏形态枚举（先于实现，一次修全）

- [x] T001 usage 整段缺失 / null；`prompt_tokens` / `completion_tokens` 缺失 → 不落行；**0 是合法值**；负数 / 小数 / 字符串 → 整条判废
- [x] T002 `prompt_tokens_details` 缺失 / `cached_tokens` 缺失 / **0（合法）** / 负数；服务商兼容字段 `prompt_cache_hit_tokens` 有 / 无；两者都有时**标准字段优先**
- [x] T003 model 为空串 / 超长；调用失败路径（异常时不落行）；「测试连接」探针不计入
- [x] T004 range 参数非法值 / 缺席（默认 7d）；**日历日边界**：今日 00:00 前一刻不算 today；跨天；墙钟字符串序 = 时间序

## Phase 1: 采集与存储

- [x] T101 [P] `packages/shared/src/index.ts`：`UsageRange`（today|7d|30d）、`UsageSummarySchema`（`inputTokens`（未命中） / `completionTokens` / `cachedTokens: number | null` / `callCount`）
- [x] T102 `apps/server/src/storage/schema.ts`：`llm_usage` 表（id/at/actor/model/prompt/completion/cached + at 索引）
- [x] T103 `apps/server/src/storage/db.ts` + `migrate.ts`：建表 DDL；`SCHEMA_VERSION` **2 → 3**
- [x] T104 `apps/server/src/storage/repo.ts`：`insertLlmUsage`（存原始值）/ `sumLlmUsage(db, sinceWallClock)`（**未命中 = Σ(prompt − cached)**；cached 全 NULL → null；混合时只加非 NULL 值——诚实口径；返回 `inputTokens` / `completionTokens` / `cachedTokens` / `callCount`）
- [x] T105 `apps/server/src/shared/llm.ts`：`LlmClient.chat` 返回增 `usage`（**zod 解析** `res.usage`，不用类型断言：非负整数校验，0 合法；`prompt_tokens_details.cached_tokens` 优先、兼容 `prompt_cache_hit_tokens`；形状不符 → null + stderr 留痕）
- [x] T106 每次成功调用后落行（actor=agent0，model=modelTag）——收敛在 `apps/server/src/shared/usage.ts` 的 `recordUsage`，`agent0/digest.ts` 与 `agent0/sweep.ts` 调用
- [x] T107 `apps/server/src/application/chat.ts`：同上（actor=chat）。**「测试连接」探针（routes/settings.ts）不接记录点**
- [x] T108 测试 FakeLlm（`apps/server/src/test/`）：可选注入 usage，不影响既有用例

## Phase 2: 接口与界面

- [x] T201 新 `apps/server/src/routes/usage.ts`：`GET /api/usage?range=`（认证作用域内；range 非法 → **400**（沿用 safeParse 写法，不让 zod 抛成 500）；范围起点 = **北京墙钟日历日**：today 今日 00:00 起、7d/30d 含今日的 N 个日历日）
- [x] T202 `apps/server/src/app.ts`：注册路由
- [x] T203 `apps/web/src/api.ts`：`usage(range)`
- [x] T204 `apps/web/src/components/ActivityBar.tsx`：左下角组（账户/设置/关于旁）加「用量」按钮（lucide `ChartColumn`），props 增 `onOpenUsage`
- [x] T205 新 `apps/web/src/components/UsageModal.tsx`：三枚大号数字（**未命中输入** / 输出 / 缓存命中）+ 今日/7天/30天切换（默认 7 天）；cached=null 显示「服务商未提供」；Esc 分层（pushEscLayer）；数字千分位
- [x] T206 `apps/web/src/App.tsx`：接线开关

## Phase 3: 测试与文档

- [x] T301 [P] `apps/server/src/test/usage.test.ts`：T001–T004 脏形态全矩阵（真实 HTTP 入口）
- [x] T302 [P] `apps/server/src/test/usage.test.ts`：digest/chat 落行断言（次数 × usage 累加）；`usage=null` 不落行；失败不落行；**未命中口径**（prompt=1000/cached=800 → input=200，三者相加 = 总消耗）
- [x] T303 [P] `apps/web/src/test/usage.test.tsx`：三数字渲染 / cached null 文案 / 范围切换 / 空态 / 加载失败可见
- [x] T304 docs：01 规格新节；02 台账 D-11x；00 契约 `llm_usage`；04 验收
- [x] T305 CHANGELOG v0.5.0 + `npm run check` + `check:dead`
