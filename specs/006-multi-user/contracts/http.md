# HTTP 契约：认证 + 信源接入网关

> 权威：本档为 specs/006 批次内契约；落地后行为并入 docs/01-规格。请求/响应 schema 单一来源在 `packages/shared`（zod），前后端同引。

## 认证端点（公开面）

### POST /api/auth/register

- **Body**：`{ code, username, password }`（RegisterRequestSchema）
- **201** + `Set-Cookie: sid` + `{ username }` —— **注册即登录**（US1 验收 2）
- 失败：`400` 体不合法 / 用户名或密码不合规（message 指明哪一项）｜`400` 邀请码无效、已用或过期（明确失败，FR-002）｜`409` 用户名已占用｜`429` 注册限速（FR-013）

### POST /api/auth/login

- **Body**：`{ username, password }` → **200** + `Set-Cookie` + `{ username }`
- 失败：`401 {error:"用户名或密码错误"}`（统一话术，不泄露存在性）｜`403 {error:"账户已停用"}`（独立提示——spec US3 验收 2 要求明确）｜`429 {error, retryAfterSec}` 锁定中（FR-012）

### POST /api/auth/logout

- **204**，清除 cookie（幂等，无需已登录）

### GET /api/auth/me

- **200** `{ username, sourceToken }`——sourceToken 供用户自配信源接入地址（FR-008 的用户可见面）
- **401** 未登录

### PUT /api/auth/password

- **Body**：`{ oldPassword, newPassword }`
- **204** + 重签**当前**会话（tv+1 后本会话续新 cookie）；其余旧会话下次请求 401（FR-004）
- 失败：`400` 原密码不正确 / 新密码不合规｜`401` 未登录

### POST /api/auth/source-token/rotate

- 重新生成接入令牌（**旧值即刻作废**——全部旧接入地址 401）
- **200** `{ sourceToken }`；设置区「接入地址」框随之更新
- 前端 MUST 二次确认（会打断现有 nc 接入）；FR-008

## 全局认证规则（FR-001）

- 除 `POST /api/auth/{register,login,logout}` 与 `/hook/*` 外，**全部 /api/\*** 无有效会话 → `401 {error:"未登录"}`。
- 前端：任意 API 返回 401 → 切回登录视图（`/api/auth/me` 的启动探测 401 除外——那是正常首屏路径）。

## 校验失败矩阵（逐状态——2026-10-11 定稿）

### 会话通道（受保护 /api/*；中间件统一判定）

| 触发状态 | 响应 | 留痕 |
|---|---|---|
| 无 cookie | 401 | 不记 |
| cookie 签名坏 / 载荷格式坏（含篡改） | 401 | warn（可能的攻击信号） |
| 过期（exp） | 401 | 不记 |
| tv 不匹配（改密/重置后的旧会话） | 401 | 不记 |
| 账户不存在 | 401 | warn |
| 账户停用 | 401 | info |

**统一语义**：中间件恒 401 `{error:"未登录"}`——细分状态只影响服务端留痕，不让前端长分支；「停用」的解释发生在登录动作处（403「账户已停用」）。

### 登录端点

| 状态 | 响应 |
|---|---|
| 锁定中 | 429 + `retryAfterSec` |
| 用户名或密码错误（含用户名不存在） | 401「用户名或密码错误」（统一话术） |
| 账户停用 | 403「账户已停用」 |
| 体不合法 | 400 + issues |

### 注册端点

| 状态 | 响应 |
|---|---|
| 体不合法 / 用户名或密码不合规 | 400（message 指明项） |
| 邀请码无效 / 已用 / 过期 | 400「邀请码无效或已过期」 |
| 用户名已占用 | 409 |
| 限速 | 429 |

### 信源网关

| 状态 | 响应 |
|---|---|
| 无/错 token、账户停用 | 401 `{error}`，零落库 |
| (source, 路径) 未登记 | 404 |
| 载荷超限 | 413（Fastify 默认） |
| 事件形状不符（nc 协议层） | 204 静默丢（沿用现 nc 语义——nc 协议要求，非「静默失败」） |

### 前端 401 规约（单点拦截）

- `api.ts` 是唯一 401 拦截点：任何受保护请求 401 → 全局「未认证」信号 → App 切换到**未登录壳**（清界面状态、终止在飞请求的效果、停止一切轮询）。
- 启动探测 `GET /api/auth/me` 的 401 是正常首屏路径（不弹错误提示）。
- 未登录壳（登录/注册互斥视图）渲染时 MUST NOT 发起任何受保护请求。
- 未登录壳页脚 MUST 展示备案号（粤ICP备2026147541号-1，链接 https://beian.miit.gov.cn/）——合规要求的公开可达页面即此壳。
- 登录成功 → 拉 me → 进主壳；登出 → POST logout → 切回未登录壳；并发 401 幂等（只切换一次）。

## 会话 cookie 规格（FR-005）

| 属性 | 值 |
|---|---|
| 名 | `sid` |
| 值 | `base64url(payload)` + `"."` + `HMAC-SHA256(base64url(payload), session_secret)` |
| payload | `{ v: 1, uid, tv, exp(ms) }` |
| httpOnly | true |
| SameSite | Lax |
| Path | / |
| Max-Age | 30 天；剩余 <15 天时随响应续签（滑动） |
| Secure | env `SESSION_COOKIE_SECURE`，默认 `"1"`（本机/便携包如遇浏览器差异设 `"0"`） |

校验失败（无/坏签名/过期/tv 不匹配/uid 不存在/账户停用）一律按"未登录"处理。CSRF：SameSite=Lax + 全部写操作 JSON/POST——不做 CSRF token（点名接受，见 research R7）。

## 信源接入网关（webhook，FR-008）

- **URL**：`{origin}/hook/:token/:source/*` —— nc 例：`https://sum.lotuses.cn/hook/<接入令牌>/nc/event`
- **令牌获取**：设置 →「账户」组展示（值源自 `GET /api/auth/me` 的 `sourceToken`）。
- **语义**：
  - token 不存在 / 账户非 active → `401 {error}`（**不触碰任何库**——先鉴权后路由）
  - 命中 `(source, method, 相对路径)` → 该账户该信源实例的处理器（沿用例会响应语义：nc = 204 静默丢/受理）
  - 相对路径或信源未登记 → `404`
- 方法集合：`GET/POST/PUT/DELETE`（当前仅 nc 用 POST）。
- 载荷上限：沿用 Fastify 默认 1 MB；超大群消息（含大图片段）的表现与调整办法记入 docs/08。
- 令牌在 URL 路径中——与 query 暴露等价；泄露对策 = 设置区一键轮换（`POST /api/auth/source-token/rotate`）。
- **日志脱敏**：服务器应用日志 MUST NOT 明文记录 `<token>`（Fastify 本批）；反代访问日志同规（Caddy 配置随批次 3）。

## 错误响应形状（沿现有惯例）

- 一般错误：`{ error: string }`
- zod 校验失败：`{ error, issues }`（与现 /api/ingest、/api/chat 一致）
