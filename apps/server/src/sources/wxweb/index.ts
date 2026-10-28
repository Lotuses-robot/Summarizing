import type {
  AcceptResult,
  ActivitySignal,
  SettingField,
  SourceAdapter,
  SourceContext,
  WebhookRegistrar,
} from "../types";
import { wallClockFromUnix, nowWallClock } from "../../shared/time";
import {
  assembleBatch,
  dueGroups,
  WxEventSchema,
  type BufferedEvent,
  type GroupBuffer,
  type SealThresholds,
  type WxEvent,
} from "./types";

// 微信消息只读适配器（docs/14）：HTTP WebHook 快收 204 → 私有内存缓冲（按会话分组）
// → 去抖封批 → ctx.ingest（与 nc / 手动源同一条管线）。只读：不发消息、不代操作。
//
// 与 nc 的形态相同（每账户一份、地址带令牌、白名单制、四闸封批），差异都在协议字段上：
// 会话键取 `wx.conv_id`、自身消息按 `wx.is_self` 判、非文本消息只有占位文本。
//
// 归属与生命周期：缓冲区是本适配器私有内存态，core 不读写；崩溃丢最近 ≤1 个窗口
// （消息仍在微信里，可事后从上游 outbox 补）；关闭时 stop() 尽力强制封批。

/** 源的唯一短名：source、信源设置命名空间、from 排障标记共用。 */
const WX_SOURCE_NAME = "wxweb";
const DEFAULT_WINDOW_MINUTES = 3;
/** 四闸默认值（与 nc 同语义，D-127 / D-129）：两个时间阀用户可调，两个量阀保底防 OOM。 */
const DEFAULT_MAX_EVENTS = 50;
const DEFAULT_MAX_BYTES = 20 * 1024;
const DEFAULT_MAX_AGE_MINUTES = 10;
export const SWEEP_INTERVAL_MS = 5_000;
/** 封批失败后的退避（指数；成功即复位）——防止量闸恒命中导致每 5 秒刷错。 */
const SEAL_BACKOFF_MIN_MS = 30_000;
const SEAL_BACKOFF_MAX_MS = 10 * 60_000;
/** 连续失败多少次就放弃这一批（**换新消息也不会重置**：坏的是这批，不是连接）。
 *  上限取 5：退避 30s→60s→120s→240s→480s，约 15 分钟仍封不出去，基本可以判定不是瞬态。 */
export const SEAL_MAX_ATTEMPTS = 5;
const RECENT_ID_LIMIT = 500;

/** 会话类型原文 → 中文措辞（日志多处共用；兜底取中性「会话」）。 */
function kindWordOf(messageType: string): string {
  if (messageType === "group") return "群";
  if (messageType === "private") return "私聊";
  return "会话";
}

/** 会话白名单：`Record<conv_id, 备注名>`（备注名供 displayName）。
 *  键 = `wx.conv_id` 原文（群是 `<数字>@chatroom`、私聊是对方 wxid）——**不做任何归一**：
 *  它是上游给的稳定 id，用户照抄即可；替他剥壳猜本意违反 D-103。
 *  缺省/空对象/非对象 → null（= 未配置 = 全丢，fail-closed，同 nc）。 */
function readWhitelist(ctx: SourceContext): Map<string, string> | null {
  const v = ctx.getSetting("conversations");
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  // 用 Map 而不是对象：`conv_id` 是外来字符串，`{}` 会让 "constructor"/"__proto__"/"toString"
  // 命中 Object.prototype 上的成员，绕过 fail-closed 白名单
  // （随后 displayName 拿到一个函数，封批时 .trim() 抛错 → 定时器回调里没人接 → 进程退出）。
  const out = new Map<string, string>();
  for (const [k, val] of Object.entries(v)) {
    if (k !== "" && typeof val === "string" && val.trim() !== "") out.set(k, val);
  }
  return out.size > 0 ? out : null;
}

/** 白名单查名（Map 天然没有原型链成员，直接 get）。 */
function whitelistLabel(whitelist: Map<string, string>, key: string): string | undefined {
  return whitelist.get(key);
}

/** 消息段 → 正文（docs/14 §4.5：当前只有 text 与 reply 两种）。
 *
 *  `reply` 段**不产出文本**：它的 `data.id` 是本条自己的 local_id，不是被引用消息
 *  （docs/14 §4.4）——写进正文只会是误导。被引用人的显示名在 `wx.quote_from`，
 *  这里以「（回复 X）」前缀表达，正文保持逐字。
 *
 *  @param ev 已过 schema 的事件
 */
function textFromSegments(ev: WxEvent): string {
  const segments = ev.message;
  /** 正文：有段结构就从文本段拼，否则退回上游给的纯文本（`[图片]` 等占位也在这里）。 */
  const rawBody =
    segments === undefined
      ? ev.raw_message
      : (() => {
          const parts: string[] = [];
          for (const seg of segments) {
            if (seg.type === "text") {
              const t = seg.data?.["text"];
              if (typeof t === "string") parts.push(t);
            }
            // 其余段型不展开：非文本消息上游已转成占位文本
          }
          // 判「有没有真取到文字」，不是「有没有段」：上游给非文本消息时可能带一个空文本段，
          // 那时要退回占位文本（`[图片]` 等），否则整条被当空批丢掉。
          const joined = parts.join("");
          return joined.trim() !== "" ? joined : ev.raw_message;
        })();
  // **「（回复 X）」只加在真有人说的话前面**：正文为空时（比如一张上游没给占位文本的贴纸）
  // 加前缀会把空批衬成非空，让下游的空批守卫失效——一批「只有引用、没有内容」的消息
  // 就会照样进 AI 消化。
  if (rawBody.trim() === "") return rawBody;
  const quoteFrom = ev.wx.quote_from;
  if (typeof quoteFrom !== "string" || quoteFrom.trim() === "") return rawBody;
  // 与发信人名字同一套折叠：换行折成空格、半角冒号换全角——
  // 否则一个带换行的微信备注就能在正文里伪造出「[10:00] 别人: …」这样的一行。
  const safe = quoteFrom.trim().replaceAll("\n", " ").replaceAll(":", "：");
  return `（回复 ${safe}）${rawBody}`;
}

/** 发信人显示名（昵称 > 群名片 > user_id > 「未知」）。 */
function senderName(ev: WxEvent): string {
  /** 取第一个非空串（null/空串都跳过）。 */
  const first = (v: string | null | undefined): string | null =>
    typeof v === "string" && v.trim() !== "" ? v : null;
  return (
    first(ev.wx.sender_name) ??
    first(ev.sender?.card) ??
    first(ev.sender?.nickname) ??
    first(ev.sender?.user_id) ??
    first(ev.user_id) ??
    "未知"
  );
}

/** 一条事件 → 缓冲条目（webhook 与 `accept` 共用——两条入口的规范化必须一致）。
 *
 *  @param ev 已过 schema 的事件
 *  @param label 白名单里的备注名（封批时用作 displayName）
 */
function toBufferedEvent(ev: WxEvent, label: string): BufferedEvent {
  return {
    messageId: ev.message_id,
    content: textFromSegments(ev),
    sender: senderName(ev),
    senderId: ev.sender?.user_id ?? ev.user_id ?? "",
    displayName: label,
    conversationName: ev.wx.conv_name?.trim() || null,
    // 机械时刻（去抖/行前缀用）——无真时刻时按接收时刻；真伪由 trueTime 区分
    at: ev.time === null ? nowWallClock() : wallClockFromUnix(ev.time),
    trueTime: ev.time !== null,
    raw: ev,
  };
}

/** 显示名兜底（ingest schema 要求 displayName 非空）。 */
function displayNameOfGroup(buf: GroupBuffer): string {
  const name = buf.events[0]?.displayName.trim();
  if (name !== undefined && name !== "") return name;
  return buf.groupId !== "" ? buf.groupId : "未知来源";
}

/** 微信消息只读适配器：register 里登记 webhook（`/event` → 可达 `/hook/<令牌>/wxweb/event`）
 *  + 起封批扫描定时器。停止时（空间关停）`stop()` 强制封批全部会话。 */
export function makeWxwebAdapter(): SourceAdapter {
  const buffers = new Map<string, GroupBuffer>();
  const recentIds = new Set<string>();
  const warnedDropped = new Set<string>(); // 已告警过的会话（每个只报一次，防刷屏）
  /** 告警去重的上限：会话 id 来自外部，不封顶就是一条只增不减的泄漏。 */
  const WARNED_LIMIT = 500;
  let runtime: { ctx: SourceContext; thresholds: () => SealThresholds } | null = null;
  const sealBlockedUntil = new Map<string, number>();
  /** 每个会话连续封批失败的次数（成功即清零）——够数就放弃这一批，见 sealGroup。 */
  const sealFailures = new Map<string, number>();
  let sealBackoffMs = SEAL_BACKOFF_MIN_MS;

  /** 把一条消息并入对应会话的缓冲（webhook 与 accept 共用）。
   *
   *  @param key 会话键（`wx.conv_id`）
   *  @param buffered 已规范化的消息
   *  @param seenAt 到达时刻（闸门基准）
   */
  const appendToBuffer = (key: string, buffered: BufferedEvent, seenAt: string): void => {
    bufferedIds.add(buffered.messageId);
    const existing = buffers.get(key);
    if (existing) {
      existing.events.push(buffered);
      existing.lastAt = buffered.at;
      existing.lastSeenAt = seenAt;
      existing.bytes = (existing.bytes ?? 0) + Buffer.byteLength(buffered.content, "utf8");
      return;
    }
    buffers.set(key, {
      groupId: key,
      events: [buffered],
      lastAt: buffered.at,
      bytes: Buffer.byteLength(buffered.content, "utf8"),
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    });
  };

  /** 缓冲中消息 id 的索引：消息是**一条一 POST**，逐条扫全部缓冲是热路径上的 O(n)。 */
  const bufferedIds = new Set<string>();

  /** 该 message_id 是否已在缓冲或已封批（上游明确要求接收侧去重，docs/14 §6）。 */
  const isDuplicate = (id: string): boolean => recentIds.has(id) || bufferedIds.has(id);

  /** 记一条已封批消息 id（环形裁剪）。 */
  const rememberId = (id: string): void => {
    recentIds.add(id);
    if (recentIds.size > RECENT_ID_LIMIT) {
      const oldest = recentIds.values().next().value;
      if (oldest !== undefined) recentIds.delete(oldest);
    }
  };

  /** 清掉一个会话的缓冲。
   *
   *  @param buf 要清的缓冲
   *  @param record 是否登记去重 id：**空批要登记**（没内容，重推也没意义）；
   *    **放弃不能登记**——否则上游重放积压时全被当重复吞掉，一次瞬时故障就变成永久丢失
   *    （docs/07 §五：「失败时别记去重 id」，重推才有救回的机会）。
   */
  const clearBuffer = (buf: GroupBuffer, record: boolean): void => {
    for (const e of buf.events) {
      if (record) rememberId(e.messageId);
      bufferedIds.delete(e.messageId);
    }
    buffers.delete(buf.groupId);
    sealBlockedUntil.delete(buf.groupId);
    sealFailures.delete(buf.groupId);
  };

  /** 封一个会话：组装批次 → ctx.ingest → 记 id + 清缓冲。
   *  ⚠️ ingest 返回 ok:false 时**不记 id、保留缓冲**——否则该批消息既不落库又被去重登记，
   *  上游重推也被吞（静默丢数据）。保留缓冲让它下轮扫描重试。 */
  const sealGroup = (ctx: SourceContext, buf: GroupBuffer): void => {
    const batch = assembleBatch(buf);
    const kindWord = kindWordOf(buf.events[0]?.raw.message_type ?? "");
    // 上游的会话名：取批内首条（同一会话键内上游名理应一致；改名会出现在后续批次里）
    const conversationName = buf.events[0]?.conversationName ?? null;
    if (!batch.hasContent) {
      // 全空 = 无信息量，留痕后丢弃（留缓冲只会无限重试）
      ctx.log.warn(`${kindWord} ${buf.groupId} 的批次内容为空，丢弃（${buf.events.length} 条）`);
      clearBuffer(buf, true);
      return;
    }
    const result = ctx.ingest({
      content: batch.content,
      source: WX_SOURCE_NAME,
      identity: {
        displayName: displayNameOfGroup(buf),
        // 身份键：会话 id 原样（群 `<数字>@chatroom` / 私聊对方 wxid）——语义诚实
        conversationId: buf.groupId,
        // 上游那边的会话名（群名/昵称）：**参考用**，会随群改名变。
        // displayName 是你填的备注（不变），两者都留着——一个稳定、一个反映上游现状。
        ...(conversationName === null ? {} : { conversationName }),
        ...(batch.sender === undefined ? {} : { sender: batch.sender }), // 多人批次省略——行协议已逐行署名
      },
      eventTime: batch.eventTime,
      raw: batch.raw,
    });
    if (!result.ok) {
      const attempts = (sealFailures.get(buf.groupId) ?? 0) + 1;
      sealFailures.set(buf.groupId, attempts);
      // **放弃闸**：重试到上限还不过，说明这批本身有问题（不是瞬态故障）——
      // 继续留着只会让这个会话再也收不进任何新消息（缓冲区越滚越大、每轮重试同一个错），
      // 所以记一条可见的错、丢掉这批。丢之前已 log.error，用户能从「最近出错」看到。
      if (attempts >= SEAL_MAX_ATTEMPTS) {
        const reason = `连续 ${attempts} 次封批失败，丢弃这批 ${buf.events.length} 条：${result.reason}`;
        ctx.log.error(`${kindWord} ${buf.groupId} ${reason}`);
        // 走「最近出错」通道——否则设置页一直显示绿卡，用户不知道这个会话已经不再进消息
        ctx.reportError(new Error(reason));
        // **不记 id**：这批没落库，得留着让上游重放能救回来
        clearBuffer(buf, false);
        return;
      }
      ctx.log.error(
        `封批失败（${kindWord} ${buf.groupId}，第 ${attempts}/${SEAL_MAX_ATTEMPTS} 次）：${result.reason}` +
          `——退避 ${sealBackoffMs / 1000}s 后重试`,
      );
      sealBlockedUntil.set(buf.groupId, Date.now() + sealBackoffMs);
      sealBackoffMs = Math.min(sealBackoffMs * 2, SEAL_BACKOFF_MAX_MS);
      return;
    }
    sealBlockedUntil.delete(buf.groupId);
    sealFailures.delete(buf.groupId);
    sealBackoffMs = SEAL_BACKOFF_MIN_MS;
    for (const e of buf.events) {
      rememberId(e.messageId);
      bufferedIds.delete(e.messageId);
    }
    buffers.delete(buf.groupId);
  };

  /** 一条原始事件的完整接收流程：形状校验 → 自身 → 白名单 → 去重 → 入缓冲。
   *  webhook 与 `accept` 都走这里——**只有一份实现**，两条入口不会各说各话。
   *
   *  @param raw 未解析的原始载荷
   *  @param receivedAt 到达时刻（闸门基准）
   */
  const acceptRaw = (
    raw: unknown,
    receivedAt: string,
  ):
    | { ok: true }
    | {
        ok: false;
        reason: "事件形状不符" | "自己发的消息" | "重复消息" | "尚未上岗（未调 register）";
      }
    | { ok: false; reason: "不在白名单"; detail: string; message: string } => {
    const parsed = WxEventSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "事件形状不符" };
    const ev = parsed.data;
    // 只有 is_self 能可靠判自身（wxid 带/不带后缀两种写法，docs/14 §4.7）
    if (ev.wx.is_self === true) return { ok: false, reason: "自己发的消息" };

    if (runtime === null) return { ok: false, reason: "尚未上岗（未调 register）" };
    const key = ev.wx.conv_id;
    const whitelist = readWhitelist(runtime.ctx);
    const label = whitelist === null ? undefined : whitelistLabel(whitelist, key);
    if (label === undefined) {
      return {
        ok: false,
        reason: "不在白名单",
        detail: key,
        message:
          `收到${kindWordOf(ev.message_type)} ${key} 的消息，但不在白名单` +
          `（设置 → 信源 → 微信消息 未收录）——已丢弃。` +
          (whitelist === null ? "（当前白名单为空 = 全部都不收）" : ""),
      };
    }
    if (isDuplicate(ev.message_id)) return { ok: false, reason: "重复消息" };

    appendToBuffer(key, toBufferedEvent(ev, label), receivedAt);
    return { ok: true };
  };

  /** 扫描一次：命中任一闸的会话封批（ctx.setInterval 每 SWEEP_INTERVAL_MS 调一次）。 */
  const runSweep = (): void => {
    if (runtime === null || buffers.size === 0) return; // 空转时不读设置（每 5s 一次的免费开销）
    const now = Date.now();
    const due = dueGroups(buffers, now, runtime.thresholds()).filter(
      (b) => (sealBlockedUntil.get(b.groupId) ?? 0) <= now,
    );
    for (const buf of due) sealGroup(runtime.ctx, buf);
  };

  return {
    name: WX_SOURCE_NAME,

    /** 接收一条原始事件（webhook 直接调它；Router 若将来转发也走同一段）。
     *
     *  失败**不抛**，返回原因给调用方——`reason` 是分类（给调用方判断要不要留痕），
     *  `detail` / `message` 只在「不在白名单」时给（webhook 用它做每会话一次的告警）。
     */
    accept({ raw, receivedAt }: { raw: unknown; receivedAt: string }): AcceptResult {
      const result = acceptRaw(raw, receivedAt);
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },

    register(ctx: SourceContext, router: WebhookRegistrar): void {
      /** 读四闸阈值（设置覆盖默认；非法值兜默认、即时生效不重启）。 */
      const thresholds = (): SealThresholds => {
        /** 读一个**非负**数设置（缺省/非法 → 默认值；下限 0 = 允许「每次扫描立即封批」）。
         *  @param key 设置键
         *  @param fallback 默认值
         */
        const num = (key: string, fallback: number): number => {
          const v = ctx.getSetting(key);
          return typeof v === "number" && v >= 0 ? v : fallback;
        };
        return {
          windowMinutes: num("windowMinutes", DEFAULT_WINDOW_MINUTES),
          maxEvents: num("maxEvents", DEFAULT_MAX_EVENTS),
          maxBytes: num("maxBytes", DEFAULT_MAX_BYTES),
          maxAgeMinutes: num("maxAgeMinutes", DEFAULT_MAX_AGE_MINUTES),
        };
      };
      runtime = { ctx, thresholds };

      // 快收：形状校验 → 自身/白名单过滤 → 入缓冲 → 204。
      // ⚠️ 上游按响应码决定重试（docs/14 §3）：2xx 即成功、4xx 视为配错直接落盘。
      // 所以白名单外/重复/自身消息**一律回 204**——那些不是「我们没收下」，而是「收下了但不需要」。
      router.post("/event", async (req, reply) => {
        ctx.markActivity("event");
        const result = acceptRaw(req.body, nowWallClock());
        if (!result.ok && result.reason === "不在白名单") {
          // 白名单外静默丢曾是「配置错了用户无从感知」的黑洞——每会话留痕一次。
          // 原因文案由 accept 给（含会话键），这里只负责「每个会话只刷一次」。
          if (!warnedDropped.has(result.detail)) {
            warnedDropped.add(result.detail);
            if (warnedDropped.size > WARNED_LIMIT) {
              const oldest = warnedDropped.values().next().value;
              if (oldest !== undefined) warnedDropped.delete(oldest);
            }
            ctx.log.warn(result.message);
          }
        }
        // 其余失败（形状不符 / 自身消息 / 重复）都不需要日志：那是正常流量。
        return reply.code(204).send();
      });

      // 去抖扫描：静默满窗的会话封批（定时器经 ctx.setInterval 自动登记进清理表）。
      // ⚠️ 刻意不 unref()——unref 的定时器在事件循环低活跃期会被饿死。
      ctx.setInterval(runSweep, SWEEP_INTERVAL_MS);
    },

    /** 停止：强制封批全部会话，尽力不丢缓冲。SIGINT 归 core。 */
    async stop(): Promise<void> {
      if (runtime === null) return;
      for (const buf of [...buffers.values()]) sealGroup(runtime.ctx, buf);
    },

    /** 声明设置项——会话白名单 + 切段阈值（与 nc 同名同义，前端零改动）。 */
    settings(): SettingField[] {
      return [
        {
          key: "conversations",
          type: "record",
          label: "会话白名单",
          description: "只收这些会话的消息；未配置 = 全都不收（fail-closed）",
          keyPlaceholder: "会话 id（群形如 12345@chatroom，私聊是对方 wxid）",
          valuePlaceholder: "备注名（随便填，显示用）",
        },
        {
          key: "windowMinutes",
          type: "number",
          label: "静默切段（分钟）",
          default: DEFAULT_WINDOW_MINUTES,
          description: "同一会话安静这么久就切段——一段对话的自然停顿",
        },
        {
          key: "maxAgeMinutes",
          type: "number",
          label: "最长跨度（分钟）",
          default: DEFAULT_MAX_AGE_MINUTES,
          description: "一直有人说话时按它强制切段——越小，每批越聚焦（AI 检索与判断都更准）",
        },
      ];
    },

    guide(): string {
      return "把「设置 → 信源 → 微信消息」卡片上的接入地址填进上游看板，点「发送测试」；再在下方白名单填要收的会话 id。";
    },

    /** 告诉 agent0 这批消息是什么场景。 */
    digestHint(): string {
      return [
        "**微信消息**：微信里的群聊与私聊，一批通常是一段对话的合并。",
        "- `displayName` 是你自己给这个会话起的备注（不随上游变）；`conversationName` 是上游那边当前的会话名，" +
          "群改名会跟着变——判断「这是哪个群」认 `displayName`，`conversationName` 只作参考；",
        "- 同一批里发信人可能不止一个——判类时看是谁在说；",
        "- 非文本消息（图片/语音/链接等）上游只给占位文本（如 `[图片]`），看不到内容本身，别猜里面写了什么。",
      ].join("\n");
    },

    activity(): ActivitySignal[] {
      return [
        { key: "event", label: "收到" },
        { key: "ingest", label: "入库" },
      ];
    },
  };
}
