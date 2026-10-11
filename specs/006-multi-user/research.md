# Phase 0 Research: 多用户（单实例多账户）

> 9 项技术决策。每项：Decision / Rationale / Alternatives considered。
> 三个向用户点名的选点：R2（scrypt，与 docs/11「argon2」措辞偏差）、R4（webhook 路径新格式）、R7（`@fastify/cookie` 新依赖）。

## R1 会话机制

- **Decision**: HMAC-SHA256 签名 cookie（`sid`），载荷 `{v, uid, tv, exp}` 紧凑编码 + 签名，无会话表；`token_version`（账户列）作撤销开关。
- **Rationale**: 每请求反正要读 accounts（status 即时生效——FR-014 停用即踢、秒级），签名 cookie 不再引入第二张有状态表；改密/重置 → tv+1 → 全端旧会话作废；负载不含敏感信息。滑动续期：剩余 <15 天时随响应重签（FR-005 的 30 天在 Assumptions）。
- **Alternatives**: ①服务端 sessions 表——多一张表 + 清理逻辑 + 逐会话撤销，本项目不需要；②JWT——重、撤销照样要落库查，收益为零；③手写 cookie 解析——不如官方件稳。

- **安全细则（2026-10-11 审）**: 验签 MUST 用 `timingSafeEqual`（禁字符串比较）；登出 = 清客户端 cookie——**被盗 cookie 无法被登出远程作废**，靠改密（tv+1）或停用失效（接受并记录）。

## R2 密码哈希（scrypt）

- **Decision**: `node:crypto` scrypt 异步版，N=2^15 / r=8 / p=1 / keylen=64 / salt=16B / maxmem=64MiB；存储自描述格式 `scrypt$N,r,p$<salt_b64>$<hash_b64>`（将来调参可平滑）；`timingSafeEqual` 比对；用户名不存在时也做一次哑哈希（不泄露存在性）。
- **Rationale**: **零新原生依赖**——便携包（`build-release.mjs` 手工拷贝 better-sqlite3 的 .node）与 Docker 打包零改动；scrypt 是 OpenSSL 实现（成熟件，非自造密码学，符合 docs/03「不造密码学」）；登录低频，~50–100ms 可接受。**偏差点名**：docs/11 阶段 3 写的是「argon2 哈希」——落地按本决策改 docs/11 措辞。
- **Alternatives**: ①`@node-rs/argon2`——算法更现代，但新增原生模块（win32-x64 / linux-x64 两套预编译要进便携包与镜像，打包面变大）；②bcryptjs——纯 JS 慢且不是现代首选；③PBKDF2——弱于 scrypt，无理由选。

## R3 请求期 db 解析

- **Decision**: `request.space` 装饰（Fastify module augmentation，类型安全）；受保护路由**整组装进一个封装作用域**（encapsulated plugin），作用域级 preHandler：验签 cookie → registry 读账户（存在/active/tv 匹配）→ `hub.ensure(uid)` → 挂 `request.space`。全部路由处理器把 `deps.db` 改为 `req.space.db`（llmRef/sourceStates 同理）。**结构纪律（review 必查）：全仓唯一打开用户库的调用点 = hub**——任何绕过 `request.space` 直接开库的路径都是事故形态。
- **Rationale**: 显式、可测、无隐式魔法；作用域封装从结构上防「某条路由漏挂 preHandler」。
- **Alternatives**: ①AsyncLocalStorage——隐式，后台任务不在请求上下文，排障难；②可换引用对象（llmRef 式）——并发请求会串账（llmRef 安全因其是全局配置，db 不是）。

## R4 空间装配 + webhook 网关

- **Decision**: 源契约窄口 `SourceRouter { post(path, handler); get(path, handler) }`——适配器 `register(ctx, router)` 只在**本空间**登记 webhook 处理器；core 启动时注册**唯一网关** `app.route({ method: ["GET","POST","PUT","DELETE"], url: "/hook/:token/:source/*" })`：token → Space（active 校验）→ `(method, 路径)` → 该空间该源的处理器。启动 `hub.ensureAll()` 装配全部活跃账户；注册新账户实时 `ensure`。
- **Rationale**: **Fastify listen 之后不能再注册路由**——「每空间挂 Fastify 前缀子插件」对"运行中新建账户"不可行，必须网关 + 每空间处理器表（两者都造）。同时这是边界收权：信源不得再挂全局路由（多用户下全局路由 = 鉴权旁路）；D-88「八件套」精神保留（ctx 仍无 db，进站仍走 ctx.ingest）。
- **Alternatives**: ①每空间子插件（prefix=/hook/<token>）——启动时用户可行、运行中新用户死路；②适配器内部自建 `Map<uid, 私有态>` + 保持 app.post 直挂——契约留后门，鉴权逻辑散进信源（重复且易漏）。

## R5 库布局与标识

- **Decision**: `data/system.db`（accounts/invites/meta）+ `data/users/<uid>.db`；uid = 8B 随机 hex（`crypto.randomBytes`）；`source_token` = 16B 随机 hex；邀请码 = 10 位无歧义 base32（Crockford 字母表，去 I/L/O/U）。
- **Rationale**: 构造隔离（uid 不可由用户名推导）；文件名安全字符；token/码熵足够防枚举（叠加限速）。
- **Alternatives**: 递增数字 uid——可枚举侧信道；用户名当文件名——改名/重名/转义三坑。

## R6 限速（进程内）

- **Decision**: 进程内 Map 滑窗：登录按 `username|来源IP` 连续 5 次失败锁 15 分钟（锁定期内一律 429 + 剩余秒数）；注册按来源 IP 10 次/10 分钟。常量进代码（「系统策略进代码」原则）；重启即重置（可接受，点名）。锁定键为**（用户名, 来源 IP）对**——防「拿别人用户名锁人」的 DoS（受害者从自己 IP 不受影响）；用户名先按查库同口径折叠（NFKC+trim+小写）——防大小写变体各享一份锁定预算（评审修复）。**另加登录按 IP 总量限速 30 次/10 分钟**（评审修复：防随机用户名连刷——每次 miss 都跑真 scrypt）。
- **Rationale**: 单进程单人运维，不需要持久化/分布式限速。
- **Alternatives**: `@fastify/rate-limit`——要为"按用户名"定制且引入依赖；不划算。

- **部署注意（2026-10-11 补）**: 反代（Caddy）后 `req.ip` 会是 127.0.0.1——**服务器环境必须开 Fastify `trustProxy`**（读 X-Forwarded-For，Caddy 默认携带），否则限速的来源 IP 维度退化（注册限速尤其；协议判定同受影响）。env `TRUST_PROXY=1`（compose 设；本地直连不设）。**前提**：应用端口（3001）绝不可直暴公网（防火墙 / compose 网络只让 Caddy 可达）——否则 XFF 可伪造、限速可被绕过。

## R7 cookie 属性

- **Decision**: `sid`，httpOnly + SameSite=Lax + Path=/ + Max-Age 30 天；Secure **按请求协议自动**（https → 开——Caddy/上线场景；局域网 http 手机访问则关，评审修复：固定默认开会让手机 http 登录静默失败）；env `SESSION_COOKIE_SECURE=1` 可强制开。
- **Rationale**: 单站点、无跨站需求；CSRF 基线 = SameSite=Lax + JSON 写请求（全部状态变更均为 POST/PUT/DELETE）——**不做 CSRF token，点名接受**。
- **Alternatives**: SameSite=Strict——外链进入首跳体验差无收益；CSRF token——本规模过度。

## R8 CLI 与发布包

- **Decision**: `scripts/admin.ts` 单一实现；dev 走 `npm run admin -- <cmd>`（tsx）；发布包 esbuild 加第二入口 → `apps/server/dist/admin.mjs`（external better-sqlite3，同 banner）；`start.cmd` 首启检测 0 账户 → 引导建号（调用 admin 同一核心函数）。
- **Rationale**: 一条代码路径三处复用（开发机 / 服务器 `docker compose exec` / 便携包）；保住 zip「双击即跑」。**安全性质（2026-10-11 审）**：新实例公网暴露时无人可注册（无邀请码、无初始化向导）——不存在「首个访问者抢注」竞态；CLI 建号是唯一入口。
- **Alternatives**: 服务器端另写 shell 工具——两套真相；纯 tsx（发布包无 tsx）——不可行。

## R9 测试装配

- **Decision**: 新增 `test/helpers/app.ts`：`makeTestAccount()` 造临时 registry + 空间 + 已登录会话 cookie，返回 `{ app, db, cookie, inject }`（inject 自动带 cookie）；约 80 个既有 inject 站点机械接入；新增 auth（注册/登录/锁定/停用即踢/改密全端下线）、isolation（双账户全程互不可见）、网关（坏 token 401 且零落库）套件；web 侧 fetch 替身补 `/api/auth/me`。
- **Rationale**: 断言仍走真实入口、过真实认证链（宪法 V，不设测试后门）；helper 一次收敛，避免 8 个测试文件各造一套。
- **Alternatives**: 测试模式旁路认证——违反宪法 V，排除。

## R10 webhook token 方案

- **Decision**: `crypto.randomBytes(16)` → 32 位 hex；**一账户一把**（统一管所有源）；**明文存** `accounts.source_token`（UNIQUE）；设置区展示完整接入地址 + 一键轮换（`POST /api/auth/source-token/rotate`，旧值即刻失效）；**Fastify 日志对 `/hook/<token>` 路径脱敏**（自定义 req 序列化器或 redact，实现时择一验证）；反代访问日志不记 /hook（批次 3 Caddy 配置落实）。
- **Rationale**: 威胁定位——token 是"写入凭证"非"读取凭证"：最坏 = 往对方库注入消息（还要过协议解析与白名单、耗对方自己的 key），不能读、不能改、不能登录，危害等级低于密码/会话。"只存哈希"推演过并弃——它只保护备份泄露这一个面，但同份备份里躺着更值钱的数据本身（护小漏大）；且哈希=令牌只能看一次，想再看必须轮换、轮换会**打断现有 nc 接入**（消息丢失窗口）——明文+随时可看+轮换兜底是更优组合。HTTPS 下 URL 路径在 TLS 密文内，链路无风险；残留风险=服务器日志（本批脱敏）/nc 端配置文件（docs/08 讲清）/备份（接受并记录）/截图（轮换）。
- **Alternatives**: ①只存哈希+显示一次（上析，弃）；②header 传 token（如 `X-Source-Token`）——nc 配置不保证支持自定义头，本批不做；③query 参数——与路径暴露等价，路径更整洁，选路径。

## R11 拉型源（SSE）与收窄契约

- **Decision**: 拉型源（如 weflow：连 WeFlow 的 SSE 流）**不经过网关、不用 token、不占任何服务端路由**——它是出站客户端：`start()` 里连上游（地址取自本空间设置）、`AbortController` 经 `ctx.onCleanup` 登记、断线重连退避自管、帧→打包→`ctx.ingest`。`SourceRouter` 只服务推型源（webhook 收）。
- **Rationale**: SSE 本质是"客户端连上去读的长连接响应"——方向天然出站；「推型收 / 拉型连」二分让两类源都不受阻——**同机/同网形态下无需任何转发工具**（"SSE 再转 POST 回自己"纯属绕路）；跨 NAT 形态见下方可达性附注。weflow 草稿（stash 中）已符合新契约：工厂形态 + ctx 八件套、register 只挂 `setInterval` 不碰路由——解搁时补 `start()` 连接即可（重连/关停是 weflow 自身工作量，与多用户无关）。
- **跨 NAT 形态的解法（2026-10-11 讨论定方向）**: 本质约束——NAT 下连接必须**由内向外发起**，解法收敛为两类：内向外推 / 内向外组网。据此定：**作者自己 = Tailscale 组网**（云服务器与家机同 tailnet，适配器"直连模式"连 WeFlow 的 tailnet 地址——零桥零暴露；本地开发已在用 Tailscale，`index.ts` 注释在案）；**朋友/一般用户 = 通用本地桥**（哑管道小工具：连 SSE URL → 逐帧 POST 到 `/hook/<token>/<source>/event`——**出站, NAT 友好、无业务逻辑**〔打包/白名单/窗口都在服务端适配器与网页设置〕、断线重连自管、顺序保持；因不含源专属逻辑，任何流式上游可复用；上游原生支持 webhook 推送时桥直接退役）；**穿透（frp 等）不做**。附带判据：上云语境接新源**优先推型协议**（NAT 天然友好——nc 先跑通正因此）；桥使服务端在推型下永远不需出站连接。**实现归属 weflow 解搁批次（不急于排期；2026-10-11 用户确认：WeFlow 无原生 webhook 推送 → 本地桥为既定路线）**；006 契约对推/拉均已就位、不受影响。
- **Alternatives**: ①经 webhook 网关中转 SSE——同机形态多一跳无收益；②共享上游扇出多用户（一个 WeFlow 服务供所有用户）——跨用户汇流，违反隔离精神，本批明确不做（每用户各配自己的上游）。

## R12 部署注意汇总（docs/11 同步源——批次 3 执行/核对）

> 以下条目随 006 文档同步写入 docs/11（避免散落），批次 3 服务器落地时逐条执行。

1. **trustProxy 前提**（R6）：应用端口 3001 不直暴公网（防火墙 / compose 网络只让 Caddy 可达）；`TRUST_PROXY=1`。
2. **反代日志**：Caddy 访问日志不记 `/hook`（或整体关闭 access log）；应用侧 URL 脱敏（FR-008）。
3. **data/ 目录权限**：服务用户专有（服务器 OS 层收紧）。
4. **安全头 / CSP / HSTS**：基础头随 006；CSP 批次 3 对 Vite 产物实测后加；HSTS 一并。
5. **时区（2026-10-11 终定——全统一固定 +08:00，零配置）**：用户拍板「都统一 +8」——不做 env、不做设置面板、不做用户级；库内时区恒定约束天然满足（全局只有一个 +8）。**列为批次 2 首项（独立小批次、单独 commit 与审查，不搭 006——diff 主题不同）**：server `shared/time` 三函数硬编 +08:00（`Date.now()+8h` 取 UTC 分量 / `parseWallClock` 按 `+08:00` 解析；`nowLocalWallClock`→`nowWallClock` 改名去 Local）；**web 同步**（`lib/time` 格式化改纯字符串裁剪〔零时区参与〕；组件里 `new Date(墙钟串)` ≈12 处统一走 +08:00 解析助手；`toLocaleString` 长格式收编 `lib/time`）；shared（`relative-due` 同改、`localWallClockSchema`→`wallClockSchema`）；docs 00/01 措辞「本地墙钟」→「北京时间墙钟（固定 UTC+8）」+ 02 记 D-64 修订。**收益**：服务器/测试机时区完全无关（阿里云 UTC 也无碍）；同区用户行为零变化。消费者全量（2026-10-11 grep）：server 7 文件 20 处 · web 6 组件 + 2 lib ≈12 处 · shared relative-due。服务器 TZ 设置降为可选（仅日志可读性）；上线总检保留一条时间显示核对。
6. **备份形态（多用户后）**：备份 = 对 `system.db` 与 `users/*.db` **逐库跑 `.backup` API**（WAL 安全）——不是裸拷目录（WAL 可能有未落盘内容）；试恢复演练按同目录回放。
7. **`.env` 的 `OPENAI_*` 在多用户实例留空**：自带 key 是方向（docs/03）；留空使未配 key 的用户得到「未配置」提示，而非**静默共享运维的 key**（成本与预期都干净）；单机/便携包不受影响（.env 即本人 key）；「托管方提供 AI」属未来付费服务，不在本批。
8. **反代层限速/防护**覆盖 `/hook` 洪水（批量注入=自我伤害，但会挤占单进程）。
