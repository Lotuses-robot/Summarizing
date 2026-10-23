# Feature Specification: 批次与检索重构（命名统一 + 全文检索 + 封批三闸）

**Feature Branch**: `012-batch-search-refactor`
**Created**: 2026-10-22
**Status**: Draft
**Input**: User description: "优化对批次的管理和信息分批的逻辑——现在的打包仍然很死板"；"把批次管理和信息分批逻辑修好，改好归属和身份名字逻辑，让 AI 更好地自主管理需要了解什么样的消息，能更个性化地寻找相关的事项"；"search_raws() 支持字段查询（群号、备注、内容模糊、时间），把所有结果汇总在一起"；"统一不同信息源可能的不同形状"；"工具调用返回要说明过长了"；"不需要精确查询工具，search_raws 天生支持模糊和精确"；"命名要统一——source 表示信源，identity 表示身份，剩下一个叫显式名，以后就不要动了"；"落库的分割到现在还没有决定，不过有 search 之后就会好多了，完全可以定时"。

## 背景与动机（用户原话的结构化）

本特性的动机**不是**某条具体的 bug，而是三处长期积累的不适：

1. **命名混乱**——「代码中充满了 sourceLabel、source name、各种稀奇古怪的名称，有点混乱，这是我想要修好的主要原因」。
2. **上下文窗口一直小漏**——「播了很久的问题，虽然其实并不是很重要的问题，但就是自己心里不舒服」。
3. **打包死板**——「能不能优化一下对批次的管理和信息分批的逻辑？现在的打包仍然很死板」。

其中 (1) 与 (2) 有**明确的技术根据**（见下方「问题陈述」），(3) 有**明确的功能后果**（忙群一直不封批 → 巨批 + 崩溃丢失窗口无界）。

## 问题陈述（含实测依据）

### P-1 命名：三组近义名并排，语义正交

`RawInput` 上并排着三个都叫「来源」的东西：

| 现状 | 实际语义 | 与谁最容易混 |
|---|---|---|
| `sourceType` | 哪个适配器进的（chat / nc / paste） | `sourceIdentity` |
| `sourceIdentity` | 哪条具体来源（弹性字典） | `sourceType` |
| `sourceLabel` | 字典里的「显示名」（保留键） | `identity` 本身 |

实测规模：`sourceType` 30 处、`sourceIdentity` 56 处、`sourceLabel` 60 处、`sourceLabelOf` 9 处、`sourceIdentityLabel` 8 处（另有测试 267 处）。其中 `sourceLabelOf`（取裸串）与 `sourceIdentityLabel`（取带自由键的串）**差一个词、差一整个信息量**，却在 `packages/shared` 里紧挨着。

nc 适配器内部另有一个 `groupName`——**它就是 `sourceLabel`**（`types.ts:69` 注释自陈「封批直接用作 sourceIdentity.sourceLabel」），却叫另一个名。

### P-2 上下文：六个闸门各自为政，其中一个是静默的

实测（`llm_usage`，账号 `9069368a`）：agent0 22 次调用 `prompt=125,116 / cached=84,224 → 命中 67.3%`；chat 4 次 `命中 72.2%`。每次消化的 prompt 底数 **4,635 token**（系统提示词 17,436 字节 + 本批简报）。

三次调用出现命中率骤降，定位到「prompt 较上次 +5,100 / +4,861」时命中掉到 **55% / 56%**——新增内容插在缓存前缀之后，前缀失效。

六个闸门无全局配额：`TOOL_RESULT_LIMIT=30`、`TOOL_RESULT_CONTENT_MAX=400`、`DIGEST_MAX_ROUNDS=8`、`MAX_IMAGE_FETCHES=4`、前台 `MAX_ROUNDS=4`、`CHAT_HISTORY_ITEM_MAX_CHARS=8000`。

**最刺眼的两点**：
- **400 字硬砍且静默**——`content.slice(0, 400)`，**不告诉模型被砍了**。模型据此基于残缺信息下结论（nc 的批是行协议，400 字 ≈ 前 10 行）。
- **`search_items` 完全无上限**——返回完整 `ItemSchema`；两个检索工具量控口径不一致（一个硬砍 30×400，一个无限）。

### P-3 打包：忙群永不封批，且文档承诺是假的

`dueGroups` 只判「静默 ≥ windowMinutes」（默认 3 分钟，唯一可配的是一个全局数字）。**连续说话 2 小时的群**直到出现 3 分钟静默才封批 → 缓冲里攒 2 小时的全部消息。

`docs/08-nc对接指南.md` 第 81 行承诺「**崩溃丢最近一个窗口（≤3 分钟）**的自动收取」——**连续聊天时这句是假的**，实际丢的是整段缓冲。

同时「该合的没合」无解：跨窗兄弟只能靠模型主动调 `search_recent_raws` 捞，而该工具每条只给 400 字、且「同源」判定有 bug（见 P-4）。

### P-4 「同一来源」判定两头都错

```ts
function sameIdentity(a, b) { return a["sourceLabel"] === b["sourceLabel"]; }
```

- 两个**不同**群备注成同名 → 被当同源。
- 同一个群**改了备注名** → 前后批次成不同源。

`groupId` 明明在 `sourceIdentity` 里却没参与判断；实测数据里还存在**两个不同群共享 `groupId: 10001`** 的情况 → `groupId` 单独用也不可靠。正确判据是**除 `sender` 外的全部稳定键**（`sender` 必须排除：多人群批次按 D-91 不写它，用它判会把同一群拆成两类）。

### P-5 「来源权威性」在数据里不存在

提示词要求「比来源权威性（官方群 > 班级群 > 个人转述；署名发信人 > 匿名）」，但 AI 拿到的 `sourceIdentity` 只有 `sourceLabel`（**用户自己填的备注名**）、`groupId`（群号）、`sender`（**显示名**，非身份）。**没有任何字段能判权威性**。

nc 事件里其实有 `sender.role`（owner/admin/member），但它只进了行协议前缀，**没进 `sourceIdentity`**；生产库的 `raw` 归档列有完整原始载荷（含 role / user_id），但 `buildUserBrief` 不给 AI。

用户定调：「官方性我想就靠 role，qq 和备注吧」，且「**几乎没遇到过**（矛盾），群都挑选的比较官方，现在体验还算完整」→ **不新增权威性字段/配置**（那是「为以后写铺垫」），只把提示词改弱：**权威性只能来自 identity 里实际存在的字段；无依据不得决断**。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - AI 能按任意维度自由查找历史信息 (Priority: P1)

作为 agent0，我在消化一条新信息时，能用**关键词 / 信源 / 身份键值 / 时间**任意组合去查历史进站批次——模糊与精确都行，条件之间可取交集或并集——从而找到「本批可能是某条旧信息的另一半」。

**Why this priority**: 这是本特性的核心价值。「该合的没合」的根因是 **AI 拿不到足够的上下文**（400 字硬砍 + 静默截断 + 「同源」判错 + 没有真正的字段查询），不是 AI 不会合。

**Independent Test**: 给库里放入若干批（含带图的、含多人署名的、跨天的），用 `search_raws` 工具按各维度组合查询，断言命中集正确、且被截断时返回体带截断标注。

**Acceptance Scenarios**:

1. **Given** 库里有一批正文含「高数作业」的信源批次，**When** AI 用关键词「高数」查询，**Then** 命中该批，且返回体标明命中的是内容而非身份。
2. **Given** 同一批的 `identity` 含 `groupId=10001`，**When** AI 按身份精确查 `groupId=10001`，**Then** 命中该批（不经内容匹配）。
3. **Given** 两批内容都不含「高数」，**When** AI 用 `mode=any` 组合「内容=高数」与「身份 groupId=10002」，**Then** 返回两批的并集；**When** 用 `mode=all`，**Then** 返回同时满足两者的交集（可能为空）。
4. **Given** 一批正文 3,000 字，**When** AI 查询命中它，**Then** 返回体里该条的 `content` 被截断**且带 `truncated=true` 与原长度**，不会让模型误以为看到的是全文。

### User Story 2 - 命名统一，概念不再混 (Priority: P1)

作为读代码的人，我在整个仓库里只看到三个来源概念的名字——**信源（source）**、**身份（identity）**、**显示名（displayName）**——各司其职、互不混淆；查任何来源信息都只有一个入口。

**Why this priority**: 用户明确说「我要修好的**主要原因**」是命名混乱，且「**以后就不要动了**」。名字是其他一切的地基——检索参数、迁移、文档都要用新名。

**Independent Test**: `grep` 旧名（`sourceType` / `sourceIdentity` / `sourceLabel` / `sourceLabelOf` / `sourceIdentityLabel` / `groupName`）在代码与文档中**零残留**；存量库的旧 JSON 键被迁移；新库写入的是新键。

**Acceptance Scenarios**:

1. **Given** 一个存量账户库，其 `raw_inputs.identity_json` 是 `{"sourceLabel":"英语课群",...}`，**When** 升级后启动，**Then** 库内该 JSON 已迁为 `{"displayName":"英语课群",...}`，且读路径同时兼容新旧键（漏迁的库不崩）。
2. **Given** 代码里任意一处读取来源身份，**When** 追查其定义，**Then** 全仓只有 `source` / `identity` / `displayName` 三个概念名（外加 DB 层 `identity_json`）。
3. **Given** 用户在看「来源信息」区，**When** 展开某批次，**Then** 显示名与身份键值各自独立成行（不混作一串）。

### User Story 3 - 忙群也定期切段，崩溃丢失有界 (Priority: P2)

作为用户，我的群一直有人说话时，进站仍然**定期切成有限大小的批次**，不会攒成一条几千行的巨批；进程崩溃时最多丢**有界的**一段（不是几小时）。

**Why this priority**: 直接对应「打包仍然很死板」与「忙群一直不封批」两个症状；且 docs/08 里那条假承诺必须被订正。

**Independent Test**: 模拟连续推送消息（无静默）到条数上限/字节上限/时间上限三个阈值各触发一次，断言批次被切开、每批大小有界；断言崩溃丢失窗口的文档承诺与实际一致。

**Acceptance Scenarios**:

1. **Given** 一个群连续发消息、始终无静默，**When** 消息条数达到上限，**Then** 立即封批（不等静默窗）。
2. **Given** 连续发消息但单条很长，**When** 批内字节数达到上限，**Then** 立即封批。
3. **Given** 连续发消息且未达条数/字节上限，**When** 距本批首条消息超过时间上限，**Then** 封批（忙群也定期切段）。
4. **Given** 进程在缓冲有内容时崩溃，**When** 读 docs/08 的「已知限制」，**Then** 上面写的丢失上界与实际实现一致（不再是假的「≤3 分钟」）。

### User Story 4 - 工具结果过长时明确告知 (Priority: P2)

作为 agent0，我拿到一个被截断的检索结果时，**知道它被截断了**、知道原有多长、知道还有多少条没返回——于是能自己决定是缩小范围重查、还是就按现有的部分信息行动。

**Why this priority**: 静默截断会让模型基于残缺信息下结论（这是「该合的没合」的机制之一）。用户明确要求「toolcall 的返回要好好斟酌……要说明过长了」。

**Independent Test**: 查询命中量超过单次预算，断言返回体带 `more`（未返回条数）与每条的 `truncated` / `contentLength`；断言参数越界时**直接报错**而非静默改写。

**Acceptance Scenarios**:

1. **Given** 命中 100 条，**When** 查询（默认 limit 20），**Then** 返回 20 条 + `more=80`（或等价计数）。
2. **Given** 单条内容超长，**When** 返回，**Then** 该条带 `truncated=true` 与 `contentLength`（原长度）。
3. **Given** AI 传了越界的参数（limit 超上限、时间范围跨度过大、关键词超长），**When** 服务端处理，**Then** **明确报错并说明正确用法**，不静默改写参数（D-103：不替用户改输入）。

### User Story 5 - 不同形状的信源都能被搜到 (Priority: P3)

作为以后接入一个新信源（形状与 nc 不同）的我，只要它把信息按标准边界落成 `raw_inputs`，它就**自动能被搜到**——不需要为它新写一个检索工具。

**Why this priority**: 用户原话「统一不同信息源可能的不同形状」「以后再对别的形状不同的信源做适配的时候，就可以很好的鲁棒的接纳它们」。本批不接新信源，但形状无关性要在结构上成立。

**Independent Test**: 构造一个 `identity` 键名完全不同的批次（如 `{"displayName":"X","channelId":"c-9","author":"Y"}`），断言按 `channelId` / `author` 都能搜到。

**Acceptance Scenarios**:

1. **Given** 一批的 `identity` 含非常规键 `channelId`，**When** 按 `channelId` 精确查询，**Then** 命中。
2. **Given** 一批的 `identity` 含非常规键的值，**When** 用关键词模糊查该值的一部分，**Then** 命中（身份键值进入词袋）。
3. **Given** 新信源落了一批带图的，**When** 关键词查「图片」，**Then** 命中该批（且不会因为图 URL 里的参数而产生噪音命中）。

## Edge Cases

### 边界字段脏形态（宪法「边界加固三规矩」强制枚举）

**`identity`（弹性字典）**：
| 脏形态 | 必须的处理 |
|---|---|
| `null` / 缺席 | 视为空字典 → `displayName` 缺失 → 读路径兜「未知来源」（**不编造**） |
| 裸字符串（存量遗留） | 迁为 `{displayName: 原串}` |
| 非对象（数字/数组） | 兜「未知来源」 |
| `displayName` 空串 / 全空白 | 视为缺失 |
| `displayName` 键存在但值为 null | 视为缺失；**不得**保留一个空键 |
| 键名大小写差异（`sourceLabel` vs `sourcelabel`） | 只认精确键名；旧键 `sourceLabel` 走迁移 |
| 超长值（>10KB） | 截断并留痕（防单条撑爆上下文） |
| 键名含 SQL 特殊字符 | **走白名单**，不做字符串拼接进 SQL |
| 多行值 | 词袋切词时按空白分隔，不影响 |

**`tokens` / `identity_tokens`（索引列）**：
| 脏形态 | 必须的处理 |
|---|---|
| 空串（正文全是标点/emoji） | 写空串（不写 null）——FTS5 空索引行不匹配任何查询 |
| 超长（正文 > 1MB） | 切词结果截断到上限（如 64KB），留痕 |
| 含 FTS5 保留字（`AND`/`OR`/`NOT`/`NEAR`） | **查询时逐词加引号**，避免语法错误 |
| 含双引号本身 | 引号转义（`""`） |
| 含控制字符 / 零宽字符 | 切词前剔除（否则污染 token） |

**查询参数**：
| 脏形态 | 必须的处理 |
|---|---|
| `query` 超长（>200 字） | **直接报错**（不静默截断） |
| `query` 含 FTS5 语法符号 | 逐词加引号后转义 |
| `query` 全是标点 | 切词后为空 → 返回空集（不报错） |
| `before`/`after` 格式非法（非 +08:00 墙钟） | **直接报错**（不猜） |
| `before` < `after`（区间反了） | **直接报错** |
| 时间跨度 > 90 天 | **直接报错**（防止全表扫） |
| `limit` 超上限 | **直接报错** |
| `limit` 为 0 / 负数 | **直接报错** |
| `mode` 非法值 | **直接报错** |
| 身份键名不在白名单 | **直接报错**（防注入） |

### 其他边界

- **FTS5 外部内容表**：触发器必须**先建后插**（否则索引空、`MATCH` 静默落空）。
- **`MATCH` 在 JOIN 里必须用表名**（`raw_fts match ?`），用别名会报 `no such column`。
- **中文分词**：jieba 把「高数」切成「高/数」→ 查「高数」需**前缀匹配**（`高* 数*`）；不可只依赖词典完备性。
- **图片占位**：`[图片](url)` 的 URL **不进词袋**（否则搜「rkey」会命中 QQ 图链接——纯噪音）；整体替换为「图片」。
- **迁移幂等**：迁移可重复执行，不得二次损坏数据。
- **降级运行**：旧二进制开新库（`user_version` 领先）→ 留痕、不静默。

## Requirements *(mandatory)*

### 功能需求

**命名（FR-001 ~ FR-008）**
- **FR-001**: 契约层 MUST 将 `sourceType` 更名为 `source`、`sourceIdentity` 更名为 `identity`、`sourceLabel`（保留键）更名为 `displayName`。
- **FR-002**: `SourceIdentitySchema` MUST 更名为 `IdentitySchema`，其 refine MUST 改为「必须含非空 `displayName`」。
- **FR-003**: `sourceLabelOf()` MUST 更名为 `displayNameOf()`；`sourceIdentityLabel()` MUST 更名为 `displayNameWithDetails()`。
- **FR-004**: nc 适配器内部的 `groupName` MUST 统一为 `displayName`（3 处，零契约影响）。
- **FR-005**: 读路径 MUST 同时接受旧键 `sourceLabel` 与新键 `displayName`（存量兼容，防漏迁崩溃）。
- **FR-006**: 存量 `raw_inputs` / `uncertain_inputs` 的 `identity_json` MUST 在迁移中把 `sourceLabel` 键改名为 `displayName`（幂等）。
- **FR-007**: 全仓（代码 + 文档 + 测试）MUST 不再出现旧名 `sourceType` / `sourceIdentity` / `sourceLabel` / `sourceLabelOf` / `sourceIdentityLabel` / `groupName`（`grep` 零残留）。
- **FR-008**: 文档 MUST 统一中文词：**信源** = `source`、**身份** = `identity`、**显示名** = `displayName`（不再混用「来源身份/来源标签」）。

**检索（FR-010 ~ FR-020）**
- **FR-010**: MUST 新增全文索引：FTS5 虚表，索引 `raw_inputs` 的**内容切词**与**身份词袋**两列。
- **FR-011**: 内容切词 MUST 使用 jieba（nodejieba）；切词 MUST 剔除标点、单字符、控制字符。
- **FR-012**: 图片占位 `[图片](url)` MUST 在切词前整体替换为「图片」；URL **不得**进入词袋。
- **FR-013**: 身份词袋 MUST 由 `identity` JSON 的**键名与值**共同构成（形状无关——任何信源的键都在袋里）。
- **FR-014**: MUST 提供 `search_raws` 工具，支持维度：`query`（内容/身份模糊）、`identity`（键值精确）、`source`（信源）、`before`/`after`（绝对墙钟区间）、`mode`（`all`=交集 / `any`=并集）、`limit`。
- **FR-015**: 模糊查询 MUST 通过切词后的 MATCH 实现（支持前缀匹配，覆盖被切碎的 2 字词）；精确查询 MUST 通过 `json_extract` 等值实现。
- **FR-016**: `mode=any`（并集）跨字段时 MUST 用 SQL UNION 实现（实测：跨字段 OR 不能靠单条 FTS5 MATCH）。
- **FR-017**: 精确查询的**键名 MUST 走白名单**（不得把用户/模型给的键名直接拼进 SQL）。
- **FR-018**: `search_recent_raws` MUST 被删除（无调用者 = 现在就不许存在）；`search_items` / `search_uncertain` 本轮不动。
- **FR-019**: 检索结果 MUST 标注截断：每条带 `truncated` 与 `contentLength`；整体带 `more`（未返回条数）。
- **FR-020**: 单次工具结果**总量 MUST ≤ 2,000 字**（取代「每条硬砍 400 字」）；单条摘要 ≤ 150 字；装不下的条目不返回但 MUST 告知。
- **FR-021**: 参数越界 MUST **直接报错并说明正确用法**（D-103：不替用户改输入、不静默截断参数）。

**封批（FR-030 ~ FR-034）**
- **FR-030**: nc 封批 MUST 有三个独立闸门，任一命中即封批：**条数上限**、**字节上限**、**时间上限**（距本批首条消息）。
- **FR-031**: 「静默窗」MUST 降级为四者之一（`windowMinutes` 语义变更：从「合批窗」变成「静默触发条件」），且 MUST 写进 01 规格与 docs/08。
- **FR-032**: docs/08 的「崩溃丢失」承诺 MUST 订正为**实际的上界**（原「≤3 分钟」在连续聊天时为假）。
- **FR-033**: 封批三闸的默认值 MUST 可配（沿用 `windowMinutes` 的即时生效、不重启语义）。
- **FR-034**: 封批 MUST 保持 D-91 的行协议保真与「空批守卫」语义不变。

**提示词与上下文（FR-040 ~ FR-044）**
- **FR-040**: 提示词【检索面】段 MUST 改写为 `search_raws`，并讲清并/交语义与截断标注。
- **FR-041**: 提示词【矛盾决断】段 MUST 改弱：权威性**只能**来自 `identity` 里实际存在的字段；**无可依据字段时不得决断**（一律入库）——不得要求 AI 去比一个数据里不存在的属性。
- **FR-042**: `buildUserBrief` MUST 继续逐字给出 `identity`（含新键名）。
- **FR-043**: 系统提示词大小 MUST 有上限意识——本轮不重写提示词，但 MUST 记录其实测基线（17,436 字节 / ≈4,635 token）以便后续。
- **FR-044**: `search_items` 的无上限返回 MUST 在本轮**记录**（不修），作为后续项进 03-开放问题。

**依赖与部署（FR-050 ~ FR-053）**
- **FR-050**: `apps/server` MUST 依赖 `nodejieba`。
- **FR-051**: Dockerfile MUST 在构建阶段具备 node-gyp 工具链（`python3` / `make` / `g++`），且 MUST 允许 nodejieba 的编译脚本运行。
- **FR-052**: `scripts/build-release.mjs` MUST 精简拷贝 nodejieba 的运行时产物（`.node` + 词典），随便携包分发。
- **FR-053**: CI MUST 能构建 nodejieba（windows runner）。

**迁移（FR-060 ~ FR-063）**
- **FR-060**: schema 版本 MUST 递增（v4 → v5 改名；v5 → v6 加索引列与 FTS5 表），走既有 `migrate.ts` 版本门控（迁移前自动备份 + 幂等 DDL + 存量变换）。
- **FR-061**: 列改名 MUST 幂等（参照 `renamePluginColumnIfNeeded` 先例）。
- **FR-062**: `identity_json` 内的保留键改名 MUST 用 `json_set` + `json_remove` 实现（幂等），且 MUST 只动确为对象的行。
- **FR-063**: 迁移 MUST NOT 触碰 `raw_inputs.content`（原文逐字不可变）与 `raw` 归档列。

### 关键实体

- **RawInput（进站批次）**：`id` / `content`（原文逐字，永不变）/ `source`（信源种类，chat|nc|paste|…）/ `identity`（身份字典，含 `displayName`）/ `receivedAt` / `eventTime` / `digestState` / `raw`（归档列）/ `tokens`（内容切词，索引用）/ `identity_tokens`（身份词袋，索引用）。
- **Identity（身份字典）**：弹性字典；保留键 `displayName`（显示名）；其余键由适配器自由扩展（`groupId` / `peer` / `sender` / 未来任意键）。
- **SearchHit（检索命中）**：批次 id / 内容（可能截断）/ `truncated` / `contentLength` / `source` / `identity` / `receivedAt` / `eventTime`。
- **SearchCondition（检索条件）**：维度 + 值 + 布尔关系（交集/并集）。

## Success Criteria *(mandatory)*

### 可测结果

- **SC-001**: 旧名在代码与文档中 `grep` 命中数为 **0**（`sourceType`/`sourceIdentity`/`sourceLabel`/`sourceLabelOf`/`sourceIdentityLabel`/`groupName`）。
- **SC-002**: 存量库升级后，`identity_json` 内**不再出现** `"sourceLabel"` 键；且用只含旧键的 JSON 直读不抛错（兼容读路径生效）。
- **SC-003**: `search_raws` 命中集在**同列 AND/OR、跨字段 AND、UNION 并集、时间区间、身份精确**五种组合下均正确（各有断言）。
- **SC-004**: 身份**部分匹配**可用——搜「课群」能命中 `displayName="英语课群"` 的批次（实测未切词的 JSON 列搜不到，这是本特性的验收点）。
- **SC-005**: 图片占位的 URL **不产生**噪音命中（搜「rkey」「multimedia」命中数为 0）；搜「图片」能命中含图批次。
- **SC-006**: 单次工具结果返回体**总量 ≤ 2,000 字**；命中超量时带 `more`；被截断的条带 `truncated=true` 与原长度。
- **SC-007**: 参数越界**全部报错**（不留静默改写路径）；错误信息含正确用法。
- **SC-008**: 连续推送（无静默）时，nc 在**条数/字节/时间**三个上限各自触发封批；任一批的条数与字节数有界。
- **SC-009**: `npm run check` / `npm run check:dead` / `npm run build -w @summarizing/web` 全绿；便携包构建产出且含 nodejieba 运行时产物；Docker 镜像构建通过。
- **SC-010**: 现有 632 条测试在改名后**全绿**（断言改到新名，行为不变）。

## Assumptions

- **模型上下文窗口** = `deepseek-flash`（实测配置），按 32K–64K 保守估；单次消化总量预算 30,000 字。
- **nodejieba 走源码编译**（无 prebuilds）：本地 Windows、CI windows runner、Docker build 阶段三处都要能编；**用户已确认按此方案**。
- **jieba 词典不完备是可接受的**——靠前缀匹配兜底（实测「高数」被切成「高/数」，`高* 数*` 仍命中）。
- **拼音不做**——搜索者是 AI 不是用户，拼音服务的是「用户用读音搜」。
- **不合并检索工具**——`search_items`（事项）与 `search_uncertain`（存疑）本轮不动；事项就是事项。
- **不强制统一返回结构**——只统一「定位口径」，各工具保留自己的返回形状。
- **不做「跨表按元素反查批次」**——跨 `fragments`→`evidence`→`item_versions.snapshot` 三表反查复杂度高；FTS5 搜内容 + `search_items` 搜事项已覆盖主要场景。
- **不做知识库检索**（`search_kb` 恒空，01§4.9）。
- **落库分割与检索同批做**（用户定：「一起吧，都是紧密相关的」）。
