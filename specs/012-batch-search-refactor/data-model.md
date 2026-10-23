# Data Model: 批次与检索重构（012）

> 变更摘要：**改名**（sourceType→source / sourceIdentity→identity / sourceLabel→displayName）+ **新增两列索引** + **新增一张 FTS5 虚表**。schema v4 → v6。

## 一、raw_inputs（改名 + 加索引列）

| 列 | 类型 | 变更 | 说明 |
|---|---|---|---|
| `id` | TEXT PK | 不变 | |
| `content` | TEXT NOT NULL | 不变 | **原文逐字，永不丢失**（01§5.3）；本特性**不触碰** |
| `source` | TEXT NOT NULL | **改名**（原 `source_type`） | 信源种类：chat / nc / paste / … |
| `identity_json` | TEXT NOT NULL | **改名**（原 `source_identity`） | 身份字典的 JSON 串；保留键 `displayName` |
| `received_at` | TEXT NOT NULL | 不变 | 接收时间（+08:00 墙钟） |
| `event_time` | TEXT | 不变 | 事件时间 |
| `digest_state` | TEXT NOT NULL | 不变 | pending / digesting / digested / failed |
| `raw` | TEXT | 不变 | 信源原始载荷归档列（**本特性不消费**） |
| `tokens` | TEXT | **新增** | 内容切词（jieba + 图片占位替换 + 标点过滤），**空格分隔**，仅索引用 |
| `identity_tokens` | TEXT | **新增** | 身份词袋（键名 + 值切词），**空格分隔**，仅索引用 |

**索引列不是数据**：`tokens` / `identity_tokens` 可随时从 `content` / `identity_json` 重建（`rebuildSearchIndex`）。**不得**把它们当权威值读。

## 二、raw_fts（FTS5 虚表，新增）

```sql
CREATE VIRTUAL TABLE raw_fts USING fts5(
  tokens,
  identity_tokens,
  content='raw_inputs',
  content_rowid='rowid'
);
```

**外部内容表**：`content='raw_inputs'` → FTS5 不复制内容，只存索引；`rowid` 与 `raw_inputs.rowid` 对齐。

**同步触发器**（**必须先建后插**——实测：先插后建会索引空、`MATCH` 静默落空）：

```sql
CREATE TRIGGER raw_fts_ai AFTER INSERT ON raw_inputs BEGIN
  INSERT INTO raw_fts(rowid, tokens, identity_tokens)
  VALUES (new.rowid, new.tokens, new.identity_tokens);
END;
CREATE TRIGGER raw_fts_ad AFTER DELETE ON raw_inputs BEGIN
  INSERT INTO raw_fts(raw_fts, rowid, tokens, identity_tokens)
  VALUES ('delete', old.rowid, old.tokens, old.identity_tokens);
END;
CREATE TRIGGER raw_fts_au AFTER UPDATE ON raw_inputs BEGIN
  INSERT INTO raw_fts(raw_fts, rowid, tokens, identity_tokens)
  VALUES ('delete', old.rowid, old.tokens, old.identity_tokens);
  INSERT INTO raw_fts(rowid, tokens, identity_tokens)
  VALUES (new.rowid, new.tokens, new.identity_tokens);
END;
```

## 三、identity（身份字典，保留键改名）

| 键 | 类型 | 说明 |
|---|---|---|
| `displayName` | string（非空） | **保留键**（原 `sourceLabel`）——给人看的来源名（用户在白名单里写的备注名） |
| 其余任意键 | unknown | 适配器自由扩展：`groupId` / `peer` / `sender` / 未来的 `channelId` / `author` … |

**读路径兼容**（防漏迁崩溃）：`normalizeIdentity(value)` 的取值顺序
1. `displayName`（新）
2. `sourceLabel`（旧，存量漏迁）
3. `name`（更早的旧键，D-88 之前）
4. 兜「未知来源」

**同源判据**（P-4 修复）：**除 `sender` 外的全部键**的集合相等。
- `sender` 必须排除：多人群批次按 D-91 不写 `sender`（宁缺勿谎），用它判会把同一群拆成两类。
- 不能只用 `groupId`：实测存在两个不同群共享 `groupId: 10001`。
- 不能只用 `displayName`：两个不同群备注重名 → 误判同源；同群改名 → 误判不同源。

## 四、uncertain_inputs（改名）

| 列 | 变更 |
|---|---|
| `source_type` → `source` | 改名 |
| `source_identity` → `identity_json` | 改名（保留键同样迁 `displayName`） |

其余列不变（`origin_raw_input_id` / `needs_human` / `reason` / `status` / `resolved_ref` / `created_at` / `resolved_at`）。

## 五、迁移（v4 → v5 → v6）

### v5：改名（幂等）

| 动作 | 实现 | 先例 |
|---|---|---|
| `raw_inputs.source_type` → `source` | `ALTER TABLE ... RENAME COLUMN`（先查 `PRAGMA table_info` 有旧列才做） | `renamePluginColumnIfNeeded` |
| `raw_inputs.source_identity` → `identity_json` | 同上 | 同上 |
| `uncertain_inputs.source_type` → `source` | 同上 | 同上 |
| `uncertain_inputs.source_identity` → `identity_json` | 同上 | 同上 |
| **JSON 内的保留键改名** | `json_set(identity_json, '$.displayName', json_extract(identity_json, '$.sourceLabel'))` + `json_remove(identity_json, '$.sourceLabel')`（**只动 `json_valid` 且 `json_type='object'` 的行**） | `migrateByToProvenance` / archived 迁移 |

**实测依据**：存量形状只有两种（`sourceLabel` 单键 / `groupId,sender,sourceLabel` 三键）；`json_set` 与键序无关 ✅。

**不触碰**：`raw_inputs.content`、`raw_inputs.raw`（原文与归档列原样保留）。

### v6：加索引列 + FTS5 表

| 动作 | 实现 |
|---|---|
| 加 `tokens` / `identity_tokens` 两列 | `ALTER TABLE ... ADD COLUMN`（幂等：先查列是否存在） |
| 建 `raw_fts` + 三触发器 | `CREATE VIRTUAL TABLE IF NOT EXISTS` + `CREATE TRIGGER IF NOT EXISTS` |
| **存量补索引** | 对既有行算 `tokens` / `identity_tokens` 并回填；再 `INSERT INTO raw_fts(raw_fts) VALUES('rebuild')` |

**重建的正确姿势**：`rebuild` 会从内容表重算索引 → **必须先回填两列**，否则 rebuild 出来的索引是旧的/空的。

## 六、契约层（packages/shared）

| 旧 | 新 | 备注 |
|---|---|---|
| `SourceIdentitySchema` | `IdentitySchema` | refine：「必须含非空 `displayName` 键」 |
| `SourceIdentity` | `Identity` | |
| `RawInputSchema.sourceType` | `.source` | |
| `RawInputSchema.sourceIdentity` | `.identity` | |
| `IngestRequestSchema.sourceType` / `.sourceIdentity` | `.source` / `.identity` | HTTP 边界同款 |
| `UncertainInputSchema.sourceType` / `.sourceIdentity` | `.source` / `.identity` | |
| `PipelineRunSchema.sourceType` | `.source` | |
| `PipelineRunSchema.sourceLabel` | `.displayName` | 流水列表的显示名 |
| `sourceLabelOf()` | `displayNameOf()` | 取裸串 |
| `sourceIdentityLabel()` | `displayNameWithDetails()` | 取带其余键的串 |
| `normalizeSourceIdentity()` | `normalizeIdentity()` | **兼容读**（见上） |
| `SearchRecentRawsArgsSchema` 等三个 | **删除** | 由 `SearchRawsArgsSchema` / `SearchRawsResultSchema` 取代 |

## 七、不动的实体

- `item_versions`（事项版本链）——**零变更**。
- `fragments` / `evidence` ——零变更。
- `items` 的 `tags` / `kind` / `status` ——零变更（**归属不落库**：用户定「事项不需要归属啊，有证据撑着就好了」）。
- `media` / `llm_usage` / `chat_turns` / `app_settings` / `source_settings` / `item_views` ——零变更。
