# Implementation Plan: Router 与信源（一对多接入）

**Branch**: `013-router-and-source` | **Date**: 2026-10-23 | **Spec**: [spec.md](./spec.md)

## Summary

只引入**一个**新概念 `Router`（部署级单例），信源侧只加**一个**方法 `accept`。

```
外部 HTTP
   ├── /hook/<令牌>/nc/event ──→ nc 信源（hook 自管）→ accept → 缓冲 → 切段 → ingest
   └── /relay/wecom/* ────────→ Router（验签/解密/拉取/绑定/回执）→ Source.accept → …
```

两条路在 `accept` 之后完全一致。

## Technical Context

**Language/Version**: TypeScript / Node 22+
**Primary Dependencies**: 无新增
**Storage**: `system.db` 新增部署级 KV 表（`relay_settings`）
**Testing**: Vitest；nc 既有 784 行测试作为安全网
**Constraints**: nc 行为不变；类型 strict；不写无调用者的东西
**Scale/Scope**: 单部署、一个微信客服号、2 个账户

## Constitution Check

| 门 | 结论 |
|---|---|
| I. 先跑通完整业务循环 | ✅ 不新增并行循环——`accept` 最终仍走 `ctx.ingest` 同一条管线 |
| II. 每阶段可独立使用 | ✅ 三批：Router 底座 / wecom 迁移 / nc 抽 accept，各自可发布 |
| III. 模块数量受控 | ✅ 新增**一个目录** `router/`（部署级分发，名字说得出是什么）+ 一张部署级 KV 表 |
| IV. 不写没有调用者的东西 | ✅ 不做昵称、不做多客服号、不做暂存、不做盐轮换 |
| V. 在真实入口验证 | ✅ 走真实 `makeApp` + `inject`；断言客户收到的码与回执 |
| VI. 不确定先问 | ✅ 分层 / 绑定归属 / 不做暂存 / 不给地址 均已确认 |
| 产品不变量 | ✅ 原文逐字；失败留痕不静默；LLM 不裸操作存储 |
| 工程红线 | ✅ 类型互斥；no `as`；`SourceRouter` 改名避免与新概念混淆 |
| 边界脏形态枚举 | ✅ spec 三张表（绑定 5 态 / 投递 3 态 / 回执 3 态） |
| 变形状回查消费者 | ✅ 见下方影响面清单 |

## 目录结构

```
apps/server/src/
  sources/           每账户的信源（受体）
    nc/
    wecom/
    host.ts
    registry.ts
    types.ts         ← 定义 accept 入参（router 引用它）
  router/            部署级的接入分发（分发者）
    index.ts         Router 本体：装配、设置
    bindings.ts      绑定表 external_userid → uid
    deliver.ts       resolve → source.accept
    settings.ts      凭据（部署级）+ 开关（账户级）
    wecom/           微信接入
      ingress.ts     验签/解密/拉取/回执/媒体
      crypto.ts
      api.ts
    crawler/         将来
```

**依赖单向**：`router/ → sources/types.ts`（只用 accept 的入参类型）；`sources/` 完全不知道 `router/` 存在。

## 影响面清单

### A. 新增

| 文件 | 内容 | 约 |
|---|---|---|
| `router/index.ts` | Router 主体：装配、设置读写、投递入口 | ~150 |
| `router/bindings.ts` | 绑定表（external_userid → uid，不哈希） | ~50 |
| `router/deliver.ts` | resolve → `Space.source(name).accept()` | ~60 |
| `router/settings.ts` | 部署级凭据 + 账户级开关的读写 | ~80 |
| `router/wecom/ingress.ts` | 微信接入：验签/解密/拉取/回执/媒体 | ~350 |
| `router/wecom/crypto.ts` | 从 `sources/wecom/crypto.ts` 搬入 | 移动 |
| `router/wecom/api.ts` | 从 `sources/wecom/api.ts` 搬入 | 移动 |
| `storage/relay-kv.ts` | 部署级 KV（`system.db` 新表） | ~60 |
| `test/router.test.ts` | 绑定 / 投递 / 隔离 / 码一致性 | ~180 |

### B. 改动

| 文件 | 现在 | 变成 | 改动 |
|---|---|---|---|
| `sources/wecom/index.ts` (601) | 协议 + 缓冲 + 绑定 + 回执 | **只留** `accept`（解协议+算键+装 identity）+ 缓冲 + 切段 | 拆出 ~350（协议/绑定/回执进 Router） |
| `sources/wecom/batching.ts` (135) | 四闸 | 保留 | 0 |
| `sources/nc/index.ts` (368) | register 里混着接入+缓冲 | register 只接 HTTP → `accept` | ~80 重排 |
| `sources/types.ts` (127) | `SourceRouter` / `SourceContext` | 加 `accept` 契约；`SourceRouter`→`WebhookRegistrar` | ~30 |
| `sources/host.ts` (292) | 造 ctx + register | 暴露信源实例给 Space | ~40 |
| `sources/registry.ts` (14) | 一张表 | 拆 space / relay 两张 | ~10 |
| `spaces.ts` (222) | Space 接口 | 加 `source(name)`；初始化和关停顺序 | ~30 |
| `app.ts` (297) | 只有账户网关 | 加 `/relay/:source/*` | ~40 |
| `index.ts` | 启动顺序 | Router 先启动、关停顺序反过来 | ~20 |

### C. 测试

| 文件 | 改动 |
|---|---|
| `nc.test.ts` (784) | **不改**（只验证绿） |
| `wecomSource.test.ts` (488) | 拆成两部分：Router 侧（协议/绑定/回执）+ 信源侧（accept/缓冲/切段） |
| `sources.test.ts` (473) | `SourceRouter` 改名引用 |
| `gateway.test.ts` (141) | **不改**（hookPath 公式不变） |

### D. 文档

`docs/01`（§4.19 信源架构）、`docs/02`（D-130）、`docs/07`（接新源检查单：新增「Router vs 信源」分界）、`CLAUDE.md`。

## 关键技术决策

### 1. Router 只转发 `{ raw, receivedAt }`

```ts
source.accept({ raw: unknown, receivedAt: string })
```

**为什么只传这两样**：
- `raw` = Router 不解释的内容（它不需要知道 `open_kfid` 是什么）
- `receivedAt` = Router 记的时刻（拉取时才知道）

**不传**：分组键（信源自己算）、identity（信源自己装）、解析后的字段（信源自己解）。

### 2. 回执全部归 Router

```
未绑定 → Router 发码
已绑定 → Router 发「信息已收到」
```

**为什么**：回执节流按客户（`external_userid`），而信源只收到 `raw`——它得先解析才知道客户是谁，那时才知道该不该节流。**这个判断天然属于 Router**（它已经解析过、已经查过绑定）。

信源**零回执**。

### 3. `accept` 的契约

```ts
export interface SourceAdapter {
  readonly name: string;
  /** 接收一条原始消息（Router 转发 / nc 自己的 hook 调）。
   *  解协议、算分组键、组装 identity 全部在这里。 */
  accept(input: { raw: unknown; receivedAt: string }): { ok: true } | { ok: false; reason: string };
  // ...register / start / stop / settings / fetchMedia / guide / activity
}
```

**为什么 `raw: unknown` 而不是泛型**：每个信源的协议类型不同，泛型化会让 `SourceAdapter` 变成 `SourceAdapter<T>`，而注册表/装配处只持有 `SourceAdapter`（无法带类型参数）。用 `unknown` + 信源内部 zod 解析，是唯一不需要类型断言的做法。

### 4. `Space` 暴露信源实例

```ts
export interface Space {
  // ...
  /** 按名字取已上岗的信源（Router 投递用）。 */
  source(name: string): SourceHandle | undefined;
}
```

`SourceHandle` 就是有 `accept` 的对象。

### 5. 媒体取字节

`wecom-media:<id>` 要 token。Router 在首次向某 uid 投递时注册：

```ts
space.mediaFetchers.set("wecom", (ph) => this.fetchMedia(ph));
```

闭包捕获 Router 的 token 能力。

### 6. 关停顺序

```
Router.stop()      ← 先：不再产生新消息
  ↓
hub.closeAll()     ← 后：各信源 stop（强制封批）
```

## 分批交付

| 批 | 内容 | 独立验证 |
|---|---|---|
| **1** | 部署级 KV + Router 骨架（resolve/bind/salt） | 单测；无调用者 |
| **2** | wecom 协议迁入 Router + `/relay` 网关 + 信源改造 | wecom 测试绿 |
| **3** | nc 抽 `accept` + `SourceRouter` 改名 + 关停顺序 | **nc 784 行绿** = 没改坏 |
| **4** | 文档 + 运维命令 | tsc + knip |

**第 3 批是安全节点**：它证明重构没动到老路径。

## 风险

| 风险 | 处置 |
|---|---|
| wecom 拆分漏逻辑 | 按功能段搬，每段跑测试 |
| nc 重排引入回归 | 784 行测试兜底 |
| 部署级/账户级设置混用 | 两个不同 repo 模块，函数名带前缀 |
| Router 阻塞回调 | 拉取与投递全异步；回调立即 200 |

## 已定的细节

| 项 | 决定 |
|---|---|
| 绑定码 | **external_userid 原文**，作为普通配置值存取（不哈希、不校验、不做轮换） |
| 绑定校验 | **不做**——就是个配置，填错了自然收不到消息 |
| 设置面板 | 路由组与信源组平级；每项只有**开关 + 绑定码**，凭据走命令行 |
| 设置 API | 复用现有的设置存取口（存值/读值），**不新建专用绑定端点** |
| 状态展示 | **本轮不做** |
| `accept` 返回 | `{ ok } \| { ok: false; reason }`（Router 据此留痕） |
| Router 内部 | 目录约定（`router/wecom/`），不引入新的接口类型 |
