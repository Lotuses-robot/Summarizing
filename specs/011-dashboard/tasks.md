# Tasks: 公开状态面板（/dashboard）

**Input**: Design documents from `/specs/011-dashboard/`

**Prerequisites**: plan.md (required), spec.md (required)

**Tests**: 要求测试（SC-006：`npm run check` 全绿；公开面白名单逐键断言）。

> **规模**：一刀可完成（单 commit 回滚点）。无新表、无迁移、无新依赖。
> 公开面 = 应用同域；页面自包含，不进 React 构建。

## Phase 0: 脏形态枚举（先于实现，一次修全）

- [ ] T001 库文件形态：**不存在**（新邀请/从未登录）→ 跳过且不计故障；**存在但空文件**（0 字节）/ **裸 SQLite 无表** → `failed++`；**旧 schema 缺 `llm_usage`/`media` 表**（停用账户未迁移）→ 缺表指标按 0（概念当时不存在），不算整库失败；**损坏字节 / 非 SQLite 文件** → `failed++`；**WAL 活动库**（运行中账户）→ 只读打开可读、不写、不 checkpoint
- [ ] T002 指标行形态：全空表（0 行）→ 0；`SUM(...)` 返回 NULL → 0；`cached_tokens` 全 NULL → `cached=null` 而非 0；混合 NULL/有值 → 只加非 NULL；`prompt < cached`（服务商怪异）→ 未命中夹到 0；`item_versions.snapshot` 的非法 JSON / 缺 `kind` / 缺 `status` → 视为畸形行并让该指标走「部分不可读」，绝不猜测归类
- [ ] T003 时间边界：今日 00:00 前一刻不算 today；北京墙钟跨天（机器时区无关）；重试的同一批 `digest_done` 出现多次只算 1（`count(DISTINCT entity_id)`）
- [ ] T004 公开面输入：任意 query / body / Cookie 一律忽略（无参数面）；`/dashboard` 与 `/api/dashboard` 都不要求登录；带坏的 `sid` 也照常返回；`trustProxy` 关闭时按直连 IP 限流
- [ ] T005 缓存/退化：首次聚合失败且无旧快照 → 503；有旧快照时刷新失败 → 旧快照 + `cached=true`；并发 20 请求只聚合一次（单飞）；60s 内重复请求 `cached=true`，61s 后重新聚合；`generatedAt` 保持上次成功时刻
- [ ] T006 排行：0 个账户 → 空数组；1 个 → 1 项；2 个 → 2 项；3+ 个 → 服务端截断为 2；并列按用户名升序（刷新不跳动）；**停用账户不上榜但历史仍计入总量**；坏库账户计 0 且不影响他人上榜；用户名含中文/数字/下划线原样显示、按文本渲染
- [ ] T007 版本号：CHANGELOG 无 `## [vX.Y.Z]` → `dev`；开发态（tsx/vitest 无构建注入）→ `dev`；构建产物注入 → 真实版本
- [ ] T008 磁盘/内存：`statfs` 失败 / 不支持 → `disk:null`（不显示 0）；剩余 0 → 正常显示 0 并标红

## Phase 1: Shared 契约与只读聚合

- [ ] T101 [P] `packages/shared/src/index.ts`：`DashboardTokenTotalsSchema`（`inputTokens` / `completionTokens` / `cachedTokens: number | null`）+ `DashboardSnapshotSchema`（L0 + L1 + tokens + tokenRanking + `degraded` / `generatedAt` / `cached`；**白名单，无任何内容/uid/路径字段**）
- [ ] T102 [P] `apps/server/src/shared/time.ts`：`beijingDayStart(now, daysBack = 0)`（今日/近 N 天起点的单一出处）；`routes/usage.ts` 改用它
- [ ] T103 `apps/server/src/shared/version.ts`：`appVersion()`（构建注入 `__APP_VERSION__`，缺省 `dev`）
- [ ] T104 新 `apps/server/src/storage/stats.ts`：`readUserDbStats(file, since)`——**只读打开**（`readonly:true, fileMustExist:true`，绝不 `openGatedDb`）；逐指标查询、单指标缺表按 0、其它错误抛出；返回 raw/queue/items/media/usage 聚合
- [ ] T105 同文件：`aggregateStats` 把 N 个库的统计合并（token 三数先加原始值再算未命中，跨库 `cached` 全 NULL 才是 null）

## Phase 2: 快照组装（缓存 / 单飞 / 限流）

- [ ] T201 新 `apps/server/src/application/dashboard.ts`：`getDashboardSnapshot({registry, dataRoot, now})`——账户遍历、只读聚合、排行（active、降序、并列名升序、`slice(0,2)`）、磁盘/内存/版本/运行时长
- [ ] T202 同文件：60s 缓存 + 单飞；刷新失败有旧快照则复用；限流器（每 IP 60 次/分，进程内固定窗口，键数有界）

## Phase 3: 路由、页面与构建注入

- [ ] T301 新 `apps/server/src/routes/dashboard.ts`：`GET /api/dashboard`（公开，JSON；`Cache-Control: public, max-age=30` + `X-Robots-Tag: noindex`）；`GET /dashboard`（自包含 HTML，inline CSS/JS，30s 轮询，失败显示「状态未知 + 上次成功时间」，数字用 `textContent`）
- [ ] T302 `apps/server/src/app.ts`：公开面注册（在受保护作用域之前）；`onSend` 的 `no-store` 放行 `/api/dashboard`
- [ ] T303 `apps/server/src/spaces.ts`：`SpaceHub` 暴露只读 `dataRoot`（实现回传构造参数）；更新测试里的假 hub
- [ ] T304 `scripts/build-server.mjs`：读 `CHANGELOG.md` 首个 `## [vX.Y.Z]` → `define.__APP_VERSION__`（便携包与 Docker 共用）
- [ ] T305 `apps/web/vite.config.ts`：`/dashboard` 也代理到 3001（dev 与生产同形）

## Phase 4: 测试与文档

- [ ] T401 [P] `apps/server/src/test/dashboard.test.ts`：公开可读（无 cookie / 坏 cookie）；**响应键集合与 schema 完全一致**、递归值类型白名单、响应体不含造进去的内容/来源名/uid
- [ ] T402 [P] 同文件：两账户聚合逐项断言（进站/消化/队列/事项/通知/回收站/图片/token 三数相加 = 总量）；排行榜截断/并列/停用/坏库；只读不改库（`user_version` 与表不变）
- [ ] T403 [P] 同文件：损坏库 → 200 + `degraded=true`；缓存 60s / 单飞 / 限流 61 次 → 429；页面 200 含 `noindex` 且不出现内容
- [ ] T404 [P] `apps/server/src/test/stats.test.ts`：Phase 0 的 T001–T002 矩阵（缺表按 0、空表、cached 混合、负差夹 0）
- [ ] T405 docs：01 规格新节（公开面边界）、02 台账（D-112 决策）、03 开放问题登记、04 验收、CHANGELOG v0.5.0、CLAUDE.md 路由与能力、docs/13 运维（可选）
- [ ] T406 `npm run check` + `npm run check:dead` + 真实入口 curl 冒烟
