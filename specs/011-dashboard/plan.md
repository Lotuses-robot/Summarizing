# Implementation Plan: 公开状态面板（/dashboard）

**Branch**: `011-dashboard` | **Date**: 2026-10-21 | **Spec**: [spec.md](./spec.md)

## Summary

在应用同域下加一个**完全公开、无登录**的 `/dashboard`：一个自包含 HTML 页面 + `GET /api/dashboard` 快照接口。
只展示 **L0（服务健康/资源）+ L1（聚合计数，含 010 的 token 用量：今日 / 累计，三个互不重叠的数）**
外加一个**累计 token 排行**（用户 2026-10-21 追加：按累计总量降序、**只展示前两名**（名字只露前两个字））。
快照由服务端**只读**打开各账户库聚合，60 秒进程内缓存 + 单飞；任何库读不了只降级、不报错；响应是
**固定白名单 schema**（除排行榜的用户名外没有自由文本，没有 uid，没有内容列）。

> 用户拍板（2026-10-21）：完全公开、L0+L1、先 spec/plan；追加：「数据源可以加个流过的 tokens」「对所有用户做个流过 token 数排行」（累计口径）。

## Technical Context

**Language/Version**: TypeScript / Node 22+
**Primary Dependencies**: 无新增（better-sqlite3 已有；`node:fs.statfs` 自带）
**Storage**: **无新表、无迁移**。聚合只读各账户库（`data/users/<uid>.db`）+ 系统库（`system.db`）
**Testing**: Vitest（服务端真实入口 `makeTestRealm` / `inject`）
**Constraints**: 公开面零认证；绝不 select 内容列；只读打开（不触发迁移/建表）；60s 缓存

## Constitution Check

- ✅ **不静默**：库读不了 → `databases.failed` + `degraded=true`，页面有可见提示；页面请求失败显示「状态未知」，不把旧数据当新数据。
- ✅ **可见性**：数字全部来自库的真实聚合（重启不从零开始）。
- ✅ **无新依赖、无新表、无迁移**。
- ✅ **模块受控**：一个 shared schema + 一个聚合模块 + 一个路由文件；页面服务端直出，不进 React 主包。
- ✅ **公开面最小化**：只有 L0/L1 白名单，测试逐键断言。

## Project Structure

```text
packages/shared/src/index.ts              # DashboardSnapshotSchema（白名单，单一出处）
apps/server/src/shared/version.ts         # appVersion()：构建注入 __APP_VERSION__，开发态回退 "dev"
apps/server/src/storage/stats.ts          # 只读聚合（raw/queue/items/media/tokens），SQL 只在存储层
apps/server/src/application/dashboard.ts  # 快照组装 + 60s 缓存 + 单飞 + 限流
apps/server/src/routes/dashboard.ts       # GET /api/dashboard（公开 JSON）+ GET /dashboard（HTML）
apps/server/src/app.ts                    # 公开面注册（在受保护作用域与静态兜底之前）
apps/server/src/spaces.ts                 # SpaceHub 暴露 dataRoot（聚合需要路径）
scripts/build-server.mjs                  # define __APP_VERSION__（读 CHANGELOG 首个版本号）
```

## 聚合口径（与 010 共用同一套语义）

单个用户库的只读查询（`storage/stats.ts`，prepared statements）：

| 指标 | SQL 要点 |
|---|---|
| 今日进站 | `count(*) FROM raw_inputs WHERE received_at >= ?`（北京墙钟今日 00:00） |
| 今日完成/失败 | `count(DISTINCT entity_id) FROM pipeline_events WHERE action=digest_done|digest_failed AND at >= ?`（重试同批只算一次） |
| 队列 | `SELECT digest_state, count(*) FROM raw_inputs GROUP BY digest_state` → pending / digesting / failed |
| 事项/通知/回收站 | 取每条链**最后一个版本**：`WITH last AS (SELECT item_id, max(rowid) r FROM item_versions GROUP BY item_id) SELECT json_extract(snapshot,'$.kind'), json_extract(snapshot,'$.status'), count(*) … GROUP BY 1,2`；`status=trashed` 单列 |
| 图片 | `SELECT count(*), coalesce(sum(size_bytes),0) FROM media` |
| token | `SELECT sum(prompt - coalesce(cached,0)), sum(completion), sum(cached), count(cached) FROM llm_usage [WHERE at >= ?]`；跨账户 `cached` 为 null ⇔ `Σcount(cached)=0`；**表为空属正常**（还没产生调用）→ 返回 0，页面显示「暂无用量」 |
| 排行 | 逐账户 token 三项求和相加（全表，不限时间）；账户名从系统库 `accounts`（`listAccounts`）取；只列 active，`tokens` 降序、并列按 `name` 升序；**服务端 `slice(0, 2)`** |

- **只读连接**：`new Database(file, { readonly: true, fileMustExist: true })`——**绝不用 `openGatedDb`**（它会跑 DDL/迁移）。
- 库文件不存在（新邀请、未登录）→ 跳过，不算失败；存在但打不开/查询抛错 → `failed++`。
- 聚合完立即关连接；整个过程不写任何库。

## 缓存与限流

- 进程内 `snapshot`：TTL 60s；`inflight` 单飞（并发请求共享同一次计算）。
- 刷新失败：有旧快照 → 返回旧快照 + `cached=true` + `degraded=true`；从未成功 → 503 `{ error: "状态暂不可用" }`。
- 响应头：`Cache-Control: public, max-age=30`、`X-Robots-Tag: noindex`。
- 限流：每 IP 60 次/分（进程内滑动窗口），超限 429；不做重试提示。

## 页面

- `GET /dashboard` 返回**自包含** HTML（inline CSS/JS，无外链、无 CDN），`<meta name="robots" content="noindex">`。
- 亮/暗跟随 `prefers-color-scheme`；移动端单列。
- 每 60 秒 `fetch('/api/dashboard')`；失败 → 状态卡变「状态未知」+ 显示上次成功时间；数字区保留但标注「旧数据」。
- 版式：大标题「运行中 · v0.5.0 · 已运行 N 天」；一排数字（今日进站 / 已消化 / 队列 / 未处理）；token 两块（今日 / 累计：未命中输入 · 输出 · 缓存命中）；事项/通知/回收站；图片张数/占用；**累计 token 前两名（前两字 + 数字条）**；底部内存/磁盘两条 + 数据时间。
- 排行榜渲染**一律用 `textContent`**（不做 HTML 拼接）。用户名虽已被 `UsernameSchema` 限制为字母/数字/下划线/连字符，仍按不可信数据处理。
- 任何 `null`（缓存字段缺失、磁盘不可用）显示「—」，不显示 0。

## 版本号（单一出处）

- `scripts/build-server.mjs` 读 `CHANGELOG.md` 第一个 `## [vX.Y.Z]`，`define: { __APP_VERSION__: '"X.Y.Z"' }`——便携包与 Docker 共用这条线。
- `shared/version.ts`：`typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"`（开发态 tsx 不注入）。
- 与 About 弹层同源（都来自 CHANGELOG），不引入 package.json version。

## 影响面清单（必填）

| 变更的符号/值 | 全部消费点 | 本轮同步动作 |
|---|---|---|
| `SpaceHub` 增 `dataRoot` | `makeSpaceHub` / `makeApp`（间接）/ 测试 `makeTestRealm` | 接口加只读字段；实现里回传构造参数 |
| `app.ts` 公开面注册 | 受保护作用域 / webhook 网关 / 静态兜底 | 在 scope 与 `setNotFoundHandler` 之前注册 `/api/dashboard` 与 `/dashboard`，真实路由优先于 SPA 兜底 |
| 新增 `DashboardSnapshotSchema` | 路由 / 页面 JS / 测试 | shared 单一出处；测试逐键断言，新增字段必须显式过审 |
| `__APP_VERSION__` 构建注入 | `build-server.mjs` / esbuild 产物 / dev | 新增 define；`scripts/build-server.mjs` 读 CHANGELOG |
| 文档 | `docs/01`（新节）/`docs/03`（登记）/`docs/04`（验收）/`CHANGELOG`/`README`（可选）/`CLAUDE.md`（路由与能力） | 随实现同批更新 |

## Testing

服务端（真实入口，`makeTestRealm`）：

1. **公开可读**：未登录 `inject GET /api/dashboard` → 200；无 cookie 也通。
2. **白名单**：响应键集合与 schema **完全一致**（多一个键即失败）；递归断言值只有 number/string/null/boolean。
3. **聚合正确**：两个账户各造事项/通知/回收站/图片/用量 → 计数与求和逐项断言；token 三数「输入+输出+缓存 = 总量」。
4. **只读不改库**：裸 SQLite 文件（无表）→ 聚合返回 `failed≥1`，且 `sqlite_master` 仍为空、`user_version` 不变。
5. **损坏库降级**：写坏一个用户库文件 → 200 + `degraded=true`，其它账户数字仍正确。
6. **缓存**：连续两次请求，第二次 `cached=true`；注入时钟推进 61s 后重新聚合。
7. **页面**：`GET /dashboard` 200、含 `noindex`、HTML 中不出现任何造进去的事项标题/来源名。
8. **限流**：同一 IP 61 次 → 429。
9. **排行**：三个账户（12 万 / 3 千 / 1 千）→ 响应与页面都**只有前两名**；并列按名字；停用账户不在榜；响应中无 uid；坏库账户计 0 且榜单仍返回。

前端：无 React 改动；页面逻辑由服务端模板 + 内联脚本承担，不作为 web 构建产物。

## 风险与取舍

- **公开聚合暴露活跃度**：L1 只给总量，不给单账户拆分；**唯一例外是排行榜前两名**（用户 2026-10-21 明示：累计 token 前两名公网可见，名字只露前两字）——取舍已收窄到「只露两人」，其余账户不出响应。「最近活动时间/直方图」属 L2，未做。
- **只读打开 WAL 库**：需要 `-wal`/`-shm` 可读（同用户同进程，无问题）；不 checkpoint、不写。
- **首请求延迟**：冷启动第一次聚合要开 N 个库；个人规模毫秒级，可接受。
- **`fs.statfs` 平台差异**：失败即 `disk: null`，页面显示「—」。
- **爬虫/扫描**：`noindex` + 限流；不做 robots.txt 全局改动。

## 交付顺序

1. shared schema + `storage/stats.ts`（含只读打开）
2. `application/dashboard.ts`（聚合、缓存、单飞、限流）
3. 路由与页面（公开面注册）+ 版本注入
4. 测试 + 文档（01 新节 / 03 登记 / 04 验收 / CHANGELOG）
