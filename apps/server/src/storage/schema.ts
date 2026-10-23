import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 表结构与 packages/shared 的 zod schema 一一对应（00-数据契约）。
// kb 表不建——知识库 S3 才落地（D-53），不写没有调用者的东西。

// 事项版本链（00 契约 §五）：追加式，snapshot 为该版本的完整事项内容。
// 当前视图 = 每个 item_id 取最后一个版本（撤回 = 追加 revert_version 节点，派生不变，D-77）。
export const itemVersions = sqliteTable(
  "item_versions",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull(),
    action: text("action").notNull(), // create_item / update_item / park_uncertain / …
    detail: text("detail").notNull(), // 面向用户的一句话（处理记录直接展示）
    snapshot: text("snapshot").notNull(), // JSON: {elements, tags, status, kind, doubtNote}
    at: text("at").notNull(),
    by: text("by").notNull(), // 含模型标识
    revokedBy: text("revoked_by"), // 预留未用（撤回功能暂缓，D-79）
  },
  (t) => [index("item_versions_item_idx").on(t.itemId, t.at)],
);

export const fragments = sqliteTable(
  "fragments",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    rawInputId: text("raw_input_id").notNull(),
  },
  (t) => [index("fragments_hash_idx").on(t.contentHash)],
);

export const evidence = sqliteTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull(),
    subject: text("subject").notNull().default("元素:name"), // 支撑对象：元素:<label>（D-62）
    fragmentId: text("fragment_id").notNull(),
    pointer: text("pointer"), // URL/路径/消息 ID，有就填
    capturedAt: text("captured_at").notNull(),
    capturedBy: text("captured_by").notNull(), // 含模型标识（01§4.4）
  },
  (t) => [index("evidence_item_idx").on(t.itemId)],
);

export const rawInputs = sqliteTable("raw_inputs", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  source: text("source").notNull(),
  identity: text("identity_json").notNull(), // JSON 串（弹性字典，D-84）
  receivedAt: text("received_at").notNull(),
  eventTime: text("event_time"),
  digestState: text("digest_state").notNull().default("pending"), // pending | digesting | digested | failed
  raw: text("raw"), // 信源原始载荷 JSON 留底（D-84；shared RawInput 类型不含它——归档字段，仅 DB）
  // 检索索引列（D-127）：raw_fts 是**独立的** FTS5 表，写入由 repo.insertRawInput 显式完成
  // （不用触发器——原因见 db.ts）。NULL = 建表前的存量行，由启动时的 backfillSearchIndex 补齐。
  tokens: text("tokens"), // 内容切词（search/tokenize.ts）
  identityTokens: text("identity_tokens"), // 身份词袋（键名 + 值）
});

// 事项已读标记（用户 2026-09-27：「新」微标点开即消）：item 级一面标记，不进版本链/编辑列表。
// 行的恢复靠版本链，这张表只服务「新」微标与通知已读。
export const itemViews = sqliteTable("item_views", {
  itemId: text("item_id").primaryKey(),
  viewedAt: text("viewed_at").notNull(), // 只写不读：留痕定位（何时打开），查询只走 itemId
});

// 应用设置（05§五 设置面板）：哑 KV——值是 JSON 字符串，形状归调用方（schema 住使用它的边界）。
// 当前只有 key="ai"（本账户 AI 接入，006 起每人自带 key、不再有 .env 兜底）。系统策略永远进代码，这里只放用户偏好。
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// 信源设置 KV（D-84/D-88）：core 只管存取不解释内容——形状归信源自己（白名单/窗长/开关等）。
// 与 app_settings 分表：所有权不同（应用级偏好 vs 信源命名空间），互不踩键。
export const sourceSettings = sqliteTable(
  "source_settings",
  {
    source: text("source").notNull(), // 源的唯一短名（nc / …）
    key: text("key").notNull(), // 信源自定义（groups / windowMinutes / …）
    value: text("value").notNull(), // JSON 串
  },
  (t) => [primaryKey({ columns: [t.source, t.key] })],
);

// 存疑信息库（D-85）：拿不准的原始信息落此，不生成事项、不挂候选。
// 信息层池子——原话逐字 + 信源快照（供接近度匹配）+ 时刻 + 来源批次引用 + 需人工分 + 状态。
export const uncertainInputs = sqliteTable(
  "uncertain_inputs",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull(), // 原话逐字
    source: text("source").notNull(),
    identity: text("identity_json").notNull(), // JSON 串（弹性字典快照）
    eventTime: text("event_time"),
    receivedAt: text("received_at").notNull(),
    originRawInputId: text("origin_raw_input_id"), // 从哪个批次摘出
    needsHuman: text("needs_human").notNull(), // 0-100（SQLite 存整数；drizzle 读回 number）
    reason: text("reason").notNull(), // 一句理由
    status: text("status").notNull().default("open"), // open | merged | discarded
    resolvedRef: text("resolved_ref"), // 升格去向
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (t) => [index("uncertain_status_idx").on(t.status, t.needsHuman)],
);

// 对话轮次（L16：解决「刷新/换设备对话即失」——原来会话只在浏览器内存）。
// 一条 = 一轮对话的一半（user 或 assistant）——最简形状，够「读回」用。
export const chatTurns = sqliteTable(
  "chat_turns",
  {
    id: text("id").primaryKey(),
    role: text("role").notNull(), // user | assistant
    content: text("content").notNull(),
    at: text("at").notNull(),
  },
  (t) => [index("chat_turns_at_idx").on(t.at)],
);

// 图片媒体缓存（009）：文件在 data/media/<uid>/<sha256>.<ext>，本表只存元数据与生命周期。
// expires_at 是**唯一**生命周期字段（用户 2026-10-20 定「只要一个 expiredate」）：
//   入库 → 基础留存（大小反向 7–14 天）；读过未被引用 → 缩短到 3 天；被证据引用 → 抬到 90 天。
// origin_url 供原文占位反查（上传图的占位就是 /api/media/<id>，直接按主键命中，此列为 null）。
export const media = sqliteTable(
  "media",
  {
    id: text("id").primaryKey(), // sha256（内容寻址，天然去重）
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    originUrl: text("origin_url"), // 信源图片的原始 URL；上传图为 null
  },
  (t) => [index("media_expires_idx").on(t.expiresAt), index("media_origin_idx").on(t.originUrl)],
);

// LLM 用量（010）：每次**成功**调用一行——活动栏左下角「用量」仪表盘据此聚合。
// 三列都是**服务商原始值**（prompt_tokens 含缓存部分）；「未命中输入」在聚合时算（shared UsageSummary）。
// cached_tokens 只在服务商返回时写；NULL = 未提供（不许用 0 冒充）。
export const llmUsage = sqliteTable(
  "llm_usage",
  {
    id: text("id").primaryKey(),
    at: text("at").notNull(), // 北京墙钟（字符串序 = 时间序，范围查询直接比前缀）
    actor: text("actor").notNull(), // agent0（消化）| chat（前台）
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    cachedTokens: integer("cached_tokens"),
  },
  (t) => [index("llm_usage_at_idx").on(t.at)],
);

// 仅承载「批次级」流水（消化完成/失败/围栏放弃/落笔动作/agent0 轨迹）——
// 事项的历史在 item_versions（版本链），两者职责不同（specs/004 正名：原 replay_nodes）。
export const pipelineEvents = sqliteTable(
  "pipeline_events",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id").notNull(), // 挂靠的批次 id（raw_inputs.id）
    action: text("action").notNull(),
    detail: text("detail").notNull(), // 面向用户的一句话（01§4.6 禁内部堆栈）
    payload: text("payload"), // JSON 字符串，可空
    at: text("at").notNull(),
    by: text("by").notNull(), // 含模型标识
  },
  (t) => [index("pipeline_entity_idx").on(t.entityId)],
);
