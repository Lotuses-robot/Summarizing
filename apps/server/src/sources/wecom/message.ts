import { z } from "zod";
import { wallClockFromUnix } from "../../shared/time";
import type { KfLine } from "./batching";

// 微信客服消息的**协议形状**（D-128）：一条 `sync_msg` 消息长什么样、怎么映射成一行。
//
// 这份知识住信源侧，不住 Router——Router 只转交 `raw`（`unknown`），它只需要读到分流用的
// `external_userid` / `open_kfid` / `origin` 三个字段，其余一律不解释（D-130）。
// 依赖方向因此保持单向：`router/ → sources/`，信源完全不知道 Router 存在。

/** sync_msg 返回的一条消息（字段名对照官方文档；缺失字段按「不认这条」处理，不猜）。 */
export interface KfMessage {
  msgid?: string;
  open_kfid?: string;
  external_userid?: string;
  /** unix 秒（官方类型 **uint64**，示例是裸数字 `"send_time": 1615478585`——不是字符串）。
   *  `KfMessageSchema` 也接受历史的字符串写法，所以这里两种都收；`mapMessage` 统一 Number() 归一。 */
  send_time?: number | string;
  /** 消息来源：3 = 微信客户，4 = 系统事件，5 = 接待人员（官方文档 msg_list.origin） */
  origin?: number;
  /** 发送该消息的接待人员 userid（仅 origin=5 时返回） */
  servicer_userid?: string;
  msgtype?: string;
  text?: { content?: string };
  image?: { media_id?: string };
  voice?: { media_id?: string };
  video?: { media_id?: string };
  file?: { media_id?: string };
  event?: { event_type?: string; open_kfid?: string; external_userid?: string };
}

/** `KfMessage` 的运行时校验（信源 `accept` 用它解 `raw`——Router 交来的是 `unknown`）。
 *
 *  为什么宽松（字段全 optional）：企业微信的字段随消息类型变化（文本没有 image、事件没有 open_kfid），
 *  严格 schema 会把合法的消息判成坏形状。这里只保证「是对象、字段类型对」，语义判断在 `mapMessage`。
 */
export const KfMessageSchema = z.object({
  msgid: z.string().optional(),
  open_kfid: z.string().optional(),
  external_userid: z.string().optional(),
  // 官方是 uint64（裸数字）。历史写法（字符串）一并接受——宽容**输入形状**不等于编造语义：
  // 两种形状都表达同一件事（unix 秒），解析成 Number 后完全一致；只收数字会让真实消息整条被拒。
  send_time: z.union([z.number(), z.string()]).optional(),
  origin: z.number().optional(),
  servicer_userid: z.string().optional(),
  msgtype: z.string().optional(),
  text: z.object({ content: z.string().optional() }).optional(),
  image: z.object({ media_id: z.string().optional() }).optional(),
  voice: z.object({ media_id: z.string().optional() }).optional(),
  video: z.object({ media_id: z.string().optional() }).optional(),
  file: z.object({ media_id: z.string().optional() }).optional(),
  event: z
    .object({
      event_type: z.string().optional(),
      open_kfid: z.string().optional(),
      external_userid: z.string().optional(),
    })
    .optional(),
});

/** 本信源的行形状——即通用行形状（起别名只为在文件内读着顺）。 */
type MappedLine = KfLine;

/** 消息正文里给媒体的占位：沿用全站 `[图片](url)` 形状，url 段放 `wecom-media:<id>` 伪协议。
 *
 *  为什么用伪协议而不是真实 URL：媒体下载需要 access_token，而 token 不该出现在原文里
 *  （原文会进提示词、进导出、进界面）。伪协议让「这里有一张图」这个事实进正文，
 *  真正的取字节由 Router 注册到该账户的取字节实现按 id 去换——与 QQ 图片占位走的是同一条思路。
 */
function mediaPlaceholder(mediaId: string, kind: "图片" | "语音" | "视频" | "文件"): string {
  return kind === "图片" ? `[图片](wecom-media:${mediaId})` : `[${kind}](wecom-media:${mediaId})`;
}

/** 消息来源（官方文档 `msg_list.origin`）：3 = 微信客户，4 = 系统事件，5 = 接待人员（客服）。
 *
 *  为什么必须按 origin 判方向、而不是「有没有 external_userid」：**三个来源都带 external_userid**
 *  （客服回复客户时也带——那是「这条消息属于哪段对话」的键）。早先按后者判会把客服的回复
 *  误标成「客户说的」，还会把同一段对话的两个方向分到不同流里去。
 */
const ORIGIN_CUSTOMER = 3;
const ORIGIN_SERVICER = 5;

/** unix 秒 → 北京墙钟；拿不到**真时刻**就 null（不许兜成接收时间或 1970，01§5.3）。
 *
 *  脏形态：缺字段 / 空串 / 非数字 / `0` / 负数——都按「没有时刻」处理。
 *  为什么 `0` 也拒：unix 0 = 1970，那不是这条消息的时刻，是字段没填。
 */
function unixSecondsToWallClock(raw: number | string): string | null {
  const seconds = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return wallClockFromUnix(seconds);
}

/** 一条 sync_msg 消息 → 可入批的行；不认识的类型返回 null（留痕后丢弃，不猜内容）。 */
export function mapMessage(msg: KfMessage): MappedLine | null {
  const at = msg.send_time === undefined ? null : unixSecondsToWallClock(msg.send_time);
  const externalUserId = msg.external_userid ?? "";
  const messageId = msg.msgid ?? null;
  const fromCustomer = msg.origin === ORIGIN_CUSTOMER;
  // 客服回复时署名到接待人员（servicer_userid 只在 origin=5 时返回）；客户消息署客户 id
  const sender =
    msg.origin === ORIGIN_SERVICER && msg.servicer_userid !== undefined
      ? `客服 ${msg.servicer_userid}`
      : fromCustomer
        ? externalUserId
        : "客服";
  const base = {
    messageId,
    sender,
    senderId: fromCustomer ? externalUserId : null,
    at,
    fromCustomer,
  };
  switch (msg.msgtype) {
    case "text": {
      const content = msg.text?.content ?? "";
      return content.trim() === "" ? null : { ...base, content, mediaId: null };
    }
    case "image": {
      const id = msg.image?.media_id;
      return id === undefined
        ? null
        : { ...base, content: mediaPlaceholder(id, "图片"), mediaId: id };
    }
    case "voice": {
      const id = msg.voice?.media_id;
      return id === undefined
        ? null
        : { ...base, content: mediaPlaceholder(id, "语音"), mediaId: id };
    }
    case "video": {
      const id = msg.video?.media_id;
      return id === undefined
        ? null
        : { ...base, content: mediaPlaceholder(id, "视频"), mediaId: id };
    }
    case "file": {
      const id = msg.file?.media_id;
      return id === undefined
        ? null
        : { ...base, content: mediaPlaceholder(id, "文件"), mediaId: id };
    }
    case "event": {
      // 事件（进入会话/会话状态变更）不含可提取的信息——留痕丢弃
      return null;
    }
    case undefined:
    default:
      // 未知/缺失 msgtype：不猜内容（宁可丢一条，也不把看不懂的字段塞进原文）
      return null;
  }
}
