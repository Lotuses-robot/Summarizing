# Contract: `search_raws` 工具

> agent0 的只读检索工具（01§4.14：读走真代码检索，LLM 永不裸操作存储）。
> **取代** `search_recent_raws`（旧工具删除——无调用者 = 现在就不许存在）。

## 一、工具描述（写进 `TOOL_DEFS`，AI 看得到）

```
检索历史进站批次（原文档案）。支持按关键词 / 信源 / 身份键值 / 时间任意组合查询，
条件之间可取交集（mode=all）或并集（mode=any）。模糊匹配支持部分关键词
（"课群" 能命中 "英语课群"），精确匹配按 identity 的键值对查。
返回可能因过长而截断——每条带 truncated 标记与原长度，more 说明还有多少条未返回；
需要更多请缩小范围（加 source / 时间 / 关键词）或调小 limit。
```

## 二、参数（`SearchRawsArgsSchema`）

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | `string` | — | 关键词。模糊匹配（内容 + 身份键值）。**长度上限 200**，超了**直接报错**。切词后为空（全是标点）→ 返回空集（不报错） |
| `source` | `string` | — | 信源筛选：匹配 `source` 列（chat/nc/paste…），或匹配身份的显示名/群号等键值（模糊） |
| `identity` | `{ key: string; value: string }[]` | — | 身份**精确**条件（键值对）。`key` **必须走白名单**（否则报错） |
| `before` | `string` | — | 时间上界（+08:00 墙钟，如 `2026-10-21T23:59:59`）。格式非法 → 报错 |
| `after` | `string` | — | 时间下界。`before < after`（区间反了）→ 报错 |
| `mode` | `"all" \| "any"` | `"all"` | `all` = 交集（所有条件都满足）；`any` = 并集（任一条件满足）。非法值 → 报错 |
| `limit` | `number` | `20` | 返回条数上限。**最大 50**；`≤ 0` 或非整数 → 报错 |

**附加约束**（不在 schema 里、由服务端校验）：
- 时间跨度 `before - after` **不得超过 90 天** → 超了**直接报错**（防全表扫）。
- 至少给一个条件（`query` / `source` / `identity` / `before` / `after` 任一非空）→ 全空则报错（「不限条件的全量检索」不是本工具的用法）。

**边界错误一律 `throw`**（不静默改写、不静默截断——D-103）。错误文案必须说明正确用法。

## 三、返回（`SearchRawsResultSchema`）

```ts
{
  hits: [
    {
      id: string,              // 批次 id
      content: string,         // 原文（可能被截断）
      truncated: boolean,      // content 是否被截断
      contentLength: number,   // 原文真实长度（字符数）
      source: string,          // 信源种类（chat/nc/paste…）
      identity: Identity,      // 身份字典（保留键 displayName）
      receivedAt: string,      // 接收时间
      eventTime: string | null // 事件时间
    }
  ],
  more: number,   // 还有多少条命中但未返回（0 = 全部返回）
  total: number   // 命中总数（不受 limit 影响）
}
```

**不返回** `digestState`、内部字段、`raw` 归档列（与旧工具同口径）。

**截断规则**（总量预算，非每条硬砍）：
- 单次结果**总量 ≤ 2,000 字**。
- 每条正文 ≤ 150 字（摘要级）；超出的部分不返回，但 `truncated=true` + `contentLength` 如实告知。
- 装不下后续条目 → 不返回，`more` 如实计数。

**为什么标注而非静默**：静默截断会让模型基于残缺信息下结论（这是「该合的没合」的机制之一——nc 的批是行协议，400 字 ≈ 前 10 行）。

## 四、查询语义（服务端实现口径）

| 维度 | 判据 | 实现 |
|---|---|---|
| 关键词（内容） | 模糊 | `MATCH tokens`（jieba 切词 + 前缀匹配，覆盖被切碎的 2 字词） |
| 关键词（身份） | 模糊 | `MATCH identity_tokens`（词袋含键名与值） |
| `source` | 模糊 | `source` 列等值 **或** 身份词袋 MATCH |
| `identity` 精确 | 等值 | `json_extract(identity_json, '$.<key>') = ?`（**key 走白名单**） |
| 时间 | 区间 | `received_at` / `event_time` 普通列比较（+08:00 墙钟，字典序即时间序） |
| `mode=all` | 交集 | 单条 SQL 的 `AND` |
| `mode=any` | 并集 | 多条查询 `UNION`（跨字段 OR 不能靠单条 FTS5 MATCH——实测） |

**「同一来源」的判据**（工具内部的同源快捷方式）：**除 `sender` 外的全部身份键**的集合相等（`sender` 必须排除——多人群批次按 D-91 不写它）。

## 五、示例

```
# 模糊内容
search_raws({ query: "高数" })

# 模糊 + 精确 + 时间（交集）
search_raws({
  query: "高数",
  identity: [{ key: "groupId", value: "10001" }],
  after: "2026-10-01T00:00:00",
  mode: "all"
})

# 并集：内容含「高数」**或**来自 10002 群
search_raws({
  query: "高数",
  identity: [{ key: "groupId", value: "10002" }],
  mode: "any"
})

# 只按信源 + 时间倒序
search_raws({ source: "nc", before: "2026-10-22T00:00:00", limit: 50 })
```

## 六、错误文案（人话，含正确用法）

| 触发 | 文案方向 |
|---|---|
| `query` 超长 | 「关键词太长（上限 200 字）——请给更具体的关键词，或改用 source / 时间缩小范围」 |
| 时间格式非法 | 「时间格式不对——用 +08:00 墙钟串，如 2026-10-21T23:59:59」 |
| 区间反了 | 「时间区间反了——before 要晚于 after」 |
| 跨度 > 90 天 | 「时间跨度超过 90 天——请分段查，或改用 source / 关键词收窄」 |
| `limit` 越界 | 「limit 必须在 1~50 之间」 |
| `mode` 非法 | 「mode 只能是 all（交集）或 any（并集）」 |
| 身份键名不在白名单 | 「不支持按该键查——可查的键：displayName / groupId / peer / sender / sourceType」 |
| 无任何条件 | 「至少给一个条件（关键词 / 信源 / 身份 / 时间）」 |

## 七、兼容与退役

- **删除**：`search_recent_raws` 工具、`SearchRecentRawsArgsSchema`、`SearchRecentRawsResultSchema`、`RecentRawItemSchema`、`listRecentRawInputs`（若无其他调用者）。
- **不动**：`search_items`（事项）、`search_uncertain`（存疑库）——**事项就是事项**，工具不合并。
- **不新增**：`search_exact_raws`（`search_raws` 天生支持模糊与精确）。
