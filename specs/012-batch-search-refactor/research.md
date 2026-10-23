# Technical Research: 批次与检索重构（012）

> 全部结论均为**本机实测**（Node 22 / better-sqlite3 13 / SQLite 3.53.4），不是凭印象。

## 一、FTS5 能力实测

### 1.1 系统自带分词器对中文无效

| 分词器 | 「高数」/「作业」（2 字） | 「高等数学」（4 字） |
|---|---|---|
| `unicode61` | ❌ 不切词，整段当一个 token | ❌ |
| `trigram` | ❌ 需 3 字符 | ✅ |

→ **系统自带 FTS5 不能直接用于中文检索**。但这**不等于**「FTS5 不可用」——外部词典预处理正是 FTS5 的设计用法。

### 1.2 应用层切词后，unicode61 完美工作

```
tokens 列（jieba 切好、空格分隔）：
  MATCH '高数'      → 命中
  MATCH '高数*'     → 命中
  MATCH '第三章*'   → 命中
  MATCH '地点 变更' → 命中（多词 AND）
```

**结论**：切词在应用层做，FTS5 只索引已切好的 token —— 标准用法，无需 ICU 扩展。

### 1.3 一个表同时支持模糊（MATCH）与精确（普通列等值）

```sql
CREATE VIRTUAL TABLE raw_fts USING fts5(tokens, identity_json,
  content='raw_inputs', content_rowid='rowid');

-- 模糊
SELECT rowid FROM raw_fts WHERE raw_fts MATCH '高数*';
-- 精确（普通列）
SELECT rowid FROM raw_fts WHERE group_id = '10001';
-- 精确（JSON 取键）
SELECT r.id FROM raw_inputs r JOIN raw_fts ON raw_fts.rowid = r.rowid
 WHERE json_extract(r.identity_json, '$.groupId') = '10001';
-- 组合（实测命中）
WHERE raw_fts MATCH '高数' AND json_extract(r.identity_json,'$.groupId')='10001'
  AND r.received_at >= '2026-10-21T00:00:00';
```

查询计划：`SCAN raw_fts VIRTUAL TABLE INDEX 0:M3 | SEARCH r USING INTEGER PRIMARY KEY (rowid=?)` → **走索引**。

### 1.4 JSON 列可直接进 FTS5（**修正上一轮的错判**）

```
MATCH '英语课群'  → 命中
MATCH '10001'     → 命中
MATCH '学习委员'  → 命中
MATCH 'sourceLabel' → 命中（键名也能搜到）
```

JSON 的标点只是分隔符，不影响词命中。

### 1.5 但 JSON 原文不切词 → 部分匹配失效

```
MATCH '课群'    → 0 命中   （「英语课群」的内部子串，搜不到）
MATCH '英语课群' → 命中
```

→ **身份必须做词袋**（键名 + 值切词后拼一起）。词袋化的额外好处：任何信源形状都自动可搜（键值都在袋里）。

### 1.6 布尔运算

| 场景 | 写法 | 实测 |
|---|---|---|
| 同列 AND | `MATCH '高数 AND 作业'` | ✅ |
| 同列 OR | `MATCH '高数 OR 闭馆'` | ✅ |
| 跨字段 AND | `MATCH ? AND json_extract(...) = ?` | ✅ 单条 SQL |
| 跨字段 OR | 两条查询 `UNION` | ✅（跨列 OR 不能靠单条 FTS5 MATCH） |

### 1.7 两个必踩的坑（实测）

| 坑 | 现象 | 解法 |
|---|---|---|
| `MATCH` 在 JOIN 里用别名 | `no such column: f` | 必须用**表名**：`raw_fts match ?` |
| 外部内容表触发器**先插后建** | 索引空、`MATCH` **静默落空**（不报错） | 触发器**必须先建** |

## 二、分词方案选型

| 方案 | 结论 |
|---|---|
| `jieba@1.0.0`（npm） | ❌ **空壳包**——`package.json` 声明 `main: index.js` 但文件不存在，装了也 require 失败 |
| `nodejieba@3.5.8` | ✅ 可用。实测安装成功（`build/Release/nodejieba.node` 452KB），**无 prebuilds → 走 node-gyp 源码编译** |
| ICU 扩展 | ❌ 效果更好但需第三方 `.so`（Docker/便携包/CI 三处都要带）—— 运维负担，非应用层能兜 |
| 2-gram 自研 | ✅ 零依赖、覆盖 2 字词；但需自研切分器，词典质量不如 jieba |

**用户拍板：nodejieba。**

### 2.1 nodejieba 实测切词质量

```
"明天交高数作业"        → ["明天","交","高","数","作业"]
"图书馆闭馆时间调整"      → ["图书馆","闭馆","时间","调整"]      ✅
"数据结构课上课地点变更"  → ["数据结构","课","上课","地点","变更"]  ✅
"记一下周五之前要交第三章的作业" → ["记","一下","周五","之前","要","交","第三章","的","作业"]  ✅
"[10-01] 学习委员: 作业改到周五" → 标点被切碎（需调用方过滤）
```

### 2.2 已知弱点与兜底

| 弱点 | 兜底 |
|---|---|
| 「高数」被切成「高/数」（`insertWord` 实测**未生效**） | FTS5 **前缀匹配**：`MATCH '高* 数*'` 实测命中 ✅ |
| 标点被切碎 | 调用方过滤（只保留中文/字母/数字） |
| URL 被逐字符切碎 | 图片占位整体替换为「图片」、URL 不入词袋 |

## 三、缓存实测（`llm_usage`，账号 9069368a）

| 指标 | 值 |
|---|---|
| agent0 22 次调用 | `prompt=125,116 / cached=84,224` → **命中 67.3%** |
| chat 4 次调用 | `prompt=14,705 / cached=10,624` → **命中 72.2%** |
| 每次消化 prompt 底数 | **4,635 token**（系统提示词 17,436 字节 + 简报） |
| 命中率骤降点 | prompt 较上次 **+5,100 / +4,861** 时 → 命中掉到 **55% / 56%** |

**成因**：新增内容插在缓存前缀之后 → 前缀失效。

**「12:41 那批」的真相**（本轮查清，修正上一轮的说法）：那 13 次调用是**5 个不同批次并行消化**（`4161bb20`/`2e039cc5`/`2b694345`/`53d6efe8`/`e04aac94` 同时在跑，各 2~3 轮），**不是同一批的多轮**。所以：
- **批内**：每轮重发完整历史（业界标准做法，用户已定「按正常的业界推理链条」）——这是连贯推理链的前提，不改。
- **跨批**：并发批次抢同一段系统提示词前缀 → 这是**另一个问题**，靠改布局解决不了（除非串行化消化）。**本特性不处理**，记录在案。

**截断预算的依据**：prompt 涨 5,000 token 时命中掉到 55% → 单次工具结果总量取 **2,000 字**（≈3,000 token）以内，前缀增量小、缓存稳。

## 四、性能实测（LIKE 与 FTS5）

| 场景 | 结果 |
|---|---|
| 20 万行 LIKE + 时间 + 来源 + 排序 + limit 30 | **31ms** |
| 50 万行 LIKE 全表扫 | **36ms** |
| FTS5 MATCH + json_extract + 时间（查询计划） | 走 `VIRTUAL TABLE INDEX` |

→ 性能不是瓶颈；真正的风险是「不限时间范围 + 宽泛关键词」返回海量行 → `LIMIT` + 总量预算 + 参数报错足够。

## 五、存量数据实测（迁移依据）

三个库（`data/users/9069368a`、`data/users/2fb29e12`、`data/summarizing`）的 `identity` JSON：

- **键集合**：`["sourceLabel", "groupId", "sender"]`
- **形状**：`["sourceLabel", "groupId,sender,sourceLabel"]`（两种：单键 / 三键）
- 无非法 JSON、无 null

→ 迁移需处理：①只有 `sourceLabel` 的行；②`groupId,sender,sourceLabel` 的行（**键序不同**，`json_set`+`json_remove` 与顺序无关 ✅）。

**生产库的 `raw` 归档列有内容**（本地全是演示数据、全 `null`）→ nc 的 `sender.role` / `user_id` 等信息在生产库里存在，但**本特性不消费**（用户定调：不新增权威性字段，只把提示词改弱）。

## 六、依赖与部署实测

| 项 | 实测 |
|---|---|
| `jieba@1.0.0` | ❌ 空壳包（`main: index.js` 不存在） |
| `nodejieba@3.5.8` | ✅ 装成功、编出 `.node`、无 prebuilds |
| Docker 构建阶段 | `node:22-slim` + `npm ci --ignore-scripts` → **不跑编译** → nodejieba 缺 `.node`（**必须处理**） |
| 便携包 | `build-release.mjs` 已有 better-sqlite3 / sharp 的精简拷贝先例 → nodejieba 同款 |
| CI | windows runner 有 VS 工具链，可编 |
