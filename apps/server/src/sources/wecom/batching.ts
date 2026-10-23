import { parseWallClock } from "../../shared/time";

// 微信客服的分流缓冲与封批判定（D-128/D-129）。
//
// 为什么这份逻辑住在信源里、而不是 core 的通用件：**分批是「打包」的一部分，属于信源自己的事**
// （D-84 原文：「信源自己解释协议、自己打包、自己管设置」）。本该如此——通用件 `BatchLine`
// 里塞着 nc 的 `role`、缺本信源的 `mediaId`/`fromCustomer`，那只是把一家的形状当成大家的形状。
// 代价是闸门逻辑每个信源各有一份（改一处要同步别处）；用「docs/07 接新源检查单把四闸写成
// 必须项 + 各自的测试」来兜，而不是再造一个只有两个用户的抽象。
//
// 单入口多流在本信源的具体形态：一个回调 URL 收所有客服账号、所有客户的事件——
// 流键 = open_kfid + external_userid（某客服账号与某位客户的这段对话）。

/** 一条待分组的客服消息（从 sync_msg 的协议字段映射而来）。 */
export interface KfLine {
  messageId: string | null;
  content: string;
  sender: string;
  senderId: string | null;
  /** 消息自带时刻（北京墙钟）；null = 无真时刻（禁止用接收时间兜底，01§5.3） */
  at: string | null;
  /** 媒体 id（图片等）；null = 纯文本 */
  mediaId: string | null;
  /** 该消息来自客户（true）还是客服/系统（false）——身份里要能分辨 */
  fromCustomer: boolean;
}

/** 一条对话的缓冲。 */
export interface KfBuffer {
  /** 流键 = `${openKfid}\u0000${externalUserId}` */
  key: string;
  /** 展示名（由本信源自定，如「客户 <尾号>」） */
  displayName: string;
  lines: KfLine[];
  /** 最后一条消息的**消息时刻**（行协议与 eventTime 用） */
  lastAt: string;
  /** 最后一条消息**进入缓冲的时刻**——静默闸用它。
   *
   *  为什么不拿 lastAt：那是消息自带时刻。拉取补推积压消息时每条都带着几小时前的时刻，
   *  按它算静默会把**刚到达**的一批判成「已安静几小时」，立刻切段并切成一条一条。 */
  lastSeenAt?: string;
  /** 首条进入缓冲的时刻——龄期闸从它起算（同上，为了不被补推的旧时刻带偏） */
  firstSeenAt?: string;
  /** 正文累计字节（字节闸用） */
  bytes?: number;
}

/** 封批四闸的阈值：两个时间阀（用户可调）+ 两个量阀（保底）。 */
export interface KfThresholds {
  /** 静默闸：最后一条**到达**距今 ≥ 此值 */
  windowMinutes: number;
  /** 龄期闸：距**进入缓冲**已 ≥ 此值（一直有新消息也照样切） */
  maxAgeMinutes: number;
  /** 条数闸：批内消息数 ≥ 此值（保底，防异常刷屏） */
  maxEvents: number;
  /** 字节闸：批内正文累计字节 ≥ 此值（保底，防单批撑爆） */
  maxBytes: number;
}

/** 默认阈值（静默 3 / 跨度 10 与 nc 同口径；量阀为保底）。 */
export const DEFAULT_KF_THRESHOLDS: KfThresholds = {
  windowMinutes: 3,
  maxAgeMinutes: 10,
  maxEvents: 50,
  maxBytes: 20 * 1024,
};

/** 命中任一闸的流 —— 纯函数，便于测试。
 *
 * @param buffers 各流缓冲
 * @param nowMs 当前时刻（epoch ms）——**闸门的唯一时间基准**
 * @param t 阈值
 */
export function dueStreams(
  buffers: Map<string, KfBuffer>,
  nowMs: number,
  t: KfThresholds,
): KfBuffer[] {
  const windowMs = t.windowMinutes * 60_000;
  const ageMs = t.maxAgeMinutes * 60_000;
  const due: KfBuffer[] = [];
  for (const buf of buffers.values()) {
    if (buf.lines.length === 0) continue; // 空流不该存在（入缓冲即至少一条）；防御性跳过
    // 量阀：与时刻无关
    if (buf.lines.length >= t.maxEvents || (buf.bytes ?? 0) >= t.maxBytes) {
      due.push(buf);
      continue;
    }
    // 龄期闸：从「首条进入缓冲」算——忙流连续有新消息也照样到期
    const firstMs = buf.firstSeenAt === undefined ? Number.NaN : parseWallClock(buf.firstSeenAt);
    if (!Number.isNaN(firstMs) && nowMs - firstMs >= ageMs) {
      due.push(buf);
      continue;
    }
    // 静默闸：从**最后一条到达**算
    const lastMs = parseWallClock(buf.lastSeenAt ?? buf.lastAt);
    if (!Number.isNaN(lastMs) && nowMs - lastMs >= windowMs) due.push(buf);
  }
  return due;
}

/** 把一条消息并进对应流的缓冲（流不存在则新建）。纯内存，无副作用外溢。
 *
 * @param buffers 流缓冲表（原地更新）
 * @param key 流键
 * @param displayName 流展示名（新流时写入；已存在则保留最先看到的那个，昵称中途改来改去会让批次名漂移）
 * @param line 消息
 * @param seenAt 到达时刻（北京墙钟）
 */
export function appendLine(
  buffers: Map<string, KfBuffer>,
  key: string,
  displayName: string,
  line: KfLine,
  seenAt: string,
): void {
  const bytes = Buffer.byteLength(line.content, "utf8");
  const existing = buffers.get(key);
  if (existing !== undefined) {
    existing.lines.push(line);
    existing.lastAt = line.at ?? existing.lastAt;
    existing.lastSeenAt = seenAt;
    existing.bytes = (existing.bytes ?? 0) + bytes;
    return;
  }
  buffers.set(key, {
    key,
    displayName,
    lines: [line],
    lastAt: line.at ?? seenAt,
    lastSeenAt: seenAt,
    firstSeenAt: seenAt,
    bytes,
  });
}
