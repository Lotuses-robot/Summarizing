import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  AiSettingsSchema,
  EvidenceSourceSchema,
  FragmentSchema,
  PipelineEventSchema,
  PipelineRunSchema,
  ItemSchema,
  ItemSnapshotSchema,
  ItemVersionSchema,
  ProvenanceSchema,
  RawInputSchema,
  UncertainInputSchema,
  normalizeSourceIdentity,
  sourceLabelOf,
  extractImageUrls,
  mediaIdFromUrl,
  type AiSettings,
  type EvidenceSource,
  type Fragment,
  type Item,
  type ItemVersion,
  type PipelineEvent,
  type PipelineRun,
  type Provenance,
  type RawInput,
  type SourceIdentity,
  type UncertainInput,
} from "@summarizing/shared";
import { nowWallClock, wallClockFromDate } from "../shared/time";
import type { DbOrTx } from "./db";
import * as s from "./schema";

/** 信源声明的设置 schema 在设置 KV 里的保留键（D-88 T3）：host 写、routes 读并过滤——
 *  居家真相在 storage 层（simplify 下沉：core 装配不再反向 import 路由模块）。 */
export const SOURCE_SCHEMA_KEY = "__schema__";

/** 存量 AI 设置在 app_settings 的键（设置路由写、空间装配读——同住 storage 单一出处）。 */
export const AI_SETTINGS_KEY = "ai";

/** 用户拒收规则在 app_settings 的键（D-107：用户设置 → agent0 提示词硬闸）。
 *  值是用户原文（自由文本），storage 只管存取、不解释内容（同 source_settings 哲学）。 */
export const REJECTION_RULES_KEY = "rejection_rules";

/** 读用户拒收规则原文；缺失 = 空串（提示词据此注入「（用户未设置任何拒收规则）」）。
 *  坏 JSON 一律当未设置并留痕——用户自由文本不该让消化崩掉（红线「不许静默」只要求可见）。 */
export function readRejectionRules(db: DbOrTx): string {
  const raw = getAppSetting(db, REJECTION_RULES_KEY);
  if (raw === null) return "";
  try {
    const value: unknown = JSON.parse(raw);
    // 契约窄到只收「一个字符串」：别的形状（对象/数组/数字）当未设置，不猜用户本意
    return typeof value === "string" ? value : "";
  } catch {
    process.stderr.write(
      "[settings] app_settings 的 rejection_rules 行不是合法 JSON，按未设置处理\n",
    );
    return "";
  }
}

/** 读存量 AI 设置（app_settings 的 ai 行）；缺失、坏 JSON、形状不符都视为**未配置**（不崩不静默崩溃）。
 *  空间装配（spaces）与设置路由共用——解析逻辑唯一出处。 */
export function readStoredAi(db: DbOrTx): AiSettings | null {
  const raw = getAppSetting(db, AI_SETTINGS_KEY);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    const parsed = AiSettingsSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    process.stderr.write("[settings] app_settings 的 ai 行不是合法 JSON，按未配置处理\n");
    return null;
  }
}

// repo 层：唯一允许碰存储的地方（01§8.3 一份数据一个所有者）。
// 读出统一过 shared 的 zod parse——表结构与类型漂移时在这里爆，而不是静默错下去。

/** 生成实体主键（UUID v4）。 */
const newId = (): string => crypto.randomUUID();
/** 内容哈希——片段池按它去重（01§4.4）。 */
const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

/** 版本行 snapshot → 事项内容（过 ItemSnapshotSchema，id 由外层补）。 */
function parseItemSnapshot(text: string) {
  return ItemSnapshotSchema.parse(parseJsonUnknown(text));
}
/** 把 JSON 字符串读成 unknown（类型安全的第一步）。 */
function parseJsonUnknown(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

// ── 事项版本链（00 契约 §五：追加式，当前视图=派生）──

// ── 排序不变量（唯一出处）：墙钟是秒级精度，同事务同秒连写多条是常态，
// 一切按 at 的排序必须 rowid 破平，否则同秒顺序未定义（本轮曾漏两处真踩）。
const VERSION_ORDER = [asc(s.itemVersions.at), asc(sql`rowid`)] as const;
const PIPELINE_ORDER = [asc(s.pipelineEvents.at), asc(sql`rowid`)] as const;

/** 追加一个事项版本（完整快照）。一切事项写入的必经之路。
 *  写前过 ItemSchema——不变量（恰好一个 name 等）在**写路径**强制，投毒数据在此拒收
 *  （事务回滚、批次标 failed 可见），而非留到读路径炸成全站 500。 */
export function appendItemVersion(
  db: DbOrTx,
  args: {
    itemId: string;
    action: string;
    detail: string;
    snapshot: {
      elements: Item["elements"];
      tags: string[];
      status: Item["status"];
      kind: Item["kind"];
      doubtNote: string | null;
    };
    by: Provenance;
  },
): ItemVersion {
  // 写路径校验：不变量（恰好一个 name 等）在**写入期**强制——投毒数据在此拒收
  // （事务回滚、批次标 failed 可见），而非留到读路径炸成全站 500。
  ItemSchema.parse({ id: args.itemId, ...args.snapshot });
  const row = {
    id: newId(),
    itemId: args.itemId,
    action: args.action,
    detail: args.detail,
    snapshot: JSON.stringify(args.snapshot),
    at: nowWallClock(),
    by: JSON.stringify(args.by), // Provenance 结构化存 JSON 串（列仍是 TEXT，D-88）
    revokedBy: null, // 预留未用（撤回功能暂缓，D-79）
  };
  db.insert(s.itemVersions).values(row).run();
  // 通知「更新后重新标未读」（OQ-11）：任何新版本都把该条的已读标记清掉——
  // 内容变了就值得重看一眼。挂在唯一写路径上，前端/agent0 两条写入口自动一致。
  if (args.snapshot.kind === "notice") {
    db.delete(s.itemViews).where(eq(s.itemViews.itemId, args.itemId)).run();
  }
  return ItemVersionSchema.parse({ ...row, snapshot: args.snapshot, by: args.by });
}

/** DB 的 `by` 列 → Provenance：解析 JSON 串；存量裸串/坏 JSON（`agent0:test` 等，JSON.parse 会抛）
 *  兜底成 `{ actor: 原串, model: null }`（不重置库；迁移负责把存量转正，这里是读路径兜底）。 */
function parseProvenance(raw: string): Provenance {
  let parsed: unknown = null;
  try {
    parsed = parseJsonUnknown(raw);
  } catch {
    // 裸串不是合法 JSON——按「整串是 actor」兜底，不让读路径炸
  }
  const result = ProvenanceSchema.safeParse(parsed);
  return result.success ? result.data : { actor: raw, model: null };
}

/** 派生当前全部事项 + 各自最新版本时间（看板「新」微标的 updatedAt）；每个 item_id 只取最后一条版本。
 *  「最后一条」用 MAX(rowid) 表达：rowid 即插入序，与 VERSION_ORDER 的 (at, rowid) 末位语义等价——
 *  SQL 端先裁剪再 parse，避免热路径（10s 轮询 + get_board）随版本链增长线性白耗。 */
export function deriveItemsWithVersion(db: DbOrTx): { item: Item; updatedAt: string }[] {
  const latest = db
    .select()
    .from(s.itemVersions)
    .where(
      sql`rowid = (SELECT MAX(rowid) FROM item_versions AS latest_scan WHERE latest_scan.item_id = ${s.itemVersions.itemId})`,
    )
    .all();
  return latest.map((v) => ({
    item: ItemSchema.parse({ id: v.itemId, ...parseItemSnapshot(v.snapshot) }),
    updatedAt: v.at,
  }));
}

/** 派生当前全部事项（不需要 updatedAt 的调用方的薄包装）。 */
export function deriveItems(db: DbOrTx): Item[] {
  return deriveItemsWithVersion(db).map((r) => r.item);
}

/** 最近一次进入「已完成」的时刻（done 段排序与完成淡出梯度用；null = 从未完成）。
 *  进入 = 该版本快照为 done 且前一版本非 done（从回收站恢复回 done 时以恢复时刻重计）。 */
export function completedAtOf(db: DbOrTx, itemId: string): string | null {
  const history = deriveHistory(db, itemId);
  for (let i = history.length - 1; i >= 1; i--) {
    const cur = history[i];
    const prev = history[i - 1];
    if (cur && prev && cur.snapshot.status === "done" && prev.snapshot.status !== "done") {
      return cur.at;
    }
  }
  return null;
}

/** 进入「回收站」的时刻（trashedAt：版本链**从新到旧找最后一条 status=trashed** 的 at；
 *  null = 从未删除）。同 completedAtOf 的形状——回收站排序与「一键清理 >15d」都以它为据。
 *  ⚠️ 循环到 index 0（completedAtOf 需要前一条，故从 1 起；这里没有"前一条"语义）——
 *  时间戳乱序（时钟回拨/回填历史）时 trashed 版本可能排在首位，漏查会让该条静默丢出回收站。 */
export function trashedAtOf(db: DbOrTx, itemId: string): string | null {
  const history = deriveHistory(db, itemId);
  for (let i = history.length - 1; i >= 0; i--) {
    const v = history[i];
    if (v && v.snapshot.status === "trashed") {
      return v.at;
    }
  }
  return null;
}

/** 删前的处置状态（回收站「恢复」回删前的值用）：自版本链最新向旧找第一个「非 trashed」的版本。
 *  按状态而非 action 跳过——防 trashed 期间混入的其它状态版本顶链导致恢复失效。
 *  **整条链全为 trashed / 为空 → null**（不编造恢复状态——「结构容错≠语义兜底」，
 *  调用方据此报「删前状态不可考」而不是静默还原成 todo）。 */
export function preTrashStatus(db: DbOrTx, itemId: string): Item["status"] | null {
  const history = deriveHistory(db, itemId);
  for (let i = history.length - 1; i >= 0; i--) {
    const v = history[i];
    if (v && v.snapshot.status !== "trashed") {
      return v.snapshot.status;
    }
  }
  return null;
}

/** 派生单个事项；不存在（无任何版本）返回 null。 */
export function deriveItem(db: DbOrTx, itemId: string): Item | null {
  const versions = db
    .select()
    .from(s.itemVersions)
    .where(eq(s.itemVersions.itemId, itemId))
    .orderBy(...VERSION_ORDER)
    .all();
  const last = versions.at(-1);
  return last ? ItemSchema.parse({ id: last.itemId, ...parseItemSnapshot(last.snapshot) }) : null;
}

/** 某事项的完整版本史（时间升序——编辑列表的数据源）。 */
export function deriveHistory(db: DbOrTx, itemId: string): ItemVersion[] {
  return db
    .select()
    .from(s.itemVersions)
    .where(eq(s.itemVersions.itemId, itemId))
    .orderBy(...VERSION_ORDER)
    .all()
    .map((r) =>
      ItemVersionSchema.parse({
        ...r,
        snapshot: parseJsonUnknown(r.snapshot),
        by: parseProvenance(r.by), // DB 存 JSON 串 / 存量裸串 → Provenance
      }),
    );
}

/** 事项是否存在（有版本即存在）。 */
export function itemExists(db: DbOrTx, itemId: string): boolean {
  return (
    db
      .select({ id: s.itemVersions.id })
      .from(s.itemVersions)
      .where(eq(s.itemVersions.itemId, itemId))
      .limit(1)
      .get() !== undefined
  );
}

// ── RawInput ──

/** 进站写入的可选归档载荷（DB 存 JSON 串；不进 RawInput 返回类型，D-84）。 */
export interface RawInputExtras {
  raw?: unknown;
}

/** 原始文本先落档（01§5.3）：在 AI 之前、状态 pending——原文永不丢失的起点。
 *  sourceIdentity 弹性字典序列化进 JSON 列；raw 归档载荷可选（D-84）。 */
export function insertRawInput(
  db: DbOrTx,
  args: Omit<RawInput, "id" | "digestState"> & RawInputExtras,
): RawInput {
  const { raw, ...rest } = args;
  const row = {
    id: newId(),
    digestState: "pending" as const,
    ...rest,
    sourceIdentity: JSON.stringify(rest.sourceIdentity),
    raw: raw === undefined ? null : JSON.stringify(raw),
  };
  db.insert(s.rawInputs).values(row).run();
  return RawInputSchema.parse({ ...rest, id: row.id, digestState: row.digestState });
}

/** DB 行 → RawInput：sourceIdentity 列过弹性字典防御解析（存量裸字符串 → { name: 原串 }，D-84）。 */
function rowToRawInput(row: typeof s.rawInputs.$inferSelect): RawInput {
  return RawInputSchema.parse({
    id: row.id,
    content: row.content,
    sourceType: row.sourceType,
    sourceIdentity: normalizeSourceIdentity(parseJsonMaybe(row.sourceIdentity)),
    receivedAt: row.receivedAt,
    eventTime: row.eventTime,
    digestState: row.digestState,
  });
}

/** 尝试把字符串当 JSON 解析；不是合法 JSON 就原样返回（存量裸字符串走这里）。 */
function parseJsonMaybe(text: string | null): unknown {
  if (text === null) return null;
  try {
    return parseJsonUnknown(text);
  } catch {
    return text;
  }
}

/** 按 ID 读原始输入；不存在返回 null。 */
export function getRawInput(db: DbOrTx, id: string): RawInput | null {
  const row = db.select().from(s.rawInputs).where(eq(s.rawInputs.id, id)).get();
  return row ? rowToRawInput(row) : null;
}

/** 更新消化状态：pending → digesting（kickDigest 发射即置）/ digested / failed（failed = 「未处理」可见降级，01§5.3）。 */
export function setDigestState(db: DbOrTx, id: string, state: RawInput["digestState"]): void {
  db.update(s.rawInputs).set({ digestState: state }).where(eq(s.rawInputs.id, id)).run();
}

/** 条件状态跃迁：仅当当前为 from 时置 to，返回是否命中（原子前置——「仅 failed 可重试」的唯一执法点）。 */
export function setDigestStateIf(
  db: DbOrTx,
  id: string,
  from: RawInput["digestState"],
  to: RawInput["digestState"],
): boolean {
  const res = db
    .update(s.rawInputs)
    .set({ digestState: to })
    .where(and(eq(s.rawInputs.id, id), eq(s.rawInputs.digestState, from)))
    .run();
  return res.changes > 0;
}

/** 按消化状态列出（看板的「未处理」横幅用它）。 */
export function listRawInputsByState(db: DbOrTx, state: RawInput["digestState"]): RawInput[] {
  return db
    .select()
    .from(s.rawInputs)
    .where(eq(s.rawInputs.digestState, state))
    .all()
    .map((r) => rowToRawInput(r));
}

/** 最近 N 天的进站批次（search_recent_raws 数据源；按接收时间倒序，截断防全表灌入）。
 *  返回 shared 形状的批次（不含 raw 归档——给 agent0 的量控）。
 *  daysBack 过滤下沉到 SQL（墙钟定宽 → 字典序 = 时间序，可直接字符串比较）——
 *  LIMIT 只在**命中窗口内**截断；若在内存过滤则 LIMIT 会先砍掉老 rowid 的近期批次（评审 A1）。 */
export function listRecentRawInputs(db: DbOrTx, daysBack: number): RawInput[] {
  const cutoff = wallClockDaysAgo(daysBack);
  return db
    .select()
    .from(s.rawInputs)
    .where(sql`${s.rawInputs.receivedAt} >= ${cutoff}`)
    .orderBy(sql`rowid DESC`)
    .limit(RECENT_RAWS_SQL_LIMIT)
    .all()
    .map((r) => rowToRawInput(r))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

/** N 天前的北京墙钟串（与 receivedAt 同格式、同口径——供 SQL 字符串比较；单一出处 wallClockFromDate，
 *  勿手搓：手搓副本会按机器时区算，与 +08:00 的 receivedAt 偏 8 小时，D-97 走查逮出）。 */
function wallClockDaysAgo(days: number): string {
  return wallClockFromDate(new Date(Date.now() - days * 86_400_000));
}

/** SQL 端截断上限（rowid 倒序 = 最新优先；过滤后数量由调用方再截）。 */
const RECENT_RAWS_SQL_LIMIT = 200;

/** 批次级流水（消化生命周期 + agent0 轨迹；事项历史在 item_versions；specs/004 正名）。 */
export function appendPipelineEvent(
  db: DbOrTx,
  args: { rawInputId: string; action: string; detail: string; payload?: unknown; by: Provenance },
): void {
  const row = {
    id: newId(),
    entityId: args.rawInputId,
    action: args.action,
    detail: args.detail,
    payload: args.payload === undefined ? null : JSON.stringify(args.payload),
    at: nowWallClock(),
    by: JSON.stringify(args.by), // Provenance 结构化存 JSON 串（列仍是 TEXT，D-88）
  };
  db.insert(s.pipelineEvents).values(row).run();
}

/** 某批次的全部流水（时间升序，全字段 zod 解析——C2 读口与测试共用；走 entity_id 索引）。 */
export function listPipelineEvents(db: DbOrTx, rawInputId: string): PipelineEvent[] {
  return db
    .select()
    .from(s.pipelineEvents)
    .where(eq(s.pipelineEvents.entityId, rawInputId))
    .orderBy(...PIPELINE_ORDER)
    .all()
    .map((r) =>
      PipelineEventSchema.parse({
        id: r.id,
        action: r.action,
        detail: r.detail,
        payload: parseJsonMaybe(r.payload),
        at: r.at,
        by: parseJsonMaybe(r.by),
      }),
    );
}

/** 进站台账：最近 N 个批次的概要（含流水计数与消化结果一句话）——流水视图列表数据源（specs/005）。
 *  两条查询（批次 + 按 id 集合取流水）+ JS 分组，避免逐批 N+1。summary 取末条 digest_done/failed。 */
export function listPipelineRuns(db: DbOrTx, limit = 50): PipelineRun[] {
  const raws = db
    .select()
    .from(s.rawInputs)
    .orderBy(desc(s.rawInputs.receivedAt))
    .limit(limit)
    .all();
  if (raws.length === 0) return [];
  const events = db
    .select()
    .from(s.pipelineEvents)
    .where(
      inArray(
        s.pipelineEvents.entityId,
        raws.map((r) => r.id),
      ),
    )
    .orderBy(...PIPELINE_ORDER)
    .all();
  const byRaw = new Map<string, (typeof events)[number][]>();
  for (const e of events) {
    const list = byRaw.get(e.entityId) ?? [];
    list.push(e);
    byRaw.set(e.entityId, list);
  }
  return raws.map((r) => {
    const evts = byRaw.get(r.id) ?? [];
    const done = [...evts]
      .reverse()
      .find((e) => e.action === "digest_done" || e.action === "digest_failed");
    return PipelineRunSchema.parse({
      id: r.id,
      sourceType: r.sourceType,
      sourceLabel: sourceLabelOf(normalizeSourceIdentity(parseJsonMaybe(r.sourceIdentity))),
      receivedAt: r.receivedAt,
      eventTime: r.eventTime,
      digestState: r.digestState,
      summary: done?.detail ?? null,
      eventCount: evts.length,
    });
  });
}

// ── 片段池（快照按内容去重，01§4.4）──

/** 片段按内容哈希去重入池：同一原文只存一份、多处引用（01§4.4）。 */
export function getOrCreateFragment(db: DbOrTx, content: string, rawInputId: string): Fragment {
  const hash = sha256(content);
  const existing = db.select().from(s.fragments).where(eq(s.fragments.contentHash, hash)).get();
  if (existing) return FragmentSchema.parse(existing);
  const row = { id: newId(), content, contentHash: hash, rawInputId };
  db.insert(s.fragments).values(row).run();
  return FragmentSchema.parse(row);
}

/** 按 ID 读片段；不存在返回 null。 */
export function getFragment(db: DbOrTx, id: string): Fragment | null {
  const row = db.select().from(s.fragments).where(eq(s.fragments.id, id)).get();
  return row ? FragmentSchema.parse(row) : null;
}

// ── 证据（§五：subject 一律 元素:<label>）──

/** 给事项的某元素挂一条证据来源：抓取时间此刻生成、由谁必填。 */
export function addEvidence(
  db: DbOrTx,
  args: {
    itemId: string;
    subject: string;
    fragmentId: string;
    pointer?: string | null;
    by: string;
  },
): void {
  const row = {
    id: newId(),
    itemId: args.itemId,
    subject: args.subject,
    fragmentId: args.fragmentId,
    pointer: args.pointer ?? null,
    capturedAt: nowWallClock(),
    capturedBy: args.by,
  };
  db.insert(s.evidence).values(row).run();
}

/** 列出某事项的全部证据来源（整链展开，不分主副不排序）。 */
export function listEvidenceByItem(db: DbOrTx, itemId: string): EvidenceSource[] {
  return (
    db
      .select()
      .from(s.evidence)
      .where(eq(s.evidence.itemId, itemId))
      // 显式按落笔顺序（capturedAt；同刻按 rowid 破平）——「最近一条证据」等调用方依赖确定顺序，
      // 无 ORDER BY 时读到的是 SQLite 的偶然返回序（评审：来源徽标可能显示旧批次）
      .orderBy(asc(s.evidence.capturedAt), asc(sql`rowid`))
      .all()
      .map((r) => EvidenceSourceSchema.parse(r))
  );
}

/** 标记事项已被用户打开过（幂等；「新」微标消除，用户 2026-09-27）。 */
export function markItemViewed(db: DbOrTx, itemId: string): void {
  db.insert(s.itemViews).values({ itemId, viewedAt: nowWallClock() }).onConflictDoNothing().run();
}

/** 已标记查看的事项 id 集合（看板装配「新」微标用）。 */
export function listViewedItemIds(db: DbOrTx): Set<string> {
  return new Set(
    db
      .select({ itemId: s.itemViews.itemId })
      .from(s.itemViews)
      .all()
      .map((r) => r.itemId),
  );
}

/** 读一条应用设置（哑 KV：值是 JSON 字符串，解析归调用方——repo 不懂业务形状）。 */
export function getAppSetting(db: DbOrTx, key: string): string | null {
  const row = db.select().from(s.appSettings).where(eq(s.appSettings.key, key)).get();
  return row?.value ?? null;
}

/** 写应用设置（UPSERT；设置面板热切换的数据源，05§五）。 */
export function setAppSetting(db: DbOrTx, key: string, value: string): void {
  db.insert(s.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: s.appSettings.key, set: { value } })
    .run();
}

/** 删应用设置（「清除配置」回未配置用，05§五）。 */
export function deleteAppSetting(db: DbOrTx, key: string): void {
  db.delete(s.appSettings).where(eq(s.appSettings.key, key)).run();
}

// ── 信源设置 KV（D-84/D-88：core 只管存取不解释内容；与 app_settings 分表——所有权不同）──

/** 读信源设置的原始 JSON 串；未设置返回 null（「没设置」由调用方与坏值区分）。 */
export function getSourceSetting(db: DbOrTx, source: string, key: string): string | null {
  const row = db
    .select()
    .from(s.sourceSettings)
    .where(and(eq(s.sourceSettings.source, source), eq(s.sourceSettings.key, key)))
    .get();
  return row?.value ?? null;
}

/** 写信源设置（UPSERT；值是 JSON 串，形状归信源）。 */
export function setSourceSetting(db: DbOrTx, source: string, key: string, value: string): void {
  db.insert(s.sourceSettings)
    .values({ source, key, value })
    .onConflictDoUpdate({
      target: [s.sourceSettings.source, s.sourceSettings.key],
      set: { value },
    })
    .run();
}

/** 删信源设置（键不存在 = 无操作）。 */
export function deleteSourceSetting(db: DbOrTx, source: string, key: string): void {
  db.delete(s.sourceSettings)
    .where(and(eq(s.sourceSettings.source, source), eq(s.sourceSettings.key, key)))
    .run();
}

/** 列信源全部设置（GET /api/sources/:name/settings 的数据源）。 */
export function listSourceSettings(db: DbOrTx, source: string): { key: string; value: string }[] {
  return db
    .select({ key: s.sourceSettings.key, value: s.sourceSettings.value })
    .from(s.sourceSettings)
    .where(eq(s.sourceSettings.source, source))
    .all();
}

/** 列所有出现过的信源名（GET /api/sources 用；与内存 state 表合并，兜住「有设置行但没上岗」的源）。 */
export function listSourceNames(db: DbOrTx): string[] {
  const rows = db.selectDistinct({ source: s.sourceSettings.source }).from(s.sourceSettings).all();
  return rows.map((r) => r.source);
}

// ── 对话轮次（L16：持久化会话，刷新/换设备可回填）──

/** 追加一轮对话（user 或 assistant 各一条）；at = 北京墙钟。 */
export function appendChatTurn(db: DbOrTx, role: "user" | "assistant", content: string): void {
  db.insert(s.chatTurns).values({ id: newId(), role, content, at: nowWallClock() }).run();
}

/** 读最近 limit 轮（时间升序返回，供前端回填）；chat_turns 是只增不删的日志。 */
export function listRecentChatTurns(
  db: DbOrTx,
  limit: number,
): { role: string; content: string; at: string }[] {
  return db
    .select({ role: s.chatTurns.role, content: s.chatTurns.content, at: s.chatTurns.at })
    .from(s.chatTurns)
    .orderBy(sql`rowid DESC`)
    .limit(limit)
    .all()
    .reverse(); // 倒序取最新 N 条后再反转成时间升序
}

// ── LLM 用量（010：活动栏左下角「用量」仪表盘）──

/** 追加一行调用用量（只记**成功**调用；失败无 usage 可记，由流水留痕）。 */
export function insertLlmUsage(
  db: DbOrTx,
  args: {
    actor: "agent0" | "chat";
    model: string;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number | null;
  },
): void {
  db.insert(s.llmUsage)
    .values({
      id: newId(),
      at: nowWallClock(),
      actor: args.actor,
      model: args.model,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      cachedTokens: args.cachedTokens,
    })
    .run();
}

/** 聚合 since（含）之后的用量（010）：三个维度互不重叠，相加 = 区间总消耗。
 *  `cachedTokens` 全 NULL → null（服务商未提供）；只要有一行有值就按非 NULL 相加——
 *  命中 0 是真实数据。跨行相减可能为负（服务商返回怪异）时夹到 0，不传播怪值给界面。 */
export function sumLlmUsage(
  db: DbOrTx,
  since: string,
): {
  inputTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
  callCount: number;
} {
  const rows = db
    .select({
      promptTokens: s.llmUsage.promptTokens,
      completionTokens: s.llmUsage.completionTokens,
      cachedTokens: s.llmUsage.cachedTokens,
    })
    .from(s.llmUsage)
    .where(sql`${s.llmUsage.at} >= ${since}`)
    .all();
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens: number | null = null;
  for (const r of rows) {
    promptTokens += r.promptTokens;
    completionTokens += r.completionTokens;
    if (r.cachedTokens !== null) cachedTokens = (cachedTokens ?? 0) + r.cachedTokens;
  }
  return {
    inputTokens: Math.max(0, promptTokens - (cachedTokens ?? 0)),
    completionTokens,
    cachedTokens,
    callCount: rows.length,
  };
}

// ── 图片媒体（009：上传 + 信源图片缓存）──

/** 一条媒体行的公开形状（shared MediaRef）。 */
export type MediaRefRow = { id: string; mime: string; sizeBytes: number; expiresAt: string };

/** 插入或复用一张缓存图（内容寻址，天然去重）。
 *  **同一 sha256 已存在 → 复用，不重复落盘**；到期时间取较晚的一个（新上传的说明仍有人要）。
 *  返回新插入 or 命中复用的行。 */
export function insertMedia(
  db: DbOrTx,
  args: {
    id: string;
    mime: string;
    sizeBytes: number;
    createdAt: string;
    expiresAt: string;
    originUrl: string | null;
  },
): MediaRefRow {
  const existing = db.select().from(s.media).where(eq(s.media.id, args.id)).get();
  if (existing !== undefined) {
    /** 要改的列（没有变化就是空对象，不写库）。 */
    const patch: { expiresAt?: string; originUrl?: string } = {};
    if (args.expiresAt > existing.expiresAt) patch.expiresAt = args.expiresAt;
    // 先以「无原链接」的形式存过（前台上传），之后同一份字节从信源带着原链接再来：
    // 补上映射——否则 getMediaByOriginUrl 永远查不到它，缓存白存、每次进站都重下
    if (existing.originUrl === null && args.originUrl !== null) patch.originUrl = args.originUrl;
    if (Object.keys(patch).length > 0) {
      db.update(s.media).set(patch).where(eq(s.media.id, args.id)).run();
    }
    return {
      id: existing.id,
      mime: existing.mime,
      sizeBytes: existing.sizeBytes,
      expiresAt: patch.expiresAt ?? existing.expiresAt,
    };
  }
  db.insert(s.media).values(args).run();
  return { id: args.id, mime: args.mime, sizeBytes: args.sizeBytes, expiresAt: args.expiresAt };
}

/** 按 sha256 取一行（读接口的归属校验 + fetch_image 本地命中）。 */
export function getMedia(db: DbOrTx, id: string): MediaRefRow | null {
  const row = db.select().from(s.media).where(eq(s.media.id, id)).get();
  if (row === undefined) return null;
  return { id: row.id, mime: row.mime, sizeBytes: row.sizeBytes, expiresAt: row.expiresAt };
}

/** 按原始 URL 取一行（信源图片占位反查 + 进站缓存去重）。 */
export function getMediaByOriginUrl(db: DbOrTx, originUrl: string): MediaRefRow | null {
  const row = db.select().from(s.media).where(eq(s.media.originUrl, originUrl)).get();
  if (row === undefined) return null;
  return { id: row.id, mime: row.mime, sizeBytes: row.sizeBytes, expiresAt: row.expiresAt };
}

/** 占位 URL → 媒体 id（本地 `/api/media/<id>` 直取；外链按 originUrl 反查）。未缓存 = null。
 *  判据单一出处：证据引用判定（执行器）与前端映射都按这一条认「这个占位指的是哪张图」。 */
export function resolveMediaId(db: DbOrTx, url: string): string | null {
  const localId = mediaIdFromUrl(url);
  if (localId !== null) return getMedia(db, localId) === null ? null : localId;
  return getMediaByOriginUrl(db, url)?.id ?? null;
}

/** 列出若干 sha256 的媒体行（详情接口一次查全）。 */
function getMediaByIds(db: DbOrTx, ids: string[]): MediaRefRow[] {
  if (ids.length === 0) return [];
  const rows = db.select().from(s.media).where(inArray(s.media.id, ids)).all();
  return rows.map((r) => ({
    id: r.id,
    mime: r.mime,
    sizeBytes: r.sizeBytes,
    expiresAt: r.expiresAt,
  }));
}

/** 这张图是否被**任何**证据引过（跨批次）——「读过未引用 → 缩到 3 天」的否决闸。
 *  只看本批是不够的：A 批引用过、B 批读过没引用，缩了就把 A 批的证据链拆了。
 *  判据 = 片段池里存在含该占位的引文（`/api/media/<id>` 任意形态命中本地；信源图按原链接）。
 *  用 `instr` 而不是 `LIKE`：URL 天然带 `%`（百分号编码），LIKE 会把它当通配符。 */
export function isMediaCited(db: DbOrTx, mediaId: string): boolean {
  const row = db
    .select({ originUrl: s.media.originUrl })
    .from(s.media)
    .where(eq(s.media.id, mediaId))
    .get();
  if (row === undefined) return false;
  const needles = [`/api/media/${mediaId}`];
  if (row.originUrl !== null) needles.push(row.originUrl);
  for (const needle of needles) {
    const hit = db
      .select({ id: s.fragments.id })
      .from(s.fragments)
      .where(sql`instr(${s.fragments.content}, ${needle}) > 0`)
      .limit(1)
      .get();
    if (hit !== undefined) return true;
  }
  return false;
}

/** 抬到较晚的到期时间——只在 next 更晚时写（引用判定；日期只增不减，防后一次引用反向缩短）。 */
export function bumpMediaExpiry(db: DbOrTx, id: string, next: string): boolean {
  const cur = db
    .select({ expiresAt: s.media.expiresAt })
    .from(s.media)
    .where(eq(s.media.id, id))
    .get();
  if (cur === undefined || next <= cur.expiresAt) return false; // 行已删 / 不更晚 → 不动
  db.update(s.media).set({ expiresAt: next }).where(eq(s.media.id, id)).run();
  return true;
}

/** 提前到期时间——只在 next 更早时写（读过未引用；只提前、不延后）。 */
export function shortenMediaExpiry(db: DbOrTx, id: string, next: string): boolean {
  const cur = db
    .select({ expiresAt: s.media.expiresAt })
    .from(s.media)
    .where(eq(s.media.id, id))
    .get();
  if (cur === undefined || next >= cur.expiresAt) return false; // 行已删（清理器或回收站）→ 忽略
  db.update(s.media).set({ expiresAt: next }).where(eq(s.media.id, id)).run();
  return true;
}

/** 已过期的媒体行（清理器扫描；文件路径由调用方按 id + mime 拼）。 */
export function listExpiredMedia(db: DbOrTx, now: string): MediaRefRow[] {
  return db
    .select()
    .from(s.media)
    .where(sql`${s.media.expiresAt} <= ${now}`)
    .all()
    .map((r) => ({ id: r.id, mime: r.mime, sizeBytes: r.sizeBytes, expiresAt: r.expiresAt }));
}

/** 删一行（清理器）。 */
export function deleteMediaRow(db: DbOrTx, id: string): void {
  db.delete(s.media).where(eq(s.media.id, id)).run();
}

// ── 存疑信息库（D-85：信息层池子；不生成事项、不挂候选）──

/** 入库一条（agent0 park_uncertain）：信源快照与批次引用由调用方从当批带入。 */
export function insertUncertainInput(
  db: DbOrTx,
  args: {
    content: string;
    sourceType: string;
    sourceIdentity: SourceIdentity;
    eventTime: string | null;
    receivedAt: string;
    originRawInputId: string | null;
    needsHuman: number;
    reason: string;
    createdAt: string;
  },
): UncertainInput {
  const row = {
    id: newId(),
    content: args.content,
    sourceType: args.sourceType,
    sourceIdentity: JSON.stringify(args.sourceIdentity),
    eventTime: args.eventTime,
    receivedAt: args.receivedAt,
    originRawInputId: args.originRawInputId,
    needsHuman: String(args.needsHuman),
    reason: args.reason,
    status: "open" as const,
    resolvedRef: null,
    createdAt: args.createdAt,
    resolvedAt: null,
  };
  db.insert(s.uncertainInputs).values(row).run();
  return uncertainRowToInput(row);
}

/** DB 行 → UncertainInput（身份防御解析、needsHuman 串回转整数）。 */
function uncertainRowToInput(row: typeof s.uncertainInputs.$inferSelect): UncertainInput {
  return UncertainInputSchema.parse({
    ...row,
    sourceIdentity: normalizeSourceIdentity(parseJsonMaybe(row.sourceIdentity)),
    needsHuman: Number(row.needsHuman),
  });
}

/** 按状态列出库条目；人工通道按 needsHuman 倒序、破平新到旧（D-85）。 */
export function listUncertainByStatus(
  db: DbOrTx,
  status: UncertainInput["status"],
): UncertainInput[] {
  return db
    .select()
    .from(s.uncertainInputs)
    .where(eq(s.uncertainInputs.status, status))
    .all()
    .map((r) => uncertainRowToInput(r))
    .sort((a, b) => b.needsHuman - a.needsHuman || b.createdAt.localeCompare(a.createdAt));
}

/** 按 ID 读一条；不存在返回 null。 */
export function getUncertainInput(db: DbOrTx, id: string): UncertainInput | null {
  const row = db.select().from(s.uncertainInputs).where(eq(s.uncertainInputs.id, id)).get();
  return row ? uncertainRowToInput(row) : null;
}

/** 处置一条（resolve_uncertain）：置状态 + 去向 + 处置时刻；返回是否命中。
 *  ⚠️ 仅当当前为 open 才处置（原子前置，同 setDigestStateIf）——否则已关闭条目可被复活/覆盖去向
 *  （并发清扫或模型对同一条重复处置时，merged 会被后到的 discarded 改写，评审 A5）。 */
export function resolveUncertainInput(
  db: DbOrTx,
  args: {
    id: string;
    status: Extract<UncertainInput["status"], "merged" | "discarded">;
    resolvedRef: string | null;
    resolvedAt: string;
  },
): boolean {
  const res = db
    .update(s.uncertainInputs)
    .set({ status: args.status, resolvedRef: args.resolvedRef, resolvedAt: args.resolvedAt })
    .where(and(eq(s.uncertainInputs.id, args.id), eq(s.uncertainInputs.status, "open")))
    .run();
  return res.changes > 0;
}

// ── 聚合读（get_event 工具 / 事项详情页共用，01§4.14）──

/** 聚合读：事项+证据+片段+版本史+批次原文+媒体映射——get_item 工具与详情展开体共用（01§4.14）；
 *  rawInputs = fragments 引用到的批次原文（引文悬浮窗，05§三），按批次 id 索引；
 *  media（009）= 本事项文本/引文里出现的图片占位 → 本地媒体（过期或未缓存的 url 不进表）。 */
export function getItemFull(db: DbOrTx, id: string) {
  const item = deriveItem(db, id);
  if (!item) return null;
  const evidence = listEvidenceByItem(db, id);
  const fragments = evidence
    .map((e) => getFragment(db, e.fragmentId))
    .filter((f): f is Fragment => f !== null);
  const versions = deriveHistory(db, id);
  const rawInputs: Record<string, RawInput> = {};
  for (const frag of fragments) {
    const raw = getRawInput(db, frag.rawInputId);
    if (raw !== null && rawInputs[frag.rawInputId] === undefined) {
      rawInputs[frag.rawInputId] = raw;
    }
  }
  return {
    item,
    evidence,
    fragments,
    versions,
    rawInputs,
    media: mediaMapOf(db, rawInputs, fragments),
  };
}

/** 图片占位 → 本地媒体（009）：扫批次原文与引文片段里的 `[图片](url)`，
 *  本地占位按 sha256 命中、信源占位按 originUrl 反查。一次查全，前端不做 N+1。 */
function mediaMapOf(
  db: DbOrTx,
  rawInputs: Record<string, RawInput>,
  fragments: Fragment[],
): Record<string, MediaRefRow> {
  const urls = new Set<string>();
  for (const raw of Object.values(rawInputs)) {
    for (const u of extractImageUrls(raw.content)) urls.add(u);
  }
  for (const frag of fragments) {
    for (const u of extractImageUrls(frag.content)) urls.add(u);
  }
  if (urls.size === 0) return {};
  const localIds: string[] = [];
  const originUrls: string[] = [];
  for (const u of urls) {
    const localId = mediaIdFromUrl(u);
    if (localId !== null) localIds.push(localId);
    else originUrls.push(u);
  }
  const out: Record<string, MediaRefRow> = {};
  for (const row of getMediaByIds(db, localIds)) out[`/api/media/${row.id}`] = row;
  for (const u of originUrls) {
    const row = getMediaByOriginUrl(db, u);
    if (row !== null) out[u] = row;
  }
  return out;
}

/** 回收站保留天数（007，OQ-6）：固定 15 天，首版不做设置项。 */
const PURGE_DAYS = 15;

/** 一键清理回收站（007）：物理清除**进入 trashed 超过 PURGE_DAYS 天**的信息
 *  （按 trashedAt——进入回收站的时刻，非创建时刻，用户 2026-10-16 定）。
 *  删 item_versions / evidence / item_views 中挂该 itemId 的行；**raw_inputs / fragments /
 *  uncertain_inputs 一律不碰**——原文档案是证据终端，永不随信息删除（FR-009）。
 *  ⚠️ 留痕不在这里写：调用方在**事务提交成功后**才 stderr 输出（事务可能回滚，
 *  回滚时若已写「已彻底清除」就是假留痕——红线要求留痕必须属实）。
 *  返回 purged 计数 + 被清除条目清单（调用方据此留痕）。 */
export function purgeTrashed(tx: DbOrTx): {
  purged: number;
  items: { itemId: string; trashedAt: string; title: string; preStatus: string }[];
} {
  const cutoff = wallClockDaysAgo(PURGE_DAYS);
  const stale: { itemId: string; trashedAt: string; title: string; preStatus: string }[] = [];
  for (const r of deriveItemsWithVersion(tx)) {
    if (r.item.status !== "trashed") continue;
    const at = trashedAtOf(tx, r.item.id);
    if (at === null || at >= cutoff) continue;
    // 留痕要能回答「删了什么、原来是完成还是待办」（FR-009）——在删除前把它取出来
    stale.push({
      itemId: r.item.id,
      trashedAt: at,
      title: r.item.elements.find((e) => e.label === "name")?.text ?? "（无名）",
      preStatus: preTrashStatus(tx, r.item.id) ?? "未知", // 不可考时如实记"未知"，不编造
    });
  }

  for (const { itemId } of stale) {
    tx.delete(s.evidence).where(eq(s.evidence.itemId, itemId)).run();
    tx.delete(s.itemViews).where(eq(s.itemViews.itemId, itemId)).run();
    tx.delete(s.itemVersions).where(eq(s.itemVersions.itemId, itemId)).run();
  }
  return { purged: stale.length, items: stale };
}
