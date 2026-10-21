# Feature Specification: 公开状态面板（/dashboard）

**Feature Branch**: `011-dashboard`

**Created**: 2026-10-21

**Status**: Draft（待批准）

**Input**: 用户 2026-10-21：「在 /dashboard 下加个监控，目前不做审核，所以计划一下可以展示多少内容出去」。
拍板（2026-10-21）：**完全公开（无登录）**、**只展示 L0 + L1**、先出 spec/plan 再动手。

> **「不做审核」的含义**：不存在人工把关这一环。因此所有展示项必须**按构造安全**——
> 只允许数字、枚举、时间与版本号；任何可能含用户内容的字段一律不上（不是「先上再审」）。

## User Scenarios & Testing

### User Story 1 - 任何人打开就能看到服务在不在 (Priority: P1)

访问 `https://<站点>/dashboard`（无需登录、无需令牌），一眼看到：服务运行中、版本、已运行多久、
内存与数据盘剩余、以及各库能否打开。页面每 60 秒自动刷新。

**Why this priority**：这是「监控」的最小价值——出问题时先确认「服务活着」。

**Independent Test**：未登录浏览器打开 `/dashboard` → 显示「运行中 · vX.Y.Z · 已运行 N 天」与磁盘/内存两条；
停掉服务 → 页面显示「状态未知」而不是假数据。

**Acceptance Scenarios**：

1. **Given** 服务在跑，**When** 打开 `/dashboard`，**Then** 首屏 1 秒内出现状态卡与数字，不出现任何事项/原文/来源名。
2. **Given** 服务停掉或接口失败，**When** 页面轮询，**Then** 状态卡变「状态未知」并显示上次成功时间（不编造 up）。
3. **Given** 某个账户库损坏，**When** 打开页面，**Then** 仍能显示其它数字，并有一枚「部分数据不可读」提示。

### User Story 2 - 数字能说明「在干活、没爆」 (Priority: P1)

页面展示聚合计数：账户数、今日进站批次、今日模型调用、**流过的 token（今日 / 累计，三个互不重叠的数）**、当前排队/消化中、未处理批次、
事项/通知/回收站条数、图片张数与占用。

**Why this priority**：只有健康灯不够，还要知道「今天有没有在收、队列有没有堆积、盘有没有被图片吃满」。

**Independent Test**：跑一条进站 → 刷新页面 → 「今日进站」+1；上传一张图 → 「图片张数/占用」增加。

**Acceptance Scenarios**：

1. **Given** 今天进了 3 条、完成 2 条、1 条卡在队列，**When** 看页面，**Then** 今日进站 3 / 今日完成 2 / 队列 1 分别正确（重试过的同一批不重复计数）。
2. **Given** 今天调用过模型，**When** 看页面，**Then** 「流过 token」显示今日与累计两组数（未命中输入 / 输出 / 缓存命中），未命中 + 输出 + 缓存 = 总量；服务商从不返回缓存字段时显示「—」。
3. **Given** 两个账户各有事项，**When** 看页面，**Then** 只显示合计（不出现任何按账户拆分）。
4. **Given** 数据盘剩余低于 10%，**When** 看页面，**Then** 磁盘条变红并写明「剩余不足」。

### User Story 3 - 隐私边界可验证 (Priority: P2)

任何人都能用 `curl /api/dashboard` 看到同样的东西，因此**响应字段是白名单**：
只有固定的数字/时间/版本字段；不含任何自由文本、账户标识、令牌、内容或错误细节。
有一条自动化测试**逐键断言**响应形状（新增字段必须显式过这关）。

**Why this priority**：公开面无认证，安全只能靠「少说」。

**Independent Test**：`curl -s /api/dashboard | jq 'keys'` 与 schema 完全一致；
grep 响应体，不存在任何事项标题/群名/用户名。

### User Story 4 - 谁用得最多：token 排行 (Priority: P2)

页面底部有一个**用户 token 排行**：按**累计流过的 token 总量**（未命中输入 + 输出 + 缓存命中）从高到低，
**只展示前两名**（启用中账户）。用户 2026-10-21 定：累计口径、只暴露前两名；同日走查后追加：**名字只露前两个字 +「…」**（输出层截断，服务端做）。

**Why this priority**：多人实例里，「谁在用、用了多少」是运维与朋友间最直观的一眼信息。

**Independent Test**：两个账户各有用量 → 页面排行按总量降序、名字正确；把其中一个停用 → 从榜单消失。

**Acceptance Scenarios**：

1. **Given** A 累计 12 万、B 累计 3 千、C 累计 1 千，**When** 看排行，**Then** 只出现 A 与 B（C 不出现），A 在上、数字与累计 token 一致。
2. **Given** A 与 B 同量并列，**When** 排序，**Then** 按用户名稳定排序（刷新不跳动）；第三名同量也不会被挤进来。
3. **Given** 一个账户被停用，**When** 看排行，**Then** 它不在榜上（但它的历史仍计入全站总量）。
4. **Given** 用户名含中文/数字/下划线，**When** 渲染，**Then** 原样显示、不解释为 HTML。

### Edge Cases

- **库不存在**（新邀请、从未登录的账户）→ 跳过该库，不计入故障。
- **库损坏 / 打不开 / 查询失败** → 该库跳过并计入 `databases.failed`，整体仍返回 200；页面显示「部分数据不可读」。
- **服务重启** → 运行时长从新进程起算；所有计数从库重新聚合（不依赖内存计数，不出现「重启后归零」）。
- **缓存期内数据变化** → 最多滞后 60 秒；响应带 `generatedAt` 与 `cached`，页面显示「数据时间」。
- **并发请求** → 同一时刻只允许一次聚合（单飞），其余请求等待同一结果。
- **磁盘信息不可用**（statfs 失败）→ `disk: null`，页面显示「未知」，不当作 0。
- **时区** → 「今日」= 北京墙钟日历日（D-97），与用量统计同口径。
- **搜索爬虫** → 页面 `noindex` + `X-Robots-Tag`，避免被索引。

## Requirements

### Functional Requirements

- **FR-001**: 系统 MUST 提供 `GET /api/dashboard`，**注册在公开面**（无认证、无 Cookie、无参数）；响应形状由 shared 的 `DashboardSnapshotSchema` 单一出处定义。
- **FR-002**: 快照 MUST 只含以下字段（L0 + L1）：
  - **L0**：`version`、`startedAt`、`now`、`uptimeSec`、`memory.rssBytes`、`disk { freeBytes, totalBytes } | null`、`databases { total, opened, failed }`、`degraded`
  - **L1**：`accounts { total, active }`、`today { rawBatches, digested, digestFailed, llmCalls }`、`queue { pending, digesting }`、`failedRawInputs`、`items { tasks, notices, trashed }`、`media { count, bytes }`
  - **tokens**（用户 2026-10-21 追加：复用 010 的用量数据）：`tokens.today` 与 `tokens.total`，各含 `{ input, completion, cached }` 三个**互不重叠**的数（`input` = prompt − cached 的未命中部分）；
    `cached` 为 `null` ⇔ 该范围内**所有账户的所有调用**都没有缓存字段（与 010 的「服务商未提供」同义）。
  - **tokenRanking**（用户 2026-10-21 追加）：`[{ name, tokens }]`，`tokens` = 该账户累计 `input + completion + cached`；`name` = 原用户名**前两个字 +「…」**（两字以内原样）；按 `tokens` 降序、并列按**原用户名**升序；只含**启用中**账户；**最多两项**（服务端截断，不靠前端隐藏）；**不含 uid**。
  - **元**：`generatedAt`、`cached`
- **FR-003**: 聚合口径 MUST 为：
  - `today` 起点 = 北京墙钟今日 00:00（D-97）；`rawBatches` 按 `raw_inputs.received_at`、`llmCalls` 按 `llm_usage.at`；`digested` / `digestFailed` = 今日 `pipeline_events` 里 `digest_done` / `digest_failed` 的**去重批次数**（`count(DISTINCT entity_id)`——重试的同一批只算一次）；`tokens.today` 同起点，`tokens.total` 不限起点。
  - `queue` 按 `raw_inputs.digest_state` 的 pending / digesting 计数；`failedRawInputs` = failed 总数。
  - `items.tasks / notices / trashed` 按**每条链最后一个版本**的 `kind`/`status` 归类（status=trashed 单列，不计入 tasks/notices）。
  - `media` = `count(*)` 与 `Σ size_bytes`。
  - `tokens` = `Σ(prompt − (cached ?? 0))` / `Σ completion` / `Σ cached`（原始值存库，未命中在聚合时算，与 010 同口径）。
  - `tokenRanking` 逐账户取 `llm_usage` 全表的同样三项求和再相加；账户名取自系统库 `accounts.username`；排序后 **`slice(0, 2)`**。
- **FR-004**: 读取用户库 MUST 使用**只读连接**（`readonly: true`）——绝不触发迁移、建表或任何写；单库失败只标记不抛。
- **FR-005**: 聚合 MUST 有 60 秒进程内缓存 + 单飞；响应头 `Cache-Control: public, max-age=30`；快照带 `generatedAt`/`cached`。
- **FR-006**: `GET /dashboard` MUST 返回一个**自包含**页面（无外链 CSS/JS/字体），每 60 秒轮询 `/api/dashboard`；请求失败时显示「状态未知 + 上次成功时间」，不得把旧数据当新数据。
- **FR-007**: 公开接口 MUST 限流（每 IP 60 次/分，进程内令牌桶）；超限回 429，不带任何内部信息。
- **FR-008**: `version` MUST 取自 `CHANGELOG.md` 的当前版本（构建时注入，单一出处）；开发态回退 `dev`。
- **FR-009**: 响应 MUST NOT 出现：事项/通知的任何文本、原文、引文、来源名、uid、令牌、文件路径、SQL/异常详情、单账户维度的任何数字。
  **唯一例外（用户 2026-10-21 明示）**：`tokenRanking` 的**前两名**（用户名只露前两个字）与累计 token 数——那是公开榜单本身；
  其余账户的名字与用量一律不出现在响应里（截断在服务端做）。
- **FR-010**: 页面与接口 MUST 标注 `noindex`。

## Key Entities

- **DashboardSnapshot**：一次聚合的只读快照（L0 + L1 + 元信息）。无持久化，无新表。

## Success Criteria

- **SC-001**: 未登录 `curl /api/dashboard` 返回 200，字段与 schema 完全一致；响应体中不存在任何用户内容。
- **SC-002**: 两个账户的数据能正确汇总（计数与求和逐项可断言）；**排行榜最多两项、按累计 token 降序、并列按名字稳定排序、不含 uid**。
- **SC-003**: 一个损坏的用户库不会拖垮整体：仍 200，`databases.failed ≥ 1`、`degraded=true`；坏库账户不从榜单消失以外的数字里抹掉（其贡献计 0，页面标明数据不全）。
- **SC-004**: 60 秒内重复请求不重复打库（缓存命中可见 `cached=true`）。
- **SC-005**: 页面在无 JS 资源外链的前提下可用，失败态不编造「up」。
- **SC-006**: `npm run check` 全绿。

## Assumptions

- 部署形态：同域反代（Caddy）后 `/dashboard` 与应用同源；无需改 Caddy 配置。
- 规模：个人/小圈子（≤10 账户），每账户库的计数查询在毫秒级；60 秒缓存足够。
- 公开即在互联网可见：接受「服务是否在线、总量多少」被任何人看到；**不接受**任何可定位到个人或内容的信息。
