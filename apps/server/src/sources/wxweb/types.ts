import { z } from "zod";
import { parseWallClock } from "../../shared/time";

// 微信消息上报（wxweb）的事件形状（docs/14 第 4 节）。
// 协议私有，schema 住边界——不进 packages/shared（那是跨边界契约层）。
//
// 报文字形**兼容 OneBot 11**，但**不能直接复用 nc 的解析器**：
// ① 自己发的消息要按 `wx.is_self` 判（见下），nc 没有这个概念；
// ② 会话键在 `wx.conv_id`（群是 `<数字>@chatroom`、私聊是对方 wxid），
//    而不是 nc 的 `group_id` / `sender.user_id`；
// ③ 非文本消息只上报占位文本（`[图片]` 等）+ 类型号，没有 URL 段；
// ④ `reply` 段的 id 是**本条自己的 local_id**，不是被引用消息（docs/14 §4.4）。

/** 消息段：当前只有 text 与 reply 两种（docs/14 §4.5）。
 *  data 建成开放字典——协议承诺只增，未知段型不炸整条事件。 */
const WxSegmentSchema = z.object({
  type: z.string(),
  data: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform((v) => v ?? undefined),
});

/** 宽松 id：string/number/null/缺席 → string | undefined（数字转字符串，null 归缺席）。
 *  ⚠️ 微信 wxid 会出现带后缀与不带后缀两种写法，**不要**拿 `user_id` 与 `self_id` 比字符串。 */
const IdLikeSchema = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined ? undefined : String(v)));

/** `wx` 扩展字段：标准 OneBot 解析器会忽略它，**但本源的会话键与自身判据都在这里**。 */
const WxExtraSchema = z
  .object({
    /** 会话原始 id：群 = `<数字>@chatroom`，私聊 = 对方 wxid。**会话键用它**。 */
    conv_id: z.string().min(1),
    sender_name: z.string().nullish(),
    /** **是否本账号自己发的**——判自身只认它（`user_id == self_id` 会因 wxid 后缀而不等）。 */
    is_self: z
      .union([z.boolean(), z.number(), z.string()])
      .nullish()
      .transform((v) => {
        if (typeof v === "boolean") return v;
        if (typeof v === "number") return v !== 0;
        if (typeof v === "string") {
          const t = v.trim().toLowerCase();
          if (t === "true" || t === "1") return true;
          if (t === "false" || t === "0") return false;
        }
        // 认不出 = **不知道是不是自己发的** → 按「是」处理（丢弃）。
        // 宁可漏收，不可把用户自己说的话当成「别人告诉我的事」灌进管道。
        return true;
      }),
    quote_from: z.string().nullish(),
    /** 会话在上游那边的名字（群名 / 对方备注或昵称）。**会随群改名而变**——
     *  所以它只进 identity 作参考，不做 displayName（那个用你填的白名单备注，永不随上游变）。 */
    conv_name: z.string().nullish(),
  })
  // 保留未声明的字段：`raw_inputs.raw` 是「查回原文」的存档，上游的 type / type_name /
  // conv_name / raw（引用的原正文）都在里面。解析时**只读需要的几个**，但不许把它们丢掉。
  .loose();

/** 可信的 Unix 秒区间：1970-01-01 ~ 2100-01-01。
 *  区间外的值一律当「没给」——理由见 `WxEventSchema.time`。 */
const MIN_UNIX_SECONDS = 1;
const MAX_UNIX_SECONDS = 4_102_444_800;

/** 一条上报事件。宽松字段一律 nullish——严格形状会让整条事件 safeParse 失败 → 静默丢。 */
export const WxEventSchema = z
  .object({
    post_type: z.literal("message"),
    message_type: z.enum(["group", "private"]),
    message_id: z.union([z.string(), z.number()]).transform(String),
    user_id: IdLikeSchema,
    raw_message: z
      .string()
      .nullish()
      .transform((v) => v ?? ""),
    /** Unix **秒**。缺失/null/不可信 → 存 null（**不用接收时刻兜底**，01§5.3）。
     *
     *  只收落在可信区间的值（1970-01-01 ~ 2100-01-01）。为什么不能只判 `Number.isFinite`：
     *  · 上游若误发**毫秒**（`1793101146000`），会被算成 58791 年 → 墙钟串过不了 ingest 的格式校验；
     *  · `1e308` 之类会算出 `NaN-NaN-NaNTNaN:NaN:NaN`。
     *  两种都会让这一批**永远封不出去**（见 index.ts 的封批失败处理）。
     *  `0` / 负数也归 null——那是「没给」而不是「1970 年」。
     *  官方示例里是数字；兼容字符串形态（历史上见过桥接发字符串）。 */
    time: z
      .union([z.number(), z.string()])
      .nullish()
      .transform((v) => {
        const n =
          typeof v === "number"
            ? v
            : typeof v === "string" && v.trim() !== ""
              ? Number(v.trim())
              : Number.NaN;
        if (!Number.isFinite(n)) return null;
        return n >= MIN_UNIX_SECONDS && n <= MAX_UNIX_SECONDS ? n : null;
      }),
    message: z
      .array(WxSegmentSchema)
      .nullish()
      .transform((v) => v ?? undefined),
    sender: z
      .object({
        user_id: IdLikeSchema,
        nickname: z.string().nullish(),
        card: z.string().nullish(),
        // role 不收：docs/14 §4.6 明说恒为 "member"（上游暂不区分群主/管理员）
      })
      .loose() // 存档要完整：上游多给的字段别丢
      .nullish()
      .transform((v) => v ?? undefined),
    wx: WxExtraSchema,
  })
  // 保留未声明的顶层字段（self_id / group_id / font / anonymous 等）：
  // `raw_inputs.raw` 是「查回原文」的存档，解析时只读需要的几个，但不许把它们丢掉。
  .loose();
export type WxEvent = z.infer<typeof WxEventSchema>;

// ── 打包缓冲（信源私有内存态，按会话分组；与 nc 同构，不建事件表）──

export interface BufferedEvent {
  messageId: string;
  content: string; // 单条消息文本（非文本消息已由协议层给出占位文本）
  sender: string;
  senderId: string;
  displayName: string; // 会话显示名——**白名单里你填的备注**（不是上游的 conv_name）
  conversationName: string | null; // 上游那边的会话名（群名/昵称）；null = 上游没给
  at: string; // 机械时刻（消息自带时刻；无真时刻则按接收时刻）——只用于去抖与行前缀
  trueTime: boolean; // at 是否消息自带真时刻——false 时 eventTime 必须置 null（01§5.3 禁接收兜底）
  raw: WxEvent; // 原始事件留底
}

export interface GroupBuffer {
  groupId: string; // 会话键（conv_id）
  events: BufferedEvent[];
  /** 组内最后一条消息的**消息时刻**——行协议与 eventTime 用。 */
  lastAt: string;
  /** 组内最后一条消息**进入缓冲的时刻**——静默闸用它（补推积压时消息时刻会带偏闸门）。 */
  lastSeenAt?: string;
  /** 组内正文累计字节（字节闸用）。缺省 0 只服务纯函数调用方。 */
  bytes?: number;
  /** 本组**首条进入缓冲**的时刻——龄期闸从它起算。 */
  firstSeenAt?: string;
}

/** 组装好的批次（纯函数产物，不含 ingest 副作用）。 */
export interface SealedBatch {
  content: string;
  hasContent: boolean; // 批内是否有任何非空正文——空批守卫的依据（行前缀会让 content 恒非空）
  eventTime: string | null; // 批内最早一条带真时刻消息的时刻；全批无真时刻 → null
  raw: WxEvent[];
  sender?: string; // 批内唯一发送者才写；多人批次省略——身份由行协议逐行承载（D-91）
}

/** 封批四闸的阈值（与 nc 同语义，D-127 / D-129）：任一命中即封批。 */
export interface SealThresholds {
  windowMinutes: number;
  maxEvents: number;
  maxBytes: number;
  maxAgeMinutes: number;
}

/** 命中任一闸的组——纯函数，便于测试。
 *
 *  @param buffers 各组缓冲
 *  @param nowMs 当前时刻（epoch ms）——闸门的唯一时间基准
 *  @param t 阈值
 */
export function dueGroups(
  buffers: Map<string, GroupBuffer>,
  nowMs: number,
  t: SealThresholds,
): GroupBuffer[] {
  const windowMs = t.windowMinutes * 60_000;
  const ageMs = t.maxAgeMinutes * 60_000;
  const due: GroupBuffer[] = [];
  for (const buf of buffers.values()) {
    if (buf.events.length === 0) continue;
    if (buf.events.length >= t.maxEvents || (buf.bytes ?? 0) >= t.maxBytes) {
      due.push(buf);
      continue;
    }
    // 龄期闸：从「首条进入缓冲」算——忙群连续说话也照样到期（崩溃丢失有上界）
    const firstMs = buf.firstSeenAt === undefined ? Number.NaN : parseWallClock(buf.firstSeenAt);
    if (!Number.isNaN(firstMs) && nowMs - firstMs >= ageMs) {
      due.push(buf);
      continue;
    }
    // 静默闸：从**最后一条到达**算（不是消息时刻——补推积压会误判成「早已安静」）
    const lastMs = parseWallClock(buf.lastSeenAt ?? buf.lastAt);
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

/** 把所有「会被当成换行」的字符折成空格。
 *
 *  只折 `\n` 不够：`\r`、U+2028（行分隔符）、U+2029（段分隔符）在渲染器与分词器眼里也是换行——
 *  漏掉它们，一个带这些字符的微信备注仍能在正文里伪造出「[10:00] 别人: …」那样的一行。
 */
function folded(text: string): string {
  return text.replace(/[\r\u2028\u2029]+/g, " ").replaceAll("\n", " ");
}

/** 显示名净化（只影响协议前缀，正文不动）：换行先折、**全部**半角冒号换全角——
 *  名字内不再含结构分隔符；尾部冒号与空白剥掉防「名字：: 正文」双分隔。与 nc 同一套口径（D-91）。 */
function safeSpeakerName(rawName: string): string {
  const name = folded(rawName).replaceAll(":", "：");
  return name.replace(/[：:\s]+$/, "");
}

/** 一条缓冲事件 → 行协议行：`[时刻] 发送者: 正文`。
 *  前缀只在行首、正文逐字不动——引文逐字校验因此不受影响。
 *  多行消息的续行缩进两空格：维持「每条一行有前缀」的归属边界。 */
function protocolLine(e: BufferedEvent, sameDay: boolean): string {
  // 兜底到 senderId 时同样要净化——id 也是外来字符串，同样能带换行伪造行
  const speaker =
    safeSpeakerName(e.sender) || (e.senderId !== "" ? safeSpeakerName(e.senderId) : "未知");
  const prefix = `${timePrefix(e.at, sameDay)} ${speaker}: `;
  if (!e.content.includes("\n")) return prefix + e.content;
  return e.content
    .split("\n")
    .map((line, i) => (i === 0 ? prefix + line : `  ${line}`))
    .join("\n");
}

/** 批内最早一条带真时刻的 `at`（全批无真时刻 → null）。
 *
 *  比较的是墙钟串——定宽北京墙钟（D-64）下字典序 = 时间序，可以直接比字符串。
 */
function earliestTrueTime(events: BufferedEvent[]): string | null {
  let best: string | null = null;
  for (const e of events) {
    if (!e.trueTime) continue;
    if (best === null || e.at < best) best = e.at;
  }
  return best;
}

/** 把一批事件合并成行协议批次内容（每条一行；**批内最早时刻**为 eventTime；specs/003 D-91）。 */
export function assembleBatch(buf: GroupBuffer): SealedBatch {
  const first = buf.events[0];
  if (!first) throw new Error(`会话 ${buf.groupId} 缓冲为空，不应封批`);
  const firstDate = dateOf(first.at);
  const sameDay = buf.events.every((e) => dateOf(e.at) === firstDate);
  // 发话人按 senderId 去重；单条或全员有 id 才允许署名——缺 id 无法确证「唯一」时宁缺勿谎
  const speakers = new Set(buf.events.map((e) => e.senderId));
  const trustworthy = buf.events.length === 1 || buf.events.every((e) => e.senderId !== "");
  return {
    content: buf.events.map((e) => protocolLine(e, sameDay)).join("\n"),
    hasContent: buf.events.some((e) => e.content.trim() !== ""),
    // 事件时间取批内**最早**一条带真时刻的消息；全批无真时刻 → null（禁接收兜底，01§5.3）。
    // 必须是「最早」而不是「最先到」：上游补推/乱序是常态（docs/14 §7），
    // 按到达序取第一条会把整批的锚点定晚（相对日期解析跟着错）。
    eventTime: earliestTrueTime(buf.events),
    raw: buf.events.map((e) => e.raw),
    // 显示名兜「未知」= 根本不知道谁发的——「未知」不署名（宁缺勿谎）
    sender:
      trustworthy && speakers.size === 1 && first.sender !== "未知" ? first.sender : undefined,
  };
}
