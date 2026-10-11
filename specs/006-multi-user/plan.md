# Implementation Plan: 多用户（单实例多账户）

**Branch**: `main`（2026-10-10 拍板：直接开发，不搞 worktree） | **Date**: 2026-10-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-multi-user/spec.md`

## Summary

单机版升级为邀请制多账户服务：每账户独占一个 SQLite 库（`data/users/<uid>.db`，隔离由构造保证）；邀请码注册 + 密码登录 + 签名 cookie 会话；信源按账户 token 经统一网关（`/hook/:token/:source/*`）路由到该账户的信源实例；LLM key 随账户库自然隔离；全部管理操作走运维命令行（站内零管理面）；不做账户删除与存量收编（Q3/D5 拍）。

技术主干：新增系统库 `data/system.db`（accounts / invites / meta）+「空间（Space）」运行时抽象——每账户一个空间 = 其 db + llm 引用 + 信源实例 + webhook 处理器表。D-88 三时机在精神上延伸：makeApp 照旧一次；`registerSources/startSources` 从「启动一次」改为「每空间一次」（迁入 `sources/host.ts` + `spaces.ts`）。

## Technical Context

**Language/Version**: TypeScript 6（strict）/ Node 22+（哈希用内置 `node:crypto` scrypt）
**Primary Dependencies**: 现有 Fastify 5 / better-sqlite3 / zod / openai SDK；**唯一新增 `@fastify/cookie`**（cookie 解析与序列化）。**零新原生依赖**——scrypt 替代 argon2 换掉的是便携包/ Docker 的打包负担（差异点已列入 research，交付时向用户点名）
**Storage**: SQLite 单文件 × N——`data/system.db`（账户登记，新）+ `data/users/<uid>.db`（每账户，现有 schema 一字不动）
**Testing**: vitest + Fastify inject（带真实会话 cookie 走真实认证链，不设测试后门——宪法 V）；web 侧 happy-dom + testing-library
**Target Platform**: Linux 服务器（Docker，批次 3）/ Windows 便携包（现有 `build:release` 流程）；开发机 Windows
**Project Type**: web-service（单进程多账户）
**Performance Goals**: 登录 ~50–100ms（scrypt 主导）；每请求增量 = 1 次 registry 索引读 + 空间表命中（μs 级）；3~5 账户、上限几十
**Constraints**: 「改造期间单机版全程可用」（单机 = 单账户实例，行为不变）；每个 commit 保持 `npm run check` 绿；类型零绕过（request 装饰走 module augmentation，禁 as）；进程内限速（单进程前提，重启即重置可接受）
**Scale/Scope**: 单进程；每账户一库一空间；信源实例数 = 活跃账户数（内存态，个位数）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **纪律 III（模块受控）**：新增 `storage/registry.ts`、`auth/{password,session,limits}.ts`、`spaces.ts`、`sources/host.ts`、`routes/auth.ts`、`scripts/admin.ts`——每一项都由 spec FR 直接调用；唯一新依赖为官方小件 `@fastify/cookie`。PASS
- **纪律 IV（无调用者不写）**：空间/网关/CLI/前端认证视图全部即建即用；不为"以后加源"预铺（weflow 解搁时按新契约适配，不预留）。PASS
- **纪律 VI（不确定先问）**：Q1–Q3/D4/D5 已拍；本计划 3 个实现级选点（scrypt 与 docs/11「argon2」措辞的偏差、`@fastify/cookie` 新依赖、webhook 路径新格式）已列入 research 并在交付报告点名。PASS
- **产品不变量**：业务管线（进站→消化→看板/对话/存疑）逻辑零改动；「静默禁止」——网关拒绝、限速锁定、停用失效全部有明确响应与日志。PASS
- **工程红线**：契约进 shared 单一来源（Auth 请求/响应 schema）；认证输入（username/password/code/token/cookie）脏形态枚举进 tasks Phase 0；签名/形状变更全部入下方影响面清单。PASS
- **复核（Phase 1 后）**：设计产物与 spec FR 逐条对应（见 data-model/contracts 映射），未引入新违规。PASS

## Project Structure

### Documentation (this feature)

```text
specs/006-multi-user/
├── plan.md              # 本文件
├── research.md          # Phase 0：9 项技术决策（含备选与理由）
├── data-model.md        # Phase 1：系统库/空间/状态机/校验规则
├── quickstart.md        # Phase 1：可运行验证剧本
├── contracts/           # Phase 1：http.md（认证+网关+错误语义）/ cli.md（运维命令）
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks 产出（不在本文件范围）
```

### Source Code (repository root)

```text
apps/server/src/
├── storage/
│   ├── db.ts             # 不动（每用户库沿用 makeDb/ensureSchema）
│   └── registry.ts       # 新：系统库（accounts/invites/meta）——makeRegistryDb + 全部读写
├── auth/
│   ├── password.ts       # 新：scrypt 哈希/校验（自描述格式 + timingSafeEqual）
│   ├── session.ts        # 新：cookie 载荷签名/验签 + 受保护区 preHandler 工厂
│   └── limits.ts         # 新：进程内登录/注册限速（滑窗）
├── spaces.ts             # 新：Space + SpaceHub（ensure / byToken / ensureAll / closeAll）
├── sources/
│   ├── types.ts          # 改：register(ctx, router: SourceRouter)——窄口替代 FastifyInstance
│   ├── host.ts           # 新：makeSourceContext/registerSources/startSources 自 app.ts 迁入，按空间参数化
│   ├── registry.ts       # 改：单例实例 → 工厂列表（每空间各造一份）
│   └── nc/index.ts       # 改：router.post("/event", …)（网关内相对路径）
├── routes/
│   ├── auth.ts           # 新：register/login/logout/me/password
│   └── {items,pipeline,settings,sources,uncertain}.ts  # 改：deps.db → req.space.*
├── app.ts                # 改：makeApp({registry, hub})；公开面 + 受保护封装作用域 + /hook 网关
└── index.ts              # 改：装配 registry→hub→app；启动时 ensureAll 各空间

apps/web/src/
├── api.ts                # 改：认证接口 + 401 全局处理（单层 as 边界不变）
├── App.tsx               # 改：登录/注册视图闸门（未登录只有认证面）
└── components/…          # 改：设置新增「账户」组（用户名/改密/退出/接入地址）

scripts/
├── admin.ts              # 新：运维命令（dev=tsx；发布包=esbuild 第二入口 admin.mjs）
├── build-release.mjs     # 改：admin 入口 + start.cmd 首启引导建号
├── db-reset.ts           # 改：清 system.db + users/
└── seed-demo.ts          # 改：种一个演示账户及其用户库

packages/shared/src/index.ts  # 改：Auth 契约 schema（register/login/me/password）
```

**Structure Decision**: 「空间」= 每账户运行时容器（db + llmRef + tools + sourceStates + 信源实例 + webhook 处理器表）。源契约 register 第二参数从 FastifyInstance 收窄为 `SourceRouter`（post/get 登记 webhook），core 全局网关统一按 token 鉴权分发——既是多用户必须（listen 后不可再注册路由），也是边界收权（信源不能再挂全局路由绕过认证）。

## 影响面清单（必填——改值形状/函数签名/枚举值前生成）

| 变更的符号/值/形状 | 全部消费点 | 本轮同步动作 |
|---|---|---|
| `SourceAdapter.register(ctx, app)` → `register(ctx, router: SourceRouter)` | `sources/types.ts:57`、`sources/nc/index.ts:141`（及 :150 路由）、`app.ts:222`（registerSources 内调用）、测试替身（`sources.test.ts` makeTestAdapter / `nc.test.ts` 装配）、weflow（stash 中，解搁时适配）、docs/07 接新源检查单、docs/10、CLAUDE.md 信源基建条 | 改码 + 改文档，逐处 |
| `registerSources/startSources`（app.ts 导出，启动一次）→ 迁入 `sources/host.ts` 且按空间调用 | `app.ts`、`index.ts:35-46`、`sources.test.ts`、`nc.test.ts`、CLAUDE.md（三时机表述） | 迁文件 + 改装配 + 改文档 |
| `makeApp(deps {db, llmRef})` → `makeApp({registry, hub})`（受保护封装作用域） | `app.ts:138`、`index.ts:36`、测试约 10 处 makeApp 构造（board×4、chat/settings/pipeline/sources/uncertain/nc/digest）→ 统一收编到新 helper `test/helpers/app.ts` | 签名改造 + 测试收编 |
| `app.sourceStates` 装饰 → `space.sourceStates` | `app.ts:144-145`、`routes/sources.ts:58+`、sources/nc 测试 | 改码 |
| 数据路径 `data/summarizing.db` → `data/system.db` + `data/users/<uid>.db` | `index.ts:19-24`、`scripts/db-reset.ts`、`scripts/seed-demo.ts:8`、README、便携包 `说明.txt`/start.cmd、docs/11 备份条（已写"多用户后=整目录"，核对） | 改码 + 改文档 |
| webhook URL `/api/sources/nc/event` → `/hook/:token/:source/*`（nc = `/hook/<token>/nc/event`） | `sources/nc/index.ts:150`、docs/08 nc 对接指南、docs/07、nc.test.ts、**用户真机 nc 配置**（上线时更新）、docs/09 | 改码 + 改文档，报告点名 |
| `llmRef` 从启动期全局 → 每空间 | `index.ts:27-31`、`app.ts:36-40`、`routes/settings.ts:24-27,90,104`、settings.test.ts | 改码 |
| `allSourceAdapters()` 返回单例实例数组 → 返回工厂列表 | `sources/registry.ts:8-13`、装配方（spaces）、`seed-demo.ts` | 改码 |
| `GET /api/backup` 语义：备份「当前账户的库」 | `routes/settings.ts:133-147`、docs/05 措辞核对 | 改码/对文 |
| 新增发布物 `apps/server/dist/admin.mjs` + start.cmd 首启流程 | `scripts/build-release.mjs`、`说明.txt` | 改脚本 |
| shared 新增 Auth 契约（注册/登录/改密/**轮换令牌** schema） | `packages/shared/src/index.ts`、server 路由、web api/视图、web 测试替身（需补 `/api/auth/me`） | 单一来源新增 |
| `request.space` 装饰类型 | `app.ts`（decorate + module augmentation）、全部 routes 处理器、`auth/session.ts` preHandler | 新增类型 + 全路由改读法 |
| Fastify 请求日志 URL 脱敏（`/hook/<token>` → `/hook/***`，FR-008） | `index.ts:70` 附近 app 构造与 `app.ts:139` logger 配置 | 本批实现 + docs/11 反代日志条（批次 3） |
| 设置「信源」区新增接入地址显示框 + 轮换入口（FR-008） | web 设置组件、`GET /api/auth/me` 消费方、web 测试替身 | 本批实现 |

## 实现顺序概览（详细任务进 /speckit-tasks）

0. **文档先行**：docs/00（系统库契约）· docs/01（认证/隔离/信源 token 行为）· docs/07/08（新源契约与 nc URL）· docs/02（D 编号 + 延后项「账户删除」）· docs/11（argon2→scrypt 措辞 + 部署注意清单——见 research R12）——先 commit，后动码
1. registry + auth 核心（password/session/limits）+ 单测
2. 源契约改造：SourceRouter + sources/host.ts + nc 适配 + 工厂注册表 + `/hook` 网关
3. Space/SpaceHub + makeApp 受保护区重构 + 全路由切 `req.space` + routes/auth + **基础安全响应头**（nosniff / Referrer-Policy: same-origin / X-Frame-Options: DENY / API `Cache-Control: no-store`；CSP 留批次 3 对 Vite 产物实测后加）
4. index.ts 装配 + CLI（admin）+ db-reset/seed-demo + 发布包（admin 入口 / start.cmd 首启）+ **升级迁移指引成文**（zip `说明.txt` 面向用户的「旧数据手动迁移」段 + README 起步加「建账户」步 + db:reset 尾提示建账户）
5. 前端：api 认证（401 单点拦截）+ 登录/注册**同壳**视图（页脚挂备案号——粤ICP备2026147541号-1，链接工信部）+ App 闸门 + 设置「账户」组
6. 测试改造：共享装配 helper + ~80 inject 站点接入真 cookie + 新增 auth/isolation/网关套件 + web 测试
7. 质量门 + `/review` → 修 → commit（回滚点）→ `/simplify` → 行为等价对照 → S 审查（本仓闭环）

## Complexity Tracking

无宪法违规，无需豁免。全部复杂度（空间/网关/受保护区）均由 spec FR 直接要求，无预铺。
