# Tasks: 多用户（单实例多账户）

**Input**: Design documents from `/specs/006-multi-user/`

**Prerequisites**: plan.md · spec.md · research.md（R1–R12）· data-model.md · contracts/{http,cli}.md · quickstart.md

**Tests**: 全含——本仓宪法 V（真实入口断言）+ SC-001…005 均为测试化验收；测试走真实认证链（真 cookie，不设后门）。

**Organization**: 按用户故事分阶段，US1 = MVP。单人开发（main 直改），[P] 主要给后续并行代理用。

**大改暂红先例**: 源契约 + makeApp 重构是跨文件签名变更，中间态允许 tsc 暂红（先例 `f73450d`「契约八件套定稿（tsc 暂红符合预期）」）——须在 commit message 注明并在紧接着的提交收绿。

## Phase 0: 影响面与脏形态（必填——宪法「边界加固三规矩」）

- [ ] T000 [P] 对 plan.md 影响面清单逐符号跑 `codegraph explore "<符号名>"` 复核消费点（makeApp / registerSources / startSources / SourceAdapter.register / app.sourceStates / allSourceAdapters / data 路径 / webhook URL），遗漏并入 plan.md 影响面清单
- [ ] T001 [P] 按 data-model「校验规则」预告表展开六口脏形态枚举（username / password / 邀请码 / token / sid cookie / 注册登录体）→ 本档**附录 A** 已给出蓝本；把蓝本逐格落成测试用例清单（先写脏输入测试、预期 FAIL，再写实现）

## Phase 1: Setup

- [ ] T002 [P] docs/00-数据契约.md：新增系统库契约节（accounts/invites/meta 三表 + data/users/<uid>.db 布局 + system.db 孤岛警示）
- [ ] T003 [P] docs/01-规格.md：新增认证/会话/隔离/运维命令/信源 token 行为节（与 contracts/http.md、cli.md 对齐）
- [ ] T004 [P] docs/07-接新源检查单.md（register 契约改 SourceRouter + 网关）+ docs/08-nc对接指南.md（新 URL `/hook/<token>/nc/event` + 令牌获取/轮换）+ docs/09-信源可行性测试计划.md（nc 测试 URL 同步）
- [ ] T005 [P] docs/02-决策台账.md（本批 D 编号 + L25「账户删除」延后）+ docs/03-开放问题.md（记录项）+ docs/11-上云与发布.md（argon2→scrypt 措辞 + R12 部署注意清单落条目）
- [ ] T006 文档先行 commit：T002–T005 四份文档 + specs/006 全套 + .gitignore 整理（此前会话已改）+ `.codegraph/.gitignore` 摘除（已 staged）——先文档后代码，commit message 按仓格式
- [ ] T007 [P] 安装 `@fastify/cookie`（`npm i @fastify/cookie -w apps/server`）——本批唯一新增依赖

## Phase 2: Foundational（阻塞全部故事）

- [ ] T008 [P] shared：Auth 契约 schema 入 `packages/shared/src/index.ts`（RegisterRequest / LoginRequest / ChangePasswordRequest / MeView{username, sourceToken} / RotateTokenResponse；username=NFKC 归一+trim 后 2~20 字符 `\p{L}\p{N}_-`；password ≥8 ≤200）
- [ ] T009 [P] `apps/server/src/storage/registry.ts`：makeRegistryDb（幂等 DDL，三表字段照 data-model 逐列）+ repo（createAccount / findByUsername / findByUid / findByToken / listAccounts / setStatus / setPasswordHashAndBumpTv / setSourceToken / createInvite / redeemInvite〔单条 UPDATE `WHERE code=? AND used_by IS NULL AND expires_at > ?` 看行数〕/ revokeInvite / getMeta / setMeta〔session_secret 32B hex 首建生成〕）
- [ ] T010 [P] `apps/server/src/auth/password.ts`：scrypt（N=2^15,r=8,p=1,keylen=64,salt=16B,maxmem=64MiB，异步）+ 自描述格式 `scrypt$N,r,p$salt$hash` + `timingSafeEqual` 比对 + 用户名不存在时的哑哈希
- [ ] T011 `apps/server/src/auth/session.ts`：载荷 `{v:1,uid,tv,exp}` HMAC-SHA256 签名/验签（`timingSafeEqual`）+ cookie 读写（`sid`；httpOnly+SameSite=Lax+Path=/；Secure 由 env `SESSION_COOKIE_SECURE` 默认 "1"；30 天，剩 <15 天随响应续签）+ makeSessionAuth preHandler（六态判定与日志分级照 contracts 失败矩阵；`request.space` module augmentation）（依赖 T009 读接口）
- [ ] T012 [P] `apps/server/src/auth/limits.ts`：进程内滑窗——登录按（username,来源IP）5 次失败锁 15 分钟、注册按 IP 10 次/10 分钟；锁定期 429 + `retryAfterSec`
- [ ] T013 [P] `apps/server/src/sources/types.ts`：`SourceRouter { post(path,handler); get(path,handler) }` 窄口 + `register(ctx, router)` 签名变更（头注说明收窄理由：listen 后不可注册路由 + 鉴权收权）
- [ ] T014 `apps/server/src/sources/host.ts`：makeSourceContext / registerSources / startSources 自 app.ts 迁入，按空间参数化（`SpaceDeps{db,llmRef,tools,sourceStates,webhookRoutes}`）（依赖 T013）
- [ ] T015 [P] `apps/server/src/sources/registry.ts`：单例实例数组 → 工厂列表（`allSourceAdapters(): Array<() => SourceAdapter>`）
- [ ] T016 `apps/server/src/sources/nc/index.ts`：`app.post("/api/sources/nc/event",…)` → `router.post("/event",…)`（其余逻辑不动）（依赖 T013）
- [ ] T017 `apps/server/src/spaces.ts`：Space（db 经 makeDb + sweepOrphanPending；llmRef=readStoredAi(db) 否则 .env；tools；sourceStates；webhookRoutes；adapters） + SpaceHub（ensure 并发去重 promise map / byToken / ensureAll 只遍历 **active** / closeAll 10s 隔离）
- [ ] T018 `apps/server/src/app.ts`：makeApp({registry, hub})——注册 `@fastify/cookie` 插件 + `trustProxy`（读 env `TRUST_PROXY`，部署防 XFF 伪造）——公开面（auth 路由点 + 网关 `app.route({method:["GET","POST","PUT","DELETE"], url:"/hook/:token/:source/*"})`：token→space→(method,相对路径)→处理器；401 零落库 / 404 / 未登记路径 404）+ 受保护封装作用域（作用域级 preHandler；items/board/chat/ingest/raw-retry/settings/sources/uncertain 全进）+ **URL 日志脱敏**（req 序列化器：`/hook/<token>` → `/hook/***`）+ **基础安全头**（nosniff / Referrer-Policy: same-origin / X-Frame-Options: DENY / API `Cache-Control: no-store`）（依赖 T014/T016/T017）
- [ ] T019 `apps/server/src/routes/{items,pipeline,settings,sources,uncertain}.ts`：`deps.db`→`req.space.db`（llmRef/sourceStates 同改；`GET /api/backup` 语义=当前账户库）（依赖 T018）
- [ ] T020 `apps/server/src/index.ts`：装配 registry→hub→app；启动 `hub.ensureAll()`；SIGINT → gracefulClose(app) 后 hub.closeAll()（10s 隔离沿用）；`.env.example` 注释补 `TRUST_PROXY` / `SESSION_COOKIE_SECURE`
- [ ] T021 `apps/server/src/test/helpers/app.ts`：`makeTestAccount()`——临时 registry+空间+已登录 cookie，返回 `{app, db, cookie, inject}`（inject 自动带 cookie；断走真实认证链）
- [ ] T022 既有测试装配迁移：8 个文件（board/chat/digest/nc/pipeline/settings/sources/uncertain）~80 处 inject 收编到 T021 helper + makeApp 构造点全部改写；`npm run check` 收绿（依赖 T021）
- [ ] **Checkpoint**: 基线绿 + 单机等价（现全部功能行为不变，FR-007）

---

## Phase 3: User Story 1 - 注册、登录，拥有自己的空间（Priority: P1）🎯 MVP

**Goal**: 邀请码注册/登录/登出/me + 未登录只余认证壳 + 双账户隔离成立
**Independent Test**: 全新实例建 A/B 两账户，A 单侧走完主循环，B 全不可见；未登录逐端点 401、前端只有登录壳

- [ ] T023 [US1] `apps/server/src/routes/auth.ts`：POST /api/auth/register（邀请码原子核销+建账户+`hub.ensure`+自动登录；400/409/429 语义照 contracts/http.md）、login（401 统一话术/403 停用/429）、logout（204 幂等）、me（{username,sourceToken}）、**PUT /api/auth/password**（改密：tv+1 后本会话续签；原密码错 400）（依赖 T018）
- [ ] T024 [US1] 认证套件 `apps/server/src/test/auth.test.ts`：注册成功+码即废、过期/已用/不存在码、同名 409、错凭据 401、停用 403、锁定 429→解锁（假时钟）、**注册 IP 限速 429**、**改密后其余会话 401·本会话续签**、logout 后 me 401、me 字段断言——**附录 A 逐格覆盖**（依赖 T023）
- [ ] T025 [US1] 隔离套件 `apps/server/src/test/isolation.test.ts`：双账户主循环互不可见（SC-001）、逐端点带他人资源 id→404、cookie 篡改（签名/tv/过期/uid 不存在）→401、未登录逐端点 401（SC-002）（依赖 T023）
- [ ] T026 [P] [US1] `apps/web/src/api.ts`：auth 封装（register/login/logout/me/changePassword）+ **401 单点拦截**（全局未认证信号；并发幂等；停轮询）
- [ ] T027 [US1] web 未登录壳：Login/Register 同壳互斥视图（`?code=` 预填；**页脚备案号 粤ICP备2026147541号-1 + 工信部链接**）+ `App.tsx` 闸门（启动 me 探测→壳/主界面；登录成功进主壳；表单 autocomplete 属性）+ 设置「账户」组（用户名显示 / 改密表单 / 退出登录）
- [ ] T028 [US1] web 测试 `apps/web/src/test/authView.test.tsx`：壳渲染/401 拦截切换/注册码预填（fetch 替身补 `/api/auth/me`）

**Checkpoint**: MVP 成立——quickstart S1（含隔离与锁定手工核验）

---

## Phase 4: User Story 2 - 信源与 AI 都跟着人走（Priority: P1）

**Goal**: token 定向投递 + 接入地址展示/轮换 + AI key 各归各
**Independent Test**: A/B token 各落各库；错 token 401 零落库；A 改 key/未配 key 不影响 B

- [ ] T029 [US2] `apps/server/src/routes/auth.ts` 增 POST /api/auth/source-token/rotate（新 token（16B hex）即返，旧即失效）（依赖 T023）
- [ ] T030 [US2] 网关套件 `apps/server/src/test/gateway.test.ts`：A/B token 定向（SC-001 信源面）、错/停用 token 401 且零落库、未登记路径 404、轮换后旧地址 401；nc.test.ts 路径更新为 `/hook/<token>/nc/event`（依赖 T023/T029）
- [ ] T031 [US2] AI 归属断言（并入 isolation.test.ts）：A 改 `PUT /api/settings/ai` 后 B 的 llmRef 不变；A 未配 key 时 A 提示未配置、B 不受影响
- [ ] T032 [US2] web 设置信源区：**接入地址显示框**（完整 URL + 复制）+ 「重新生成接入令牌」（二次确认）；消费 me.sourceToken
- [ ] T033 [US2] web 测试：接入地址渲染 + 轮换流（确认→旧值失效提示）

**Checkpoint**: quickstart S2 全通

---

## Phase 5: User Story 3 - 运维命令开门与照看（Priority: P2）

**Goal**: admin CLI 全命令 + 发布包首启 + 迁移指引
**Independent Test**: 命令建号→发码→注册→列用户→停用即踢→启用→重置密码

- [ ] T034 [US3] `scripts/admin.ts`：user:add（交互隐藏回显）/ user:list（含 **uid**）/ user:disable / user:enable / passwd:reset（tv+1）/ invite:new [--days 7]（BASE_URL 存在则打印注册链接）/ invite:revoke；直接开 system.db（WAL 跨进程）；退出码 0/1（依赖 T009/T010）
- [ ] T035 [US3] `package.json` 增 `"admin": "tsx scripts/admin.ts"`；CLI 核心逻辑抽可测函数 + `apps/server/src/test/admin.test.ts`（建号/停用/重置路径断言）
- [ ] T036 [US3] `scripts/build-release.mjs`：esbuild 第二入口 → `apps/server/dist/admin.mjs`（external better-sqlite3 同 banner）+ start.cmd 首启 0 账户引导建号 + `说明.txt`（admin 用法 + **旧数据手动迁移段**）
- [ ] T037 [P] [US3] `scripts/db-reset.ts`（清 system.db+users/ + 尾提示建账户）+ `scripts/seed-demo.ts`（种演示账户及其用户库）+ README 起步加建账户步
- [ ] T038 [US3] quickstart S3 手工核验 + S5 发布包走一遍（zip 首启引导/注册登录/新 URL 接入）

**Checkpoint**: quickstart S3/S5 全通

---

## Phase 6: User Story 4 - 安全底线自动兜住（Priority: P2）

- [ ] T039 [US4] 停用即时性套件（并入 isolation.test.ts）：停用→既有会话下请求 401、webhook token 401、登录 403；启用→恢复（SC-005）
- [ ] T040 [US4] 安全头与日志脱敏断言：inject 响应断言四头；/hook 请求经 logger 捕获断言 URL 不含 token

**Checkpoint**: SC-003/005 全绿

---

## Phase 7: Polish & Cross-Cutting

- [ ] T041 quickstart S1/S2/S4 真机走查（dev 双账户全流程）
- [ ] T042 `npm run check` + `npm run check:dead` + `npm run build -w @summarizing/web` 全绿（SC-006）
- [ ] T043 `/review high`（只诊断不改码）→ 修 Critical/High（最小改动）→ commit（**回滚点**）
- [ ] T044 `/simplify` → 简化前后行为对照 → `npm run check` 复核
- [ ] T045 ★ S 审查（用户人工过最终形态）→ 收口 commit
- [ ] T046 批次收尾文档：`docs/04-验收.md` 增补、CLAUDE.md 当前状态更新、03 记录项；核对 CLAUDE.md「八件套/三时机」表述与新契约一致
- [ ] T047 handoff memory 更新（本批决议 + weflow 桥方向 + 批次 2 首项=时区）

---

## Dependencies & Execution Order

- **Phase 0 → 1 → 2 严格串行**（foundational 阻塞一切）；Phase 2 内 T013→T014/T016；T009→T011/T017；T018→T019/T020/T021→T022
- **US1（T023–T028）**：foundational 后即可（MVP）
- **US2（T029–T033）**：依赖 US1 的 routes/auth.ts（T023）——网关本体在 T018 已在位
- **US3（T034–T038）**：只依赖 T009/T010 核心，可与 US1 并行开工
- **US4（T039–T040）**：依赖 US1/US2 落地后收口
- **Polish**：全故事完成后

## MVP Scope

**Setup + Foundational + US1** = 可验收「邀请码注册/登录 + 双账户隔离 E2E」；US2/US3 紧随，US4 收口。

## Notes

- **不做**（spec Out of Scope）：站内管理面/管理员角色 · 账户删除（L25）· 存量收编（手动导，quickstart 附录）· 导出 · 自助注册 · 2FA
- **不在本档**：时区定死 +08:00（批次 2 首项，R12-5）· Docker/CI/迁移三件套（批次 2）· 运营面/协议页（批次 4）
- **weflow 与本地桥**：保持 stash，解搁批次（R11）
- 消费者全量、失败矩阵、令牌方案：见 research.md / contracts/http.md（任务描述中引用，不再复述）

---

## 附录 A：边界脏形态枚举表（T001 蓝本——测试逐格覆盖）

| 输入口 | 脏形态 | 期望行为 |
|---|---|---|
| username | 缺席 / null / 空串 / 纯空白 | 400 体不合法 |
| username | <2 或 >20 字符；含内空白；控制字符/换行 | 400（message 指明） |
| username | 全角形近字（如 `ａlice`） | NFKC 归一后校验；归一与既有账户同形 → 409 |
| username | 大小写变体（`Alice` vs `alice`） | COLLATE NOCASE 视为同名 → 409 |
| password | 缺席 / <8 / >200 | 400 |
| password | 纯空白 | 400；含换行/全角——原样哈希（允许） |
| 邀请码 code | 缺席 / 空 / 超长 | 400 |
| 邀请码 code | 含空白 / 大小写变体 | trim + 归一后校验 |
| 邀请码 code | 不存在 / 已用 / 过期 | 400「邀请码无效或已过期」（话术统一） |
| 邀请码 code | 并发双注册同码 | 恰一成功（原子 UPDATE 行数判定） |
| token（/hook 路径） | 缺段（/hook//nc/event 等） | 404 路由未匹配 |
| token | 错值 / 超长 / 非 hex / 大小写变体 | 归一后 401，零落库 |
| sid cookie | 缺席 | 401（不记日志） |
| sid cookie | 坏签名 / 截断 / 非法 base64 / 载荷格式坏 | 401 + warn |
| sid cookie | exp 过期 / tv 旧 / uid 不存在 / 账户停用 | 401（tv/过期不记；uid 不存在 warn；停用 info） |
| 注册/登录体 | 非 JSON / 缺字段 / 多余字段 | 400；多余字段按 zod 默认（strip，与现有一致） |
