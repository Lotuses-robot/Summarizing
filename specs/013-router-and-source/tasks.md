# Tasks: Router 与信源（一对多接入）

**Branch**: `013-router-and-source` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Phase 0：脏形态枚举（动手前先列全）

### 绑定表（部署级 KV）

| 形态 | 处理 | 测 |
|---|---|---|
| `external_userid` 为空串 | 不写绑定（无意义） | ✅ |
| 同一 id 绑两个 uid | 后写覆盖，留痕 | ✅ |
| 同一 uid 绑多个 id | 允许 | ✅ |
| 绑定的 uid 不存在 / 停用 | `resolve` 返回 null → 视为未绑定 | ✅ |
| 绑定值被手改成非法 JSON | **抛错**（兜底成空表 = 全部判未绑定、消息静默丢失） | ✅ |

### `accept` 入参

| 形态 | 处理 | 测 |
|---|---|---|
| `raw` 不是对象 | 信源 zod 解析失败 → `{ ok: false, reason }` | ✅ |
| `raw` 缺关键字段（无 msgtype） | 同上 | ✅ |
| `receivedAt` 非墙钟格式 | 信源不解析它（只用于闸门），但闸门要容错 | ✅ |
| 同一条消息重复投递 | 信源按 messageId 去重（nc 已有先例） | ✅ |

### 投递

| 形态 | 处理 | 测 |
|---|---|---|
| `space.source(name)` 为 undefined（用户关了开关） | `{ ok: false, reason: "disabled" }` → Router 回「暂不可用」 | ✅ |
| `hub.ensure(uid)` 抛错 | 单客户失败隔离，留痕，其他客户继续 | ✅ |
| `hub.ensure(uid)` 超时 | 同上 | ✅ |
| `accept` 返回 `{ ok: false }` | Router 留痕，不重试 | ✅ |

---

## Phase 1：部署级 KV + Router 骨架（无调用者，纯新增）

- [x] **T001** `storage/relay-kv.ts`：`system.db` 加表 `relay_settings(key TEXT PRIMARY KEY, value TEXT)` + get/set/delete/list
- [x] **T002** [P] `relay-kv` 测试：读写、覆盖、删除、坏 JSON 容错
- [x] **T003** `router/bindings.ts`：`resolve(id) / bind(id, uid) / unbind(id) / list()`（存 relay-kv）
- [x] **T004** [P] bindings 测试：Phase 0 的 5 种形态
- [x] **T005** `router/deliver.ts`：`deliver(hub, sourceName, uid, input)` → 查 `space.source()` → `accept`
- [x] **T006** [P] deliver 测试：Phase 0 的 4 种投递形态（用替身 hub）
- [x] **T007** `router/settings.ts`：部署级凭据读写（`getCredential/setCredential`）+ 账户级开关读写
- [x] **T008** [P] settings 测试

## Phase 2：wecom 协议迁入 Router

- [x] **T010** 把 `sources/wecom/{crypto,api}.ts` 移到 `router/wecom/`（`git mv`，保留历史）
- [x] **T011** `router/wecom/ingress.ts`：验签、解密、`/callback` 处理（从 `sources/wecom/index.ts` 搬）
- [x] **T012** ingress 的拉取逻辑：`sync_msg` + cursor（cursor 改存 relay-kv）
- [x] **T013** ingress 的回执：未绑定发码 / 已绑定发「信息已收到」，节流在 Router
- [x] **T014** ingress 的媒体取字节：`fetchMedia(placeholder)`
- [x] **T015** [P] ingress 测试：分流（多客户）、未绑定回码、已绑定回执、节流、媒体
- [x] **T016** `app.ts` 加 `/relay/wecom/*` 网关（不绑账户令牌）
- [x] **T017** [P] 网关测试：真实 `inject` 走 `/relay/wecom/callback`

## Phase 3：信源改造

- [x] **T020** `sources/types.ts`：`SourceAdapter` 加 `accept({ raw, receivedAt })`；`SourceRouter` → `WebhookRegistrar`
- [x] **T021** `sources/wecom/index.ts`：删掉协议/绑定/回执，只留 `accept` + 缓冲 + 切段 + `register`（只存 ctx）
- [x] **T022** [P] wecom 信源测试：`accept` 解协议、算 stream、装 identity、四闸切段、ingest
- [x] **T023** `sources/nc/index.ts`：`register` 里的缓冲逻辑抽成 `accept`
- [x] **T024** **nc 全部 784 行测试必须绿**（安全节点）
- [x] **T025** `sources/host.ts`：`SourceAssembly` 暴露信源实例；`Space` 加 `source(name)`
- [x] **T026** `spaces.ts`：`Space.source()` 实现 + 关停顺序
- [x] **T027** `index.ts`：Router 先启动；关停时先停 Router

## Phase 4：设置面板 + 命令行 + 文档

- [x] **T030** 信源的 `register` 完成后，`sources/registry.ts` 保持一张表（Router 不在这里）
- [x] **T031** `admin` 加 `router:set <key> <value>` / `router:get <key>` / `router:list`
- [x] **T032** [P] admin 测试
- [x] **T033** web 设置面板：`SettingsModal` 加「路由」组（与「信源」平级）
- [x] **T034** 路由组每项：开关 + 绑定码（复用 `source_settings` 存取口）
- [x] **T035** [P] web 测试
- [x] **T036** 文档：`docs/01`（§4.19 新增 Router 一节）、`docs/02`（D-130）、`docs/07`（接新源检查单加「Router vs 信源」）、`CLAUDE.md`
- [x] **T037** `docs/03` 的 Q29（设置 API 统一）已在讨论中记录

---

## 验证清单

| 层 | 命令 |
|---|---|
| 类型 | `npx tsc -p apps/server --noEmit` |
| 单测 | `npx vitest run` |
| 死码 | `npm run check:dead` |
| 全量 | `npm run check` |
| 真机 | 见 `docs/04` 新增的验收节 |

## 分批发布

| 批 | 任务 | 可独立验证 |
|---|---|---|
| 1 | T001–T008 | 单测绿（无调用者） |
| 2 | T010–T017 | wecom 全链路测试绿 |
| 3 | T020–T027 | **nc 784 行绿** ← 关键安全节点 |
| 4 | T030–T037 | tsc + knip + 真机 |
