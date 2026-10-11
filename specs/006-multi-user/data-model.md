# Phase 1 Data Model: 多用户（单实例多账户）

> 契约权威：用户库（`data/users/<uid>.db`）schema 一字不动，以 `docs/00-数据契约.md` 为准；本档只定义**新的系统层**。系统库与用户库同用幂等 `ensureSchema` 模式（版本号/迁移前备份属批次 2，D4）。

## 库布局

```text
data/
├── system.db          # 新：系统库（账户登记——不含任何业务数据）
└── users/
    └── <uid>.db       # 每账户一个（现 schema 原样：raw_inputs/items/…/item_views）
```

- 旧 `data/summarizing.db`：新版**不认不动**（D5：不做收编，运维届时手动导——标准流程见 quickstart 附录）。
- ⚠️ `system.db` 是账户索引——它丢了，所有用户库成孤岛（不可寻址）；备份硬要求 = 整个 `data/`。
- 备份口径：整目录（docs/11 已写"多用户后 = 整目录"，核对无误）。

## system.db 表结构

### `accounts`（账户）

| 列 | 类型 | 约束与说明 |
|---|---|---|
| `uid` | TEXT PK | 8B 随机 hex（`crypto.randomBytes(8)`）——库名来源，不可由用户名推导 |
| `username` | TEXT NOT NULL UNIQUE COLLATE NOCASE | 2~20 字符；`\p{L}\p{N}` + `_` `-`（含 CJK）；大小写不敏感唯一（防 `A`/`a` 双占）；**NFKC 归一 + trim 后**再校验（防全角形近字双占） |
| `password_hash` | TEXT NOT NULL | `scrypt$N,r,p$salt_b64$hash_b64` 自描述格式 |
| `status` | TEXT NOT NULL DEFAULT 'active' | CHECK IN ('active','disabled')——无删除状态（Q3） |
| `token_version` | INTEGER NOT NULL DEFAULT 1 | 改密/重置时 +1 → 该账户全部旧会话作废 |
| `source_token` | TEXT NOT NULL UNIQUE | 16B 随机 hex——webhook 凭据（FR-008；明文存储、展示与轮换见 research R10） |
| `created_at` | TEXT NOT NULL | 本地墙钟（`nowLocalWallClock`） |

### `invites`（邀请码）

| 列 | 类型 | 约束与说明 |
|---|---|---|
| `code` | TEXT PK | 10 位无歧义 base32（去 I/L/O/U） |
| `created_at` / `expires_at` | TEXT NOT NULL | 默认 7 天有效期 |
| `used_by` | TEXT NULL | → accounts.uid（一次性；NULL = 未用） |
| `used_at` | TEXT NULL | 核销时刻 |

核销原子性：`UPDATE invites SET used_by=?, used_at=? WHERE code=? AND used_by IS NULL AND expires_at > ?` → 变更行数 =1 才继续创建账户（同一事务）。

### `meta`（键值）

| key | 说明 |
|---|---|
| `session_secret` | 32B hex，系统库首建时生成——重启后会话不失效；换值 = 全体下线 |
| `schema_version` | 占位（批次 2 的版本号机制接手，本批只写值 1） |

## 运行时对象（不持久）

```text
Space（每账户一个）
├── uid / db（makeDb(data/users/<uid>.db)，含启动 sweepOrphanPending）
├── llmRef: { current: TaggedLlm }     # 由本库 ai 设置构建；设置路由热切换它
├── tools: AgentTools                  # makeAgentTools(db)
├── sourceStates: Map<string, SourceState>
├── webhookRoutes: Array<{ method, path, handler }>   # 适配器装配期经 SourceRouter 登记
├── adapters: SourceAdapter[]          # 由工厂列表各造一份（实例私有态天然隔离）
└── stop(): Promise<void>              # 各信源 stop + 反向清理表（同现有语义，按空间）

SpaceHub
├── ensure(uid): Promise<Space>        # 惰性创建 + 并发去重（promise map）；懒创建即"新用户注册即可用"
├── byToken(token): Account | undefined
├── ensureAll(): Promise<void>         # 启动时遍历 **active** 账户装配（含各库 sweepOrphanPending）；停用不装配——重新启用后首请求懒装配
└── closeAll(): Promise<void>          # 关停（10s 隔离超时沿用）
```

停用**不拆空间**：空间驻留内存（定时器对空缓冲空转、开销可忽略；webhook 与会话均已按 status 拒绝），重启自然清空——显式接受，防后人当 bug。

## 状态机

- **account**：`active ⇄ disabled`（enable 可逆；无删除）。停用效果 = 登录拒 + 会话下请求 401 + webhook token 401（均经每请求 status 检查，即时生效）。
- **invite**：`unused → used`（一次性）；"过期"由 `expires_at` 判定，无状态列。
- **session**：无表——`{v, uid, tv, exp}` 签名 cookie；`exp` 过期 / `tv` 不等于账户当前值 / 账户非 active → 401。

## 校验规则（脏形态枚举预告——tasks Phase 0 逐项展开）

| 输入口 | 脏形态（null/空串/纯空白/超长/大小写/多行/特殊字符/缺席） |
|---|---|
| `username`（注册） | 空/纯空白/超长>20/控制字符/换行/emoji 单点/`A` vs `a` 唯一性/首尾空白→trim 后判定 |
| `password` | 长度<8 / 超长（上限取 200）/纯空白/含换行/unicode 全角 |
| `code`（邀请码） | 大小写归一/含空白/超长/不存在/已用/过期/重复核销竞态 |
| `token`（路径参数） | 空/超长/非 hex/大小写/URL 编码变体 |
| `sid` cookie | 无/坏签名/载荷截断/exp 过期/tv 旧/uid 不存在/账户停用 |
| 注册/登录体 | 非 JSON/缺字段/多余字段（zod strict 策略与现有一致） |
