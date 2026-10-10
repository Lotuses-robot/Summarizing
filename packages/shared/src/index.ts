import { z } from "zod";

// ──────────────── 本地墙钟时间（D-64，格式单一来源）────────────────
// 全库统一 `YYYY-MM-DDTHH:mm:ss`（北京时间墙钟，无时区标记）。
// 本 schema 同时是类型定义与运行时校验（类型即校验，2026-09-25 定）。

export const localWallClockSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?)?$/,
    "本地墙钟格式：YYYY-MM-DDTHH:mm:ss（无时区标记）",
  )
  .refine((t) => {
    // Date.parse 会把 2026-02-30 静默进位成 3-02、把 24:00 进位成次日——
    // 必须回读比对，拒绝「不存在的日期」（错误日期比没日期危险，01§4.2）
    const norm = t.includes("T") ? t : `${t}T00:00:00`;
    const d = new Date(norm);
    if (Number.isNaN(d.getTime())) return false;
    const [datePart = "", timePart = ""] = t.split("T");
    const [y = "", mo = "", da = ""] = datePart.split("-");
    if (d.getFullYear() !== Number(y)) return false;
    if (d.getMonth() + 1 !== Number(mo)) return false;
    if (d.getDate() !== Number(da)) return false;
    if (timePart !== "") {
      const [h = "", mi = ""] = timePart.split(":");
      if (d.getHours() !== Number(h)) return false;
      if (d.getMinutes() !== Number(mi)) return false;
    }
    return true;
  }, "不是真实存在的日期时间（如 2月30日）");

// ───────────────────────── 事项（Item）─────────────────────────
// 唯一节点（00-数据契约 §三）：内容全是元素；tags/status/doubtNote 是独立字段，不是元素。

/** 事项的内容载体：label = 元素名（"name"/"dueDate"/"summary"/自由自拟），text = 内容，note = 补充说明（推断依据等）。 */
export const ElementSchema = z
  .object({
    label: z.string().min(1),
    text: z.string(),
    note: z.string().nullable().optional(), // 说明/推断依据——可查回，UI 可区分
  })
  .superRefine((el, ctx) => {
    // 类型即校验（D-64）：dueDate 元素的 text 必须是本地墙钟
    if (el.label === "dueDate") {
      const parsed = localWallClockSchema.safeParse(el.text);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["text"],
          message: "dueDate 必须是本地墙钟格式（YYYY-MM-DDTHH:mm:ss）",
        });
      }
    }
    // 语义名禁裸日期的语义：name 元素非空
    if (el.label === "name" && el.text.trim() === "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "name 不得为空" });
    }
  });
export type Element = z.infer<typeof ElementSchema>;

/** 固定元素名集合——⚠️ 易漏改的脆弱点：加/删固定元素时必须同步 elementSchema 衍生分支、
 *  UI 固定渲染顺序、本集合（三处，见 00-数据契约 §三维护规则）。 */
export const FIXED_LABELS = ["name", "dueDate", "summary"] as const;
export type FixedLabel = (typeof FIXED_LABELS)[number];

/** 信息元素证据的支撑对象标识（D-62）——拼接逻辑收敛于此，避免前缀各写各的而静默失联。 */
export function elementSubject(label: string): string {
  return `元素:${label}`;
}

export const ItemSchema = z
  .object({
    id: z.string(),
    elements: z.array(ElementSchema),
    tags: z.array(z.string().min(1)), // 归类（独立字段，不挂证据）
    status: z.enum(["todo", "done", "archived"]), // 处置状态（archived 于 D-83 启用；shelved 仍预留）；过期 = 派生
    doubtNote: z.string().nullable(), // 非 null = 存疑中（01§4.12；判据从严 D-59）
  })
  .superRefine((item, ctx) => {
    // 语义名必须恰好一个（禁裸日期的结构保证，01§4.1）
    const names = item.elements.filter((e) => e.label === "name");
    if (names.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["elements"],
        message: `必须恰好有一个 name 元素（当前 ${names.length} 个）`,
      });
    }
  });
export type Item = z.infer<typeof ItemSchema>;

/** 事项版本快照的形状（版本链存储单元，00 契约 §五）。 */
export const ItemSnapshotSchema = z.object({
  elements: z.array(ElementSchema),
  tags: z.array(z.string().min(1)),
  status: z.enum(["todo", "done", "archived"]),
  doubtNote: z.string().nullable(),
});
export type ItemSnapshot = z.infer<typeof ItemSnapshotSchema>;

/** 取 dueDate 元素整体（text + note 一次拿全；缺席 = null）——四处手搓 find 的收敛出处。 */
export function dueDateElement(item: Item): Element | null {
  return item.elements.find((e) => e.label === "dueDate") ?? null;
}

/** 事项的 ddl（dueDate 元素缺席 = null）。 */
export function itemDueDate(item: Item): string | null {
  return dueDateElement(item)?.text ?? null;
}

/** 事项的语义名（name 元素的 text）。语义名三处收敛于此（L12）：app 路由 / agent0 执行器 / web 看板共用。
 *  缺 name 兜底占位（schema 保证创建时有，防半构造对象显示空白）。 */
export function itemName(elements: { label: string; text: string }[]): string {
  return elements.find((e) => e.label === "name")?.text ?? "（无名事项）";
}

/** ddl 相对当下的自然语言（05§三）：不足 2 天按小时、其余按天；过去如实「已过期」。
 *  非法日期返回 null（调用方隐藏相对时间，不编造）。 */
export function relativeDueText(ddl: string, now: Date): string | null {
  const ts = new Date(ddl).getTime();
  if (Number.isNaN(ts)) return null;
  const diff = ts - now.getTime();
  const abs = Math.abs(diff);
  if (abs < 2 * 24 * 60 * 60_000) {
    // 小时档：未来向上取整（催 Urgency）、过去向下取整（不夸大过期时长）
    const h =
      diff >= 0
        ? Math.max(1, Math.ceil(abs / 3_600_000))
        : Math.max(1, Math.floor(abs / 3_600_000));
    return diff >= 0 ? `还有 ${h} 小时` : `已过期 ${h} 小时`;
  }
  const d = diff >= 0 ? Math.ceil(abs / 86_400_000) : Math.floor(abs / 86_400_000);
  return diff >= 0 ? `还有 ${d} 天` : `已过期 ${d} 天`;
}

// ───────────────────────── 证据（§五：统一的引用边）─────────────────────────
// subject 一律 `元素:<label>`——固定元素与自由元素同一规则，无裸名 subject。

/** 证据来源 = 某事项的某元素 → 原文快照（片段池）/ 知识（S3）。 */
export const EvidenceSourceSchema = z.object({
  id: z.string(),
  itemId: z.string(), // 这条证据属于哪个事项
  subject: z.string().min(1), // 支撑对象：`元素:<label>`（固定或自由，同层自由标签）
  fragmentId: z.string(), // → 片段池（原文快照）
  pointer: z.string().nullable(), // URL / 文件路径 / 消息 ID；不独立作为证据存在
  capturedAt: z.string(), // 抓取时间 ISO
  capturedBy: z.string(), // 由谁，含模型标识
});
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

/** 片段池：原文快照按内容哈希去重（01§4.4）。contentHash 用于去重。 */
export const FragmentSchema = z.object({
  id: z.string(),
  content: z.string().min(1),
  contentHash: z.string(),
  rawInputId: z.string(), // 追溯到批次
});
export type Fragment = z.infer<typeof FragmentSchema>;

// ───────────────────────── RawInput（01§5.3）─────────────────────────

export const DigestState = z.enum(["pending", "digesting", "digested", "failed"]); // 未消化 / 消化中 / 已消化 / 未处理
export type DigestState = z.infer<typeof DigestState>;

/** 消化工具循环最大轮数（超出即判失败）——server 硬约束与流水视图轮次进度条共用单一出处。 */
export const DIGEST_MAX_ROUNDS = 8;

/** 来源身份：**弹性字典**（D-84）——core 契约只约束「是对象 + 保留键 sourceLabel（非空）」，
 *  适配器自由扩展（QQ 有群/发信人、邮件有发件地址、网页有站点名）；整体 JSON.stringify 进 agent0 提示词。
 *  保留键 `sourceLabel`（D-88 由 `name` 改名）= 给人看的文本来源，区别于 `groupId` 类 id 字段。
 *  存量字符串由读路径防御性解析为 { sourceLabel: 原串 }（不重置库）。 */
export const SourceIdentitySchema = z
  .record(z.string(), z.unknown())
  .refine((v) => typeof v["sourceLabel"] === "string" && v["sourceLabel"].trim() !== "", {
    message: "sourceIdentity 必须含非空 sourceLabel 键（来源身份的最低要求）",
  });
export type SourceIdentity = z.infer<typeof SourceIdentitySchema>;

export const RawInputSchema = z.object({
  id: z.string(),
  content: z.string().min(1), // 原始文本，永不丢失
  sourceType: z.string(), // chat / paste / nc / …
  sourceIdentity: SourceIdentitySchema, // 来源身份——推理依据 + 外发粒度 + 矛盾取舍的官方性判据（D-84）
  receivedAt: z.string(), // 接收时间（本地墙钟）
  eventTime: z.string().nullable(), // 事件时间（事情发生时）；相对日期按它锚定
  digestState: DigestState,
});
export type RawInput = z.infer<typeof RawInputSchema>;

/** ingest 请求体（HTTP 边界校验用同一份 schema）。 */
export const IngestRequestSchema = z.object({
  content: z.string().min(1),
  sourceType: z.string().min(1),
  sourceIdentity: SourceIdentitySchema,
  eventTime: z.string().nullable().default(null),
});
export type IngestRequest = z.infer<typeof IngestRequestSchema>;

/** 存量迁移/防御解析：字符串身份 → 弹性字典 { sourceLabel: 原串 }；对象原样（不重置库）。
 *  对象只带旧保留键 name（迁移漏网/手改库）→ 把 name 升为 sourceLabel（别把来源整个丢成「未知来源」）。
 *  DB 的 source_identity 列在迁移前可能是裸字符串，读路径统一过它。 */
export function normalizeSourceIdentity(value: unknown): SourceIdentity {
  const parsed = SourceIdentitySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // 裸字符串（存量）→ { sourceLabel: 原串 }；其他坏形状 → 兜底 sourceLabel
  if (typeof value === "string" && value.trim() !== "") return { sourceLabel: value };
  if (typeof value === "object" && value !== null) {
    const name = Object.entries(value).find(
      ([k, v]) => k === "name" && typeof v === "string" && v.trim() !== "",
    );
    if (name !== undefined && typeof name[1] === "string") {
      const rest = Object.fromEntries(Object.entries(value).filter(([k]) => k !== "name"));
      return { sourceLabel: name[1], ...rest };
    }
  }
  return { sourceLabel: "未知来源" };
}

/** 裸 label 取值（保留键 sourceLabel；缺失兜「未知来源」）——只见裸串的场景（如引文旁标）用它，
 *  与 sourceIdentityLabel（会折叠其余键）共用同一口径。 */
export function sourceLabelOf(identity: SourceIdentity): string {
  return typeof identity["sourceLabel"] === "string" ? identity["sourceLabel"] : "未知来源";
}

/** 来源身份的显示串（UI 展示用，D-84）：优先 sourceLabel，其余键折叠为 `sourceLabel（k=v · …）`；
 *  无其余键时只显示 sourceLabel。弹性字典的形状差异在这里收敛为一个可读串。 */
export function sourceIdentityLabel(identity: SourceIdentity): string {
  const label = sourceLabelOf(identity);
  const rest = Object.entries(identity).filter(([k]) => k !== "sourceLabel");
  if (rest.length === 0) return label;
  return `${label}（${rest.map(([k, v]) => `${k}=${String(v)}`).join(" · ")}）`;
}

// ──────────────── 事项版本链（00 契约 §五：追加式，可撤回）────────────────
// 每次持久化 = 追加一个版本快照（元素+标签+状态+存疑 整体）；当前视图 = 每条链最后一个版本。
// 撤回功能暂缓下架（D-79）；定稿设计（追加 revert_version 节点）见 00 契约 §五与台账。

/** 变更署名（D-88）：谁 + 什么模型——`actor` 自由字符串（agent0 / 前台 / 用户 / 系统 / 清扫(…)/…），
 *  `model` 无则 null。**不含来源**——信源身份走证据链（版本→证据→片段→批次→sourceIdentity），
 *  版本上不再存第二个「来源」概念。 */
export const ProvenanceSchema = z.object({
  actor: z.string(),
  model: z.string().nullable(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Provenance 的显示串（旧 `by` 字符串的等价物）：`actor:model`（无模型只显示 actor）。
 *  与迁移前裸串格式一致（`agent0:deepseek-flash`），供仍以字符串承载署名的位置（证据 capturedBy）复用。 */
export function provenanceLabel(p: Provenance): string {
  return p.model === null ? p.actor : `${p.actor}:${p.model}`;
}

export const ItemVersionSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  action: z.string(), // create_item / update_item / add_element / …
  detail: z.string(), // 面向用户的一句话（处理记录直接展示）
  snapshot: z.object({
    elements: z.array(ElementSchema),
    tags: z.array(z.string()),
    status: z.enum(["todo", "done", "archived"]), // 快照同 Item（D-83 启用 archived）
    doubtNote: z.string().nullable(),
  }),
  at: z.string(), // 本地墙钟
  by: ProvenanceSchema, // 变更署名（谁 + 模型，D-88）
  revokedBy: z.string().nullable(), // 预留未用（撤回功能暂缓，D-79）
});
export type ItemVersion = z.infer<typeof ItemVersionSchema>;

// ──────────────── 变更清单（唯一 schema；围栏/执行器/测试共用）────────────────

/** 变更清单里的元素条目：label + text + 补充说明 + 逐字引文（引文声明自己为谁作证，D-62）。 */
const ElementInputSchema = z.object({
  label: z.string().min(1),
  text: z.string(),
  note: z.string().nullable().optional(),
  quotes: z.array(z.string().min(1)).default([]),
});
export type ElementInput = z.infer<typeof ElementInputSchema>;

export const ChangeItemSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_item"),
    elements: z.array(ElementInputSchema).min(1),
    tags: z.array(z.string().min(1)),
    doubtNote: z.string().nullable(),
  }),
  z.object({
    action: z.literal("update_item"),
    itemId: z.string(),
    setElements: z.array(ElementInputSchema), // 按 label 覆盖/新增（upsert）
    resolveDoubt: z.boolean(), // true = 同时解除存疑
  }),
  z.object({
    action: z.literal("add_element"),
    itemId: z.string(),
    element: ElementInputSchema,
  }),
  // mark_doubt 已删（D-85：agent0 拿不准改入存疑信息库 park_uncertain，不再新增存疑事项）
  z.object({
    action: z.literal("resolve_doubt"),
    itemId: z.string(),
    note: z.string().min(1),
  }),
  z.object({
    action: z.literal("complete_item"),
    itemId: z.string(),
  }),
  z.object({
    action: z.literal("record_note"),
    targetType: z.enum(["raw_input", "item"]),
    targetId: z.string(),
    note: z.string().min(1),
  }),
  // 存疑信息库（D-85）：拿不准的原始信息入库（不生成事项、不挂候选）。
  // needsHuman = agent0 打的「需人工分」（0-100，人工通道按它倒序）；reason = 一句理由
  //（缺什么信息/官方性/能否定量的语义都在此）。信源快照与批次引用由执行器从当批自动附。
  z.object({
    action: z.literal("park_uncertain"),
    content: z.string().min(1), // 原话逐字
    needsHuman: z.number().int().min(0).max(100),
    reason: z.string().min(1),
  }),
  // 库条目处置（D-85）：merged = 已合并进事项/批次（resolvedRef 指向去向）；discarded = 已丢弃。
  z.object({
    action: z.literal("resolve_uncertain"),
    id: z.string(),
    outcome: z.enum(["merged", "discarded"]),
    note: z.string().min(1),
    resolvedRef: z.string().optional(), // merged 时的去向（事项/批次 id）
  }),
]);
export type ChangeItem = z.infer<typeof ChangeItemSchema>;

export const ChangeListSchema = z.object({
  changes: z.array(ChangeItemSchema),
});
export type ChangeList = z.infer<typeof ChangeListSchema>;

// ───────────────────────── 存疑信息库（D-85：拿不准的原始信息，信息层池子）─────────────────────────

export const UncertainStatus = z.enum(["open", "merged", "discarded"]);
export type UncertainStatus = z.infer<typeof UncertainStatus>;

/** 存疑信息库条目：原话逐字 + 信源快照 + 时刻 + 来源批次引用 + 需人工分 + 状态。
 *  不挂候选事项——模糊信息不强挂事项（D-85）。 */
export const UncertainInputSchema = z.object({
  id: z.string(),
  content: z.string().min(1), // 原话逐字
  sourceType: z.string(),
  sourceIdentity: SourceIdentitySchema, // 信源快照（供接近度匹配：同群/同发信人）
  eventTime: z.string().nullable(),
  receivedAt: z.string(),
  originRawInputId: z.string().nullable(), // 从哪个批次摘出（可回溯原文）
  needsHuman: z.number().int().min(0).max(100), // agent0 打的「需人工分」（人工通道按它倒序）
  reason: z.string(), // 一句理由（缺什么信息/官方性/能否定量的语义在此）
  status: UncertainStatus,
  resolvedRef: z.string().nullable(), // 升格去向（merged 时的事项/批次 id）
  createdAt: z.string(), // 入库时刻
  resolvedAt: z.string().nullable(),
});
export type UncertainInput = z.infer<typeof UncertainInputSchema>;

// ───────────────────────── agent0 检索工具（01§4.14）─────────────────────────

export const SearchItemsArgsSchema = z.object({ query: z.string().min(1) });
export type SearchItemsArgs = z.infer<typeof SearchItemsArgsSchema>;

export const SearchItemsResultSchema = z.object({
  items: z.array(ItemSchema),
});
export type SearchItemsResult = z.infer<typeof SearchItemsResultSchema>;

export const GetItemArgsSchema = z.object({ id: z.string() });
export type GetItemArgs = z.infer<typeof GetItemArgsSchema>;

export const GetItemResultSchema = z.object({
  item: ItemSchema,
  evidence: z.array(EvidenceSourceSchema),
  fragments: z.array(FragmentSchema),
  versions: z.array(ItemVersionSchema),
  // 引文悬浮窗（05§三）数据链：fragments 引用到的批次原文，按批次 id 索引（天然去重）
  rawInputs: z.record(z.string(), RawInputSchema),
});
export type GetItemResult = z.infer<typeof GetItemResultSchema>;

export const SearchKbArgsSchema = z.object({ query: z.string().min(1) });
export type SearchKbArgs = z.infer<typeof SearchKbArgsSchema>;

export const SearchKbResultSchema = z.object({ entries: z.array(z.never()) }); // S3 前恒空
export type SearchKbResult = z.infer<typeof SearchKbResultSchema>;

// ─────────── agent0 信源阶段检索工具（D-85/D-76）───────────

/** search_recent_raws：散落碎片的兄弟找齐（时间相近 + 同来源检索历史批次）。
 *  daysBack = 回看天数（默认 7）；agent0 可显式给，也可省。 */
export const SearchRecentRawsArgsSchema = z.object({
  daysBack: z.number().int().min(1).max(90).default(7),
  sameSourceOnly: z.boolean().default(false), // true = 只找同来源（同群/同发信人）
});
export type SearchRecentRawsArgs = z.infer<typeof SearchRecentRawsArgsSchema>;

/** 结果一条 = 历史批次摘要（不含 raw 归档；给 agent0 的量控）。 */
export const RecentRawItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  sourceType: z.string(),
  sourceIdentity: SourceIdentitySchema,
  receivedAt: z.string(),
  eventTime: z.string().nullable(),
});
export type RecentRawItem = z.infer<typeof RecentRawItemSchema>;
export const SearchRecentRawsResultSchema = z.object({ raws: z.array(RecentRawItemSchema) });
export type SearchRecentRawsResult = z.infer<typeof SearchRecentRawsResultSchema>;

/** search_uncertain：检索存疑信息库 open 条目（复原通道 + 对话翻池）。
 *  服务端隐式携带当前消化批次的信源+时刻做参照（agent0 不拼参数）——见 AgentTools 实现。 */
export const SearchUncertainArgsSchema = z.object({
  sameSourceOnly: z.boolean().default(false), // true = 只找同来源（同群/同发信人）
});
export type SearchUncertainArgs = z.infer<typeof SearchUncertainArgsSchema>;

/** 结果一条 = 库条目摘要（含时刻与需人工分，供接近度判断与 AI 自判陈旧）。 */
export const UncertainHitSchema = z.object({
  id: z.string(),
  content: z.string(),
  sourceIdentity: SourceIdentitySchema,
  eventTime: z.string().nullable(),
  createdAt: z.string(),
  needsHuman: z.number().int(),
  reason: z.string(),
});
export type UncertainHit = z.infer<typeof UncertainHitSchema>;
export const SearchUncertainResultSchema = z.object({ entries: z.array(UncertainHitSchema) });
export type SearchUncertainResult = z.infer<typeof SearchUncertainResultSchema>;

// ───────────────────────── 看板（01§4.3 状态制四段；D-89）─────────────────────────

export const ItemRowSchema = z.object({
  item: ItemSchema,
  overdue: z.boolean(), // 渲染时派生（只对 todo 判——已完成不再追讨）
  dueDateInferred: z.boolean(), // dueDate 元素的 note 非 null
  updatedAt: z.string(), // 最新版本的 at
  completedAt: z.string().nullable(), // 最近一次进入已完成的时刻（done 段排序/淡出梯度；非 done 为 null，D-83 二轮）
  viewed: z.boolean(), // 是否已被用户打开过（「新」微标：待办且未打开才显示，点开即消，用户 2026-09-27）
});
export type ItemRow = z.infer<typeof ItemRowSchema>;

// 看板四段（01§4.3 / D-80 五段 → D-89 四段）：日期未知 → 已排期 → 已完成 → 已归档
// （存疑段已随 D-89 退场：拿不准的信息进存疑信息库，独立审核页——不再占看板）
export const BoardViewSchema = z.object({
  undated: z.array(ItemRowSchema), // 日期未知段
  scheduled: z.array(ItemRowSchema), // 已排期（按 ddl 升序）
  done: z.array(ItemRowSchema), // 已完成（默认折叠；status="done" 全量归此段）
  archived: z.array(ItemRowSchema), // 已归档段（D-83 最小归档启用；搁置流仍留信源阶段）
  failedRawInputs: z.array(RawInputSchema), // 「未处理」横幅
});
export type BoardView = z.infer<typeof BoardViewSchema>;

// ───────────────────────── 前台对话（01§4.14，D-78 多轮 buddy）─────────────────────────

/** 会话历史上传策略（D-78）：客户端与服务端共用的唯一出处——改截断/长度在这里改，两端自动一致。 */
export const CHAT_HISTORY_MAX_ITEMS = 16;
export const CHAT_HISTORY_ITEM_MAX_CHARS = 8000;

/** 会话历史的一条：客户端持有并随请求上传，服务端无状态（D-78）。content 是给用户看的纯文本。 */
export const ChatHistoryItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(CHAT_HISTORY_ITEM_MAX_CHARS), // 单条上限：防无上限内容直灌 LLM 上下文
});
export type ChatHistoryItem = z.infer<typeof ChatHistoryItemSchema>;

export const ChatRequestSchema = z.object({
  message: z.string().min(1),
  history: z.array(ChatHistoryItemSchema).default([]), // 本条消息之前的轮次（不含本条）
  // @ 提及的事项（用户 2026-09-27）：随请求上传，服务端注入给前台（id 真实性由前端看板保证）
  mentions: z
    .array(z.object({ id: z.string(), title: z.string() }))
    .max(8)
    .default([]), // 上限 8：防超大数组直灌提示词
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = z.object({
  reply: z.string().min(1), // converse 保证非空
  // 工具轨迹 chips（05§四 v1）：响应后一次性展示，人话映射在服务端做
  actions: z.array(z.object({ tool: z.string(), note: z.string() })).default([]),
  // 本轮触碰过的事项（事项 chips 深链用）：get_item 过 + search 命中过，按触碰序去重、上限 8
  references: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

/** GET /api/chat/history 响应（L16）：持久化的对话轮次，前端启动回填用。 */
export const ChatHistoryResponseSchema = z.object({
  turns: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
      at: z.string(), // 本地墙钟
    }),
  ),
});
export type ChatHistoryResponse = z.infer<typeof ChatHistoryResponseSchema>;

/** 用户手动操作（详情页按钮）的请求体。 */
export const ConfirmBodySchema = z.object({ note: z.string().optional() });
export type ConfirmBody = z.infer<typeof ConfirmBodySchema>;

// ───────────────────────── 设置面板（05§五，D-81）─────────────────────────

/** AI 连接设置（PUT /api/settings/ai 请求体）。apiKey 省略 = 沿用现值（GET 不回显完整 Key，防肩窥）。 */
export const AiSettingsSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().optional(),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

/** GET /api/settings/ai 响应：Key 只回掩码；overridden = 设置覆盖生效中（否则走 .env）。 */
export const AiSettingsViewSchema = z.object({
  baseUrl: z.string(),
  model: z.string(),
  apiKeyMasked: z.string().nullable(),
  overridden: z.boolean(),
});
export type AiSettingsView = z.infer<typeof AiSettingsViewSchema>;

/** POST /api/settings/ai/test 响应：用表单值实测一次最小请求（不动当前客户端）。 */
export const AiTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type AiTestResult = z.infer<typeof AiTestResultSchema>;

// ──────────────── 信源列表（GET /api/sources；D-88 T3 / D-89 类型上移）────────────────
// 跨边界契约住 shared（D-52）：前端按 schema 渲染通用设置表单，**不知道信源名**——
// core 与前端都不含信源专属知识。

/** 信源声明的设置项（纯数据）：六型判别的 union——**default 按型收紧**（text/secret/select=string、
 *  number=number、boolean=boolean；record 无 default）——渲染层无需再做「非标量 default」补偿，
 *  坏声明在 registerSources 落库前即被拒（不静默穿过到 UI）。 */
export const SettingFieldSchema = z.discriminatedUnion("type", [
  z.object({
    key: z.string().min(1),
    type: z.literal("text"),
    label: z.string(),
    default: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    key: z.string().min(1),
    type: z.literal("secret"),
    label: z.string(),
    default: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    key: z.string().min(1),
    type: z.literal("number"),
    label: z.string(),
    default: z.number().optional(),
    description: z.string().optional(),
  }),
  z.object({
    key: z.string().min(1),
    type: z.literal("boolean"),
    label: z.string(),
    default: z.boolean().optional(),
    description: z.string().optional(),
  }),
  z.object({
    key: z.string().min(1),
    type: z.literal("select"),
    label: z.string(),
    options: z.array(z.string()),
    default: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    key: z.string().min(1),
    type: z.literal("record"),
    label: z.string(),
    description: z.string().optional(),
  }),
]);
export type SettingField = z.infer<typeof SettingFieldSchema>;

/** GET /api/sources 的一项：信源名 + 运行状态（含最近错误）+ 设置 schema。
 *  state 由宿主维护（reportError/startSources 写）——前端据此显示「最近出错」。 */
export const SourceSummarySchema = z.object({
  name: z.string(),
  state: z.enum(["ok", "error"]),
  lastError: z.string().optional(),
  lastOkAt: z.string().optional(),
  settings: z.array(SettingFieldSchema),
});
export type SourceSummary = z.infer<typeof SourceSummarySchema>;

// ──────────────── 通用工具（跨 web/server 两端共用）────────────────

/** err → 人话单行（Error.message / String 兜底）。web 设置面与 server 日志/回喂共用；
 *  曾三份各写（web lib / server digest / server 内联），2026-10-09 /simplify 轮收敛到此。 */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ──────────────── 流水（批次级审计，specs/004）────────────────

/** 流水事件：一个批次（raw_input）身上发生过什么——消化结果/落笔动作/agent0 轨迹/围栏拒收。
 *  payload 按 action 各异且刻意不设严格 schema（自由形状，读侧防御性解析）；
 *  detail 是给人看的一句话，必须不看 payload 也能自足。 */
export const PipelineEventSchema = z.object({
  id: z.string(),
  action: z.string(),
  detail: z.string(),
  payload: z.unknown().nullable(),
  at: z.string(), // 本地墙钟
  by: ProvenanceSchema,
});
export type PipelineEvent = z.infer<typeof PipelineEventSchema>;

/** 进站台账行：一个批次的概要（不含正文——正文在详情接口）。流水视图列表的数据源（specs/005）。 */
export const PipelineRunSchema = z.object({
  id: z.string(),
  sourceType: z.string(),
  sourceLabel: z.string(), // 来源显示名（sourceIdentity.sourceLabel）
  receivedAt: z.string(),
  eventTime: z.string().nullable(),
  digestState: DigestState,
  summary: z.string().nullable(), // 消化结果一句话（digest_done/digest_failed 的 detail；无则 null）
  eventCount: z.number().int(), // 该批流水事件总数
});
export type PipelineRun = z.infer<typeof PipelineRunSchema>;

/** 进站详情：批次原文 + 全部流水事件（流水视图展开行的数据源）。 */
export const PipelineRunDetailSchema = z.object({
  raw: RawInputSchema,
  events: z.array(PipelineEventSchema),
});
export type PipelineRunDetail = z.infer<typeof PipelineRunDetailSchema>;
