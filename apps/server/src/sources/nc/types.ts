import { z } from "zod";

// nc 事件形状（只读对接，D-84 §3.1）：只收群消息，其余 204 丢弃。
// schema 住边界——nc 协议私有，不进 packages/shared（那是跨边界契约层）。

/** nc 消息段（message 数组元素）：只声明我们要读的两处（type 与 data），
 *  data 内部形状各异（url/text/qq/file…）——建成开放字典，取值时再逐项判类型。 */
const NcSegmentSchema = z.object({
  type: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type NcSegment = z.infer<typeof NcSegmentSchema>;

/** nc 上报的群消息事件（取用到的字段；message 段数组显式声明以免类型断言，其余未知字段放过）。
 *  ⚠️ 凡 nc 变体可能发 null 的宽松字段一律 nullish（NTQQ 系桥接实测会发 null）——严格形状会让
 *  整条事件 safeParse 失败 → 204 静默丢（三轮评审；role 为本轮新增字段，nickname/card/user_id
 *  为同款顺修）。
 *  ⚠️ time 缺失/null → 存 **null** 而非接收时刻——「事件时间用接收时间兜底」是 01§5.3 红线
 *  （五轮评审）；机械用途（去抖/行前缀）由 index.ts 另取接收时刻，真伪由 BufferedEvent.trueTime 区分。 */

/** 宽松 id 形状：string/number/null/缺席 → string | undefined（数字转字符串，null 归缺席；四轮评审收敛四份梯子）。 */
const IdLikeSchema = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined ? undefined : String(v)));

export const NcEventSchema = z.object({
  post_type: z.literal("message"),
  message_type: z.literal("group"), // 私聊不收（D-84 Q-F）
  group_id: z.union([z.string(), z.number()]).transform(String),
  message_id: z.union([z.string(), z.number()]).transform(String),
  user_id: IdLikeSchema,
  raw_message: z
    .string()
    .nullish()
    .transform((v) => v ?? ""),
  time: z
    .number()
    .nullish()
    .transform((v) => (typeof v === "number" ? v : null)),
  self_id: IdLikeSchema,
  message: z
    .array(NcSegmentSchema)
    .nullish()
    .transform((v) => v ?? undefined), // 段结构（图片/文本/at…）；纯文本事件可能缺席
  sender: z
    .object({
      user_id: IdLikeSchema,
      nickname: z.string().nullish(),
      card: z.string().nullish(), // 群名片（有则比 nickname 更贴合群内身份）
      role: IdLikeSchema, // 群角色（specs/003）：宽松收 string/数字且容 null——归一与显示在 protocolLine
    })
    .optional(),
});
export type NcEvent = z.infer<typeof NcEventSchema>;

// ── 打包缓冲（信源私有内存态，按群分组；D-84 §3.3 不建事件表）──

export interface BufferedEvent {
  messageId: string;
  content: string; // 单条消息文本（图片段已在 filter 阶段转 [图片] 占位）
  sender: string; // 发信人显示名（群名片 > 昵称 > user_id）
  senderId: string;
  role?: string; // 群角色原文（owner/admin/member；nc 变体可能发漂移值——显示时归一，未知不显示）
  groupName: string; // 白名单里的群备注名（入缓冲时确定；封批直接用作 sourceIdentity.sourceLabel）
  at: string; // 机械时刻（消息自带时刻；桥接发 null 时按接收时刻）——只用于去抖与行前缀
  trueTime: boolean; // at 是否消息自带真时刻——false 时 eventTime 必须置 null（01§5.3 禁接收兜底）
  raw: NcEvent; // 原始事件留底
}

export interface GroupBuffer {
  groupId: string;
  events: BufferedEvent[];
  lastAt: string; // 组内最后一条消息时刻——去抖窗口从它起算
}

/** 从一组缓冲事件组装要投递的字段（纯函数；不含 ingest 副作用）。 */
export interface SealedBatch {
  groupId: string;
  content: string;
  hasContent: boolean; // 批内是否有任何非空正文——空批守卫的依据（行前缀会让 content 恒非空，specs/003 评审）
  eventTime: string | null; // 批内最早一条带真时刻消息的时刻；全批无真时刻 → null（禁接收兜底，01§5.3）
  raw: NcEvent[]; // 原事件数组留底
  sender?: string; // 批内唯一发送者才写；多人批次省略——身份由行协议逐行承载（D-91）
}

/** 命中窗口的组（静默 ≥ windowMinutes 才封批）——纯函数，便于测试。 */
export function dueGroups(
  buffers: Map<string, GroupBuffer>,
  nowMs: number,
  windowMinutes: number,
): GroupBuffer[] {
  const windowMs = windowMinutes * 60_000;
  const due: GroupBuffer[] = [];
  for (const buf of buffers.values()) {
    const lastMs = Date.parse(buf.lastAt);
    if (!Number.isNaN(lastMs) && nowMs - lastMs >= windowMs) due.push(buf);
  }
  return due;
}

/** 行内时刻前缀：同天批次 `[HH:mm]`；跨天批次 `[MM-DD HH:mm]`（消歧义，specs/003 FR-001）。 */
function timePrefix(at: string, sameDay: boolean): string {
  const [date, time] = at.split("T");
  const hm = (time ?? "").slice(0, 5);
  return sameDay ? `[${hm}]` : `[${(date ?? "").slice(5)} ${hm}]`;
}

/** 墙钟串的日期段（D-64：YYYY-MM-DDTHH:mm:ss 前段）——同天判定用。 */
const dateOf = (at: string): string => at.split("T")[0] ?? "";

/** 群身份括注的单点出处：protocolLine 据此追加、safeSpeakerName 据此剥除——两处永不漂移（四轮评审）。 */
const ROLE_LABELS: Record<string, string> = { owner: "（群主）", admin: "（管理员）" };

/** 显示名净化（只影响协议前缀，正文不动）：换行先折、**全部**半角冒号换全角——名字内不再含
 *  结构分隔符（五轮评审：裸「:」/结尾「：」同样致歧义）；再剥 ROLE_LABELS 身份括注字面量，
 *  防昵称冒充身份括注（三轮评审）；尾部冒号与空白剥掉防「名字：: 正文」双分隔（六轮评审）。 */
function safeSpeakerName(rawName: string): string {
  let name = rawName.replaceAll("\n", " ").replaceAll(":", "：");
  for (const label of Object.values(ROLE_LABELS)) name = name.replaceAll(label, "");
  return name.replace(/[：:\s]+$/, "");
}

/** 一条缓冲事件 → 行协议行：`[时刻] 发送者（身份）: 正文`。
 *  前缀只在行首、正文逐字不动——引文逐字校验（fence 对 content 空白归一查子串）因此不受影响。
 *  多行消息的续行缩进两空格：维持「每条一行有前缀」的归属边界（空白归一不伤引文，评审修正）。
 *  角色小写归一后只认 owner/admin（nc 变体大小写/数字漂移；未知值不显示，specs/003 评审修正）。
 *  净化后名字可能为空（昵称恰好是身份字面量）→ 退回 senderId 或「未知」（四轮评审）。 */
function protocolLine(e: BufferedEvent, sameDay: boolean): string {
  const role = (e.role && ROLE_LABELS[e.role.toLowerCase()]) || "";
  const speaker = safeSpeakerName(e.sender) || (e.senderId !== "" ? e.senderId : "未知");
  const prefix = `${timePrefix(e.at, sameDay)} ${speaker}${role}: `;
  if (!e.content.includes("\n")) return prefix + e.content;
  return e.content
    .split("\n")
    .map((line, i) => (i === 0 ? prefix + line : `  ${line}`))
    .join("\n");
}

/** 把一批事件合并成行协议批次内容（每条一行；组内首条时刻为 eventTime；specs/003 D-91）。 */
export function assembleBatch(buf: GroupBuffer): SealedBatch {
  const first = buf.events[0];
  if (!first) throw new Error(`组 ${buf.groupId} 缓冲为空，不应封批`);
  const firstDate = dateOf(first.at);
  const sameDay = buf.events.every((e) => dateOf(e.at) === firstDate);
  // 发话人按 senderId 去重；trustworthy（单条批次或全员有 id）才允许署名——缺 id 无法确证
  // 「唯一」时宁缺勿谎，多消息批次省略 sender（三轮/四轮评审）。
  const speakers = new Set(buf.events.map((e) => e.senderId));
  const trustworthy = buf.events.length === 1 || buf.events.every((e) => e.senderId !== "");
  return {
    groupId: buf.groupId,
    content: buf.events.map((e) => protocolLine(e, sameDay)).join("\n"),
    hasContent: buf.events.some((e) => e.content.trim() !== ""),
    // 事件时间取批内最早一条带真时刻的消息；全批无真时刻 → null（禁接收兜底，01§5.3；六轮评审定语义）
    eventTime: buf.events.find((e) => e.trueTime)?.at ?? null,
    raw: buf.events.map((e) => e.raw),
    // 显示名兜「未知」= 根本不知道谁发的——「未知」不署名（宁缺勿谎，五轮评审）
    sender:
      trustworthy && speakers.size === 1 && first.sender !== "未知" ? first.sender : undefined,
  };
}
