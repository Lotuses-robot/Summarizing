# Feature Specification: Router 与信源（一对多接入）

**Feature Branch**: `013-router-and-source`
**Created**: 2026-10-23
**Status**: Draft
**Input**: User description: "我的意思是这样既能提升粒度也能降低消耗吧"（前序讨论）；"只有一个微信客服，但可以对接多个用户"；"由分发层完成用户的绑定，当信息下沉到信源层已经完成用户的拆分了"；"分发层不做分批！！！！！！分发层只分发信源和用户（或支持简单绑定逻辑）"；"术语要完全分开，这叫 router，设置也应该叫这个"；"当然不给了（wecom 的 hook 地址），而且首先，wecom 是信源不是路由它甚至可以只接受路由的函数调用"；"现在只保留 router 和信源可以吗。那 nc 信源的 hook 还是暂时他自己管理喽"。

## 背景与动机

### 一句话

微信客服只有**一个**回调地址，却要服务**多个账户**。现有架构是「一个信源实例绑死一个账户」（`ctx.ingest` 的闭包直接写 `deps.db`），结构上容不下。

### 现有架构为什么容不下

```ts
registerSources(deps, adapters)   // deps.db = 那一个账户的库
  └── makeSourceContext(deps, ...)
        └── ingest(batch) { ingestBatch(deps.db, ...) }   // deps.db 写死
```

一个 ctx 只能写一个库。让它写多个库，它就必须认识 uid —— 击穿「信源不碰数据库、不认识账户」的红线。

### 用户已确认的方向（逐条）

| 决定 | 原话 |
|---|---|
| 只保留两个概念：Router 与信源 | 「现在只保留 router 和信源可以吗」 |
| Router 不做分批 | 「分发层不做分批！！！！！！分发层只分发信源和用户」 |
| 绑定归 Router | 「由分发层完成用户的绑定」 |
| 信源只接受函数调用 | 「wecom 是信源不是路由，它甚至可以只接受路由的函数调用」 |
| nc 的 hook 自己管 | 「那 nc 信源的 hook 还是暂时他自己管理喽」 |
| 不给用户 wecom 地址 | 「当然不给了」 |

## 两个概念

### Router（部署级，一个）

**职责：接入协议 + 查出归属，然后把原始消息转发给对应账户的信源。**

```
· 微信凭据（corpId / secret / callbackToken / encodingAesKey / pullToken / openKfids）
· 验签、解密、拉取 sync_msg、游标
· 绑定表 external_userid → uid（存部署级 KV，直接存原始 id）
· 绑定码 = external_userid 原文（不做哈希——本轮降低复杂度）
· 回执与绑定码的发送（send_msg）
· 查 uid → 调 Space(uid).source("wecom").accept({ raw, receivedAt })
```

**不做**：解析消息内容、算分组键、组装 identity、缓冲、切段、ingest。

**Router 只交两样东西给信源**：原始消息（`raw`）与到达时刻（`receivedAt`）。

### 信源（每账户一个）

**职责：认识自己的协议，把消息攒成批，送进自己的库。**

```
· accept({ raw, receivedAt })   ← 唯一入口
· 解协议（zod schema）
· 算分组键（信源私有的 stream）
· 组装 identity（信源认识自己的字段）
· 缓冲 → 四闸切段 → ctx.ingest(batch)
· 设置：只有分批阈值（静默 / 最长跨度）
```

**不做**：验签、解密、拉取、查绑定、发回执。

### nc 的位置（不变）

nc 的 hook **自己管**（账户级 `/hook/<令牌>/nc/event`），**不经 Router**：

```
外部 HTTP → /hook/<令牌>/nc/event → nc 的 handler
                                      · 白名单、去重
                                      · accept({ raw: ev, receivedAt }) → 解、算键、缓冲、切段、ingest
```

理由：nc 的地址天然带账户令牌，进来就已经知道归属，不需要 Router 查表。

## 完整流程

### wecom

```
企业微信 → POST /relay/wecom/callback
   ↓ Router：验签 → 解密 → 200（5 秒内）
   ↓ 异步：sync_msg 拉取 → 得到原始消息数组
   ↓ uid = resolve(external_userid)
   ├── 有 uid → Space(uid).source("wecom").accept({ raw: msg, receivedAt })
   │             ↓ 信源解协议 → 算 stream → 装 identity → 缓冲 → 四闸 → 切段 → ingest → agent0
   └── 无 uid → send_msg(绑定码) → 丢弃这条
```

### nc

```
NapCat → POST /hook/<令牌>/nc/event
   ↓ core 网关：令牌 → Space(uid)
   ↓ nc 的 handler：白名单、去重
   ↓ accept({ raw: ev, receivedAt })
   ↓ 解 → 算 convKey → 装 identity → 缓冲 → 四闸 → 切段 → ingest → agent0
```

**两条路在 `accept` 之后完全一致。**

## 用户故事

### US1（P1）两个客户同时发消息，各进各的账户

**验收**：交错到达也不错位；一个客户的绑定错误不影响另一个。

### US2（P1）新客户收到绑定码，填码后消息归位

**验收**：未绑定 → 收到码；填码 → 之后的消息进该账户；码可重复使用（同一个哈希），但只能绑一个 uid。

### US3（P1）nc 行为完全不变

**验收**：nc 的全部既有测试绿；`hookPath` 照常显示可复制地址。

### US4（P2）Router 故障不影响其他客户

**验收**：一个客户投递失败（账户装配失败/停用）→ 留痕；其他客户正常。

### US5（P2）关停不留半截

**验收**：先停 Router（不再产生新消息）→ 再停信源（强制封批）→ 缓冲清空或留痕。

## 边界与脏形态

### 绑定

| 脏形态 | 处理 |
|---|---|
| uid 指向的账户不存在 | 视为未绑定 → 回码 |
| uid 指向的账户已停用 | 视为未绑定，但回执文案区分 |
| 同一 external_userid 绑两个 uid | 后写覆盖先写，留痕 |
| 同一 uid 绑多个 external_userid | 允许 |
| 用户填了一个**不存在**的 external_userid（打错字） | **不做校验**——就是个配置，填错了就不会有消息进来（用户自己会发现） |

### 投递

| 脏形态 | 处理 |
|---|---|
| `Space.ensure(uid)` 超时 | 单客户失败隔离，留痕，其他客户继续 |
| `accept` 返回失败 | Router 留痕，不重试（信源自己会退避） |
| 同一批重复投递 | 不引入第二层去重（ingest 管线本身的语义） |

### 回执

| 脏形态 | 处理 |
|---|---|
| 会话转人工（state=3） | `send_msg` 失败 → 留痕，不重试 |
| 配额耗尽（5 条/48h） | 同上 |
| 回执节流 | 按客户 10 分钟（可配） |

## 功能需求

### Router（FR-001 ~ FR-010）

- **FR-001**: Router MUST 是部署级单例，生命周期与进程一致。
- **FR-002**: Router MUST 挂 `/relay/wecom/*`，不绑账户令牌。
- **FR-003**: Router MUST 自己验签（`msg_signature`）、解密、拉取——微信协议全部在 Router 内。
- **FR-004**: Router MUST 维护绑定表（部署级 KV），`resolve` 返回 uid 或 null。
- **FR-005**: 绑定码 MUST 是 `external_userid` 原文，作为一个**普通配置值**存取，**不做格式/存在性校验**——本轮它就是个配置项。
- **FR-006**: 未绑定时 Router MUST 发绑定码给客户并丢弃该消息（**不暂存**）。
- **FR-007**: 已绑定时 Router MUST 只调 `Source.accept({ raw, receivedAt })`，**不解析消息内容、不算分组键、不组装 identity、不缓冲、不切段**。
- **FR-008**: Router 的回调处理 MUST 5 秒内响应（拉取与投递异步）。
- **FR-009**: Router 的设置 MUST 与其他设置一样走配置口（存值、读值），**不引入专用绑定端点、不做校验**。
- **FR-010**: Router MUST 提供部署级设置（凭据）与状态供运维查看。

### 信源（FR-020 ~ FR-025）

- **FR-020**: 每个信源 MUST 实现 `accept({ raw, receivedAt }): { ok } | { ok: false; reason }`；解协议、算分组键、组装 identity 全在信源内部。
- **FR-021**: `accept` MUST 按信源自己的分组键缓冲，四闸（静默 / 条数 / 字节 / 龄期）任一命中即切段。
- **FR-022**: 信源 MUST NOT 接触 HTTP（nc 的 hook 是例外，它自己管理）。
- **FR-023**: 信源的设置 MUST 只含分批阈值（静默分钟数、最长跨度分钟数）；条数与字节为代码常量。
- **FR-024**: nc MUST 保持 hook 自管（`/hook/<令牌>/nc/event`），`hookPath` 照常下发。
- **FR-025**: wecom 信源 MUST NOT 提供 hookPath（地址属 Router，不暴露给用户）。

### 装配与关停（FR-030 ~ FR-035）

- **FR-030**: `Space` MUST 暴露 `source(name)` 取信源实例（Router 用）。
- **FR-031**: Router MUST 能注册「媒体取字节」实现到目标账户（`wecom-media:` 占位要 token）。
- **FR-032**: 关停顺序 MUST 为：先停 Router → 再停各账户信源 → 再关库。
- **FR-033**: 单账户装配失败 MUST NOT 中断整轮拉取。
- **FR-034**: `ensure(uid)` MUST 有超时保护（不拖住整轮拉取）。
- **FR-035**: `SourceRouter`（旧的 webhook 登记器）MUST 改名为 `WebhookRegistrar`，避免与 Router 混淆。

### 设置与可见性（FR-040 ~ FR-043）

- **FR-040**: 微信凭据 MUST 存部署级 KV（运维配置），MUST NOT 出现在任何账户的设置页。
- **FR-041**: 账户设置页 MUST 只显示：接收开关、绑定状态、填绑定码入口。
- **FR-042**: 分批阈值 MUST 存该账户自己的 `source_settings`。
- **FR-043**: Router 的状态（最近拉取/错误）MUST 可查（运维面），MUST NOT 泄露凭据。

## 关键实体

- **Router**：部署级单例，负责识别与投递。
- **Binding**：`external_userid → uid`，存部署级 KV。
- **Source**：每账户一个，`accept` + 缓冲 + 切段 + ingest。
- **SourceLine**：统一的「一行」形状（messageId / content / sender / senderId / at + 各源私有 extras）。

## Success Criteria

- **SC-001**: nc 的 784 行测试全绿、`hookPath` 不变。
- **SC-002**: 两个客户交错发消息 → 各进各账户，零串位。
- **SC-003**: 未绑定客户收到的码就是其 external_userid；填入后立即生效。
- **SC-004**: 微信回调 5 秒内返回（实际拉取异步完成）。
- **SC-005**: 一个账户装配失败不影响同批其他账户。
- **SC-006**: 关停后无残留缓冲（要么已 ingest，要么留痕）。

## Assumptions

- 部署级信源没有「自己的库」——wecom 信源的 `ctx.ingest` 仍写**它所属账户**的库。
- nc 的 hook 继续自管，不引入 Router。
- 绑定码不需要过期（就是 external_userid），用户可主动解绑。
- 不做客户昵称（用户明确不需要）。
- 不做暂存（未绑定消息直接丢弃 + 回码）。

## 不在本特性范围

- 客户昵称（`kf/customer/batchget`）
- 多客服账号（用户只有一个）
- 绑定码哈希/轮换（本轮直接用 external_userid 原文）
- nc 接入 Router
