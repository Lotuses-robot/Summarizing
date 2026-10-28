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
  NcEventSchema,
  type BufferedEvent,
  type GroupBuffer,
  type NcEvent,
  type NcSegment,
  type SealThresholds,
} from "./types";

// nc 只读适配器（D-84 §3）：HTTP WebHook 快收 204 → 私有内存缓冲（按会话分组）
// → 去抖封批 → ctx.ingest（与手动源同一条管线）。只读：不发消息、不代操作。
//
// 归属与生命周期：缓冲区是本适配器私有内存态，core 不读写；崩溃丢最近 ≤1 窗口
// （消息仍在 QQ 群里，手动可补）；关闭时 stop() 尽力强制封批（SIGINT 归 core，见 index.ts）。

/** 源的唯一短名：source、信源设置命名空间、from 排障标记共用。 */
const NC_SOURCE_NAME = "nc";
const DEFAULT_WINDOW_MINUTES = 3; // 静默窗默认 3 分钟（KV 可调，改即生效不重启）
/** 四闸默认值（D-127 / D-129）——批大小有上界，「崩溃丢多少」才有上界。
 *
 *  **两个时间阀是用户可调的（见 settings），两个量阀是保底**：
 *  量阀不暴露给用户，是因为「什么时候该切段」本质是时间概念（用户说得清「安静 3 分钟就算一段」，
 *  说不清「多少条算一段」）；而量阀必须存在——它们防的是 OOM 与单批失控，不是日常切段手段。
 *
 *  静默 3 分钟：一段对话的自然停顿。
 *  龄期 10 分钟：忙群一直有人说话时按它切——**这是「切小」的主要手段**（D-129）：
 *    一批 ≈ 一段连贯对话时，search 的每条命中才 ≈ 一件事，检索粒度才对得上。
 *  条数 50 / 字节 20KB：保底。忙群 10 分钟内到不了 50 条；长文群由字节阀兜。 */
const DEFAULT_MAX_EVENTS = 50;
const DEFAULT_MAX_BYTES = 20 * 1024;
const DEFAULT_MAX_AGE_MINUTES = 10;
export const SWEEP_INTERVAL_MS = 5_000; // 扫描间隔：以 5s 一跳实现去抖语义（≥窗口即封批）
/** 封批失败后的退避（指数，组间独立时刻、全局共享当前档位）——防止量闸恒命中导致每 5s 刷错。 */
const SEAL_BACKOFF_MIN_MS = 30_000;
const SEAL_BACKOFF_MAX_MS = 10 * 60_000;
const RECENT_ID_LIMIT = 500; // 已封批消息 id 环形集合上限（重推幂等；跨批去重）

/** 一组消息段 → 显示文本：图片段转 `[图片](url)` 占位（D-84：信息不丢、体积可控）。
 *  segments 已由 NcEventSchema 解析成 NcSegment[]（缺席 = undefined）。 */
function textFromSegments(segments: NcSegment[] | undefined, rawMessage: string): string {
  if (segments === undefined) return rawMessage; // 无段结构（纯文本事件）→ 用 raw_message
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.type === "image") {
      const url = seg.data?.["url"];
      parts.push(typeof url === "string" ? `[图片](${url})` : "[图片]");
    } else if (seg.type === "text") {
      const t = seg.data?.["text"];
      if (typeof t === "string") parts.push(t);
    } else if (seg.type === "at") {
      const qq = seg.data?.["qq"];
      parts.push(typeof qq === "string" ? `@${qq}` : "@某人");
    }
    // 其余段型（face/reply/…）不展开——raw 里有原样留底
  }
  return parts.length > 0 ? parts.join("") : rawMessage;
}

/** 私聊会话键前缀：区分 NapCat 推回来的群/私聊消息（群 = 群号、私聊 = `private:<对方QQ>`）。 */
const PRIVATE_KEY_PREFIX = "private:";

/** 会话类型原文 → 中文措辞（日志多处共用；兜底取中性「会话」——防同型消息在两处日志里说成不同话）。 */
function kindWordOf(messageType: string): string {
  if (messageType === "group") return "群";
  if (messageType === "private") return "私聊";
  return "会话";
}

/** 会话白名单：`Record<键, 备注名>`（备注名供 displayName）；键 = 群号 / 对方 QQ 号，原样取用。
 *  缺省/空对象/非对象 → null（= 未配置 = 全丢，fail-closed，D-84 Q-F）。 */
function readWhitelist(ctx: SourceContext): Record<string, string> | null {
  const out: Record<string, string> = {};
  /** 收一个 KV 到 out（坏形状忽略；空串键/空串备注名不收）。 */
  const collect = (key: string): void => {
    const v = ctx.getSetting(key);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return;
    for (const [k, val] of Object.entries(v)) {
      if (k !== "" && typeof val === "string" && val.trim() !== "") out[k] = val;
    }
  };
  collect("groups");
  collect("privates");
  return Object.keys(out).length > 0 ? out : null;
}

/** 一条 nc 事件 → 缓冲条目（两条入口共用：webhook 与 `accept` 的规范化必须一致）。
 *
 *  @param ev 已过 schema 的事件
 *  @param label 白名单里的备注名（封批时用作 displayName）
 */
function toBufferedEvent(ev: NcEvent, label: string): BufferedEvent {
  return {
    messageId: ev.message_id,
    content: textFromSegments(ev.message, ev.raw_message),
    sender: senderName(ev),
    senderId: ev.sender?.user_id ?? ev.user_id ?? "",
    role: ev.sender?.role,
    displayName: label, // 白名单里的备注名（群名 / 私聊对方备注名）——封批直接用作 displayName
    // 机械时刻（去抖/行前缀用）——桥接发 null 时按接收时刻；真伪由 trueTime 区分（01§5.3 禁兜底进 eventTime）
    at: wallClockFromUnix(ev.time ?? Math.floor(Date.now() / 1000)),
    trueTime: typeof ev.time === "number",
    raw: ev,
  };
}

/** 事件 → 会话键：群 = group_id；私聊 = `private:<对方 user_id>`（自己发的不回推，见 NapCat 行为）。
 *  取不到键（群号空串、私聊无发信人 id）→ null（无法定位会话，丢弃）。 */
function conversationKey(ev: NcEvent): string | null {
  if (ev.message_type === "group") {
    return ev.group_id !== undefined && ev.group_id !== "" ? ev.group_id : null;
  }
  const peer = ev.sender?.user_id ?? ev.user_id;
  return peer !== undefined && peer !== "" ? `${PRIVATE_KEY_PREFIX}${peer}` : null;
}

/** 拿事件去白名单查备注名：群按群号比、私聊按裸 QQ 号比。 */
function whitelistLabel(
  ev: NcEvent,
  key: string,
  whitelist: Record<string, string>,
): string | undefined {
  const userKey = ev.message_type === "group" ? key : key.slice(PRIVATE_KEY_PREFIX.length);
  return whitelist[userKey];
}

/** 从事件取发信人显示名（群名片 > 昵称 > user_id）。 */
function senderName(ev: NcEvent): string {
  /** 取第一个非空串（null/空串都跳过——nc 变体会给可选字段发 null，三轮评审）。 */
  const first = (v: string | null | undefined): string | null =>
    typeof v === "string" && v.trim() !== "" ? v : null;
  return (
    first(ev.sender?.card) ??
    first(ev.sender?.nickname) ??
    first(ev.sender?.user_id) ??
    first(ev.user_id) ??
    "未知"
  );
}

/** nc 只读适配器：register 里登记 webhook（`/event` → 可达 `/hook/<令牌>/nc/event`）+ 起封批扫描
 *  定时器（经 ctx.setInterval 自动登记）。停止时（空间关停）`stop()` 强制封批全部组；
 *  SIGINT 归 core，信源不自己监听信号。 */
export function makeNcAdapter(): SourceAdapter {
  // 缓冲与去重集合是适配器实例级私有态（跨 register 调用保留；测试用工厂隔离）
  const buffers = new Map<string, GroupBuffer>();
  const recentIds = new Set<string>(); // 已封批消息 id（Set 保序，超限丢最旧）
  const warnedDroppedGroups = new Set<string>(); // 已留痕过"白名单外丢弃"的会话键（每个只报一次，防刷屏——A14 2026-10-13）
  // register 时注入的运行时依赖（stop 在 register 之外被调，故存引用）
  let runtime: { ctx: SourceContext; thresholds: () => SealThresholds } | null = null;
  // 封批失败退避（见 sealGroup）：组 → 可重试的最早时刻；sealBackoffMs 是当前档位（成功即复位）
  const sealBlockedUntil = new Map<string, number>();
  let sealBackoffMs = SEAL_BACKOFF_MIN_MS;

  /** 把一条消息并入对应会话的缓冲（D-130：从 register 的 handler 里抽出来，
   *  webhook 与 `accept` 共用同一段——两条入口行为必须一致）。
   *
   *  @param key 会话键（群号 / private:<QQ>）
   *  @param buffered 已规范化的消息
   *  @param seenAt 到达时刻（闸门基准）
   */
  const appendToBuffer = (key: string, buffered: BufferedEvent, seenAt: string): void => {
    const existing = buffers.get(key);
    if (existing) {
      existing.events.push(buffered);
      existing.lastAt = buffered.at;
      existing.lastSeenAt = seenAt;
      existing.bytes = (existing.bytes ?? 0) + Buffer.byteLength(buffered.content, "utf8");
      return;
    }
    buffers.set(key, {
      groupId: key, // 会话键（群号 / private:<QQ>）——GroupBuffer 沿用此名
      events: [buffered],
      lastAt: buffered.at,
      bytes: Buffer.byteLength(buffered.content, "utf8"),
      // 闸门起算点 = **进入缓冲**的时刻（不是消息自带时刻——桥接补推积压时会误触发）
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    });
  };

  /** 该 message_id 是否已在缓冲或已封批（重推幂等）。 */
  const isDuplicate = (id: string): boolean =>
    recentIds.has(id) ||
    [...buffers.values()].some((b) => b.events.some((e) => e.messageId === id));

  /** 记一条已封批消息 id（环形裁剪）。 */
  const rememberId = (id: string): void => {
    recentIds.add(id);
    if (recentIds.size > RECENT_ID_LIMIT) {
      const oldest = recentIds.values().next().value;
      if (oldest !== undefined) recentIds.delete(oldest);
    }
  };

  /** 封一个组：组装批次 → ctx.ingest → 记 id + 清缓冲。
   *  ⚠️ ingest 返回 ok:false 或抛错时**不记 id、保留缓冲**——否则该批消息既不落库又被去重登记，
   *  nc 重推也被吞（静默丢数据）。保留缓冲让它下轮扫描重试；
   *  组装端已保证载荷恒合法（见 displayNameOfGroup / 组装兜底），ingest 拒收只剩真瞬态故障，重试才成立。 */
  const sealGroup = (ctx: SourceContext, buf: GroupBuffer): void => {
    const batch = assembleBatch(buf);
    const kind = buf.events[0]?.raw.message_type; // 会话类型取批内首条（同会话键内必一致）
    const kindWord = kindWordOf(kind ?? ""); // 日志措辞按会话类型（私聊缓冲也走此处）
    // 全空消息（raw_message 为空且无可展开段）= 无信息量，留痕后丢弃（留缓冲只会无限重试）。
    // hasContent 由协议层给出——行前缀会让 content 恒非空，「有没有信息量」只有它知道（specs/003 评审）。
    if (!batch.hasContent) {
      ctx.log.warn(`${kindWord} ${buf.groupId} 的批次内容为空，丢弃（${buf.events.length} 条）`);
      for (const e of buf.events) rememberId(e.messageId);
      buffers.delete(buf.groupId);
      return;
    }
    const result = ctx.ingest({
      content: batch.content,
      source: NC_SOURCE_NAME,
      identity: {
        displayName: displayNameOfGroup(buf),
        // 身份键：群 → groupId；私聊 → peer（对方 QQ，取会话键剥掉前缀后的裸号）——语义诚实（弹性字典自由键，D-84）
        ...(kind === "private"
          ? { peer: buf.groupId.slice(PRIVATE_KEY_PREFIX.length) }
          : { groupId: buf.groupId }),
        ...(batch.sender === undefined ? {} : { sender: batch.sender }), // 多人批次省略——行协议已逐行署名（specs/003 FR-004）
      },
      eventTime: batch.eventTime,
      raw: batch.raw,
    });
    if (!result.ok) {
      // 落库失败（只剩瞬态故障可能）：留痕但不登记 id、不清缓冲——下轮重试。
      // ⚠️ 必须退避：条数/字节/龄期这三闸一旦命中就**恒命中**（与旧的静默闸不同，消息停下它就
      // 自然不再触发），不压住的话每 5 秒重试一次、每分钟刷 12 行同样的错，且永久循环。
      ctx.log.error(
        `封批失败（${kindWord} ${buf.groupId}）：${result.reason}——退避 ${sealBackoffMs / 1000}s 后重试`,
      );
      sealBlockedUntil.set(buf.groupId, Date.now() + sealBackoffMs);
      sealBackoffMs = Math.min(sealBackoffMs * 2, SEAL_BACKOFF_MAX_MS);
      return;
    }
    sealBlockedUntil.delete(buf.groupId);
    sealBackoffMs = SEAL_BACKOFF_MIN_MS; // 成功即复位（一次故障不该长期抬高重试间隔）
    for (const e of buf.events) rememberId(e.messageId);
    buffers.delete(buf.groupId);
  };

  /** 扫描一次：命中任一闸的组封批（ctx.setInterval 每 SWEEP_INTERVAL_MS 调一次）。 */
  const runSweep = (): void => {
    if (runtime === null) return;
    const now = Date.now();
    // 退避中的组本轮跳过（见 sealGroup 失败分支）；退避到期后自动重新参与
    const due = dueGroups(buffers, now, runtime.thresholds()).filter(
      (b) => (sealBlockedUntil.get(b.groupId) ?? 0) <= now,
    );
    for (const buf of due) sealGroup(runtime.ctx, buf);
  };

  return {
    name: NC_SOURCE_NAME,

    /** 接收一条原始 nc 事件（D-130）。与 webhook 走同一段规范化 + 缓冲逻辑。
     *
     *  nc 现在的调用方是自己的 webhook（地址带账户令牌，进来就知道归属），
     *  将来若有「一个入口服务多账户」的 nc 部署，也能由 Router 转发到同一个方法。
     *
     *  入参 `raw` = 原始 nc 事件；`receivedAt` = 到达时刻（闸门基准）。
     */
    accept({ raw, receivedAt }: { raw: unknown; receivedAt: string }): AcceptResult {
      if (runtime === null) return { ok: false, reason: "尚未上岗（未调 register）" };
      const parsed = NcEventSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, reason: "事件形状不符" };
      const ev = parsed.data;

      const key = conversationKey(ev);
      if (key === null) return { ok: false, reason: "定位不了会话（缺群号/发信人 id）" };
      const whitelist = readWhitelist(runtime.ctx);
      const label = whitelist === null ? undefined : whitelistLabel(ev, key, whitelist);
      if (whitelist === null || label === undefined) {
        return { ok: false, reason: "不在白名单" };
      }
      if (isDuplicate(ev.message_id)) return { ok: false, reason: "重复消息（已在缓冲或已封批）" };

      appendToBuffer(key, toBufferedEvent(ev, label), receivedAt);
      return { ok: true };
    },

    register(ctx: SourceContext, router: WebhookRegistrar): void {
      /** 读三闸阈值（设置覆盖默认；非法值兜默认、即时生效不重启——与 windowMinutes 同一语义）。 */
      const thresholds = (): SealThresholds => {
        /** 读一个**非负**数设置（缺省/非法 → 默认值）。
         *  ⚠️ 下限是 0 而不是 1：静默窗允许设成 0（=每次扫描立即封批），测试与「不想攒批」的用法都要它。
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

      // 快收：白名单过滤 → 规范化 → 入缓冲 → 204（nc 规范：无需响应体）
      // 卡片文案：动态段名（实测 nc 上报路径形如 /event），实际可达地址由 core 按账户令牌拼
      router.post("/event", async (req, reply) => {
        // 推到门口就算「源还活着」——哪怕随后被白名单丢弃 / 形状不符（这是本源的观测口径，
        // core 不认识；声明见下方 activity()）
        ctx.markActivity("event");
        const parsed = NcEventSchema.safeParse(req.body);
        if (!parsed.success) return reply.code(204).send(); // 非消息/形状不符 → 静默丢
        const ev = parsed.data;

        const key = conversationKey(ev);
        if (key === null) return reply.code(204).send(); // 定位不了会话（私聊无发信人 id 等）→ 丢
        const whitelist = readWhitelist(ctx);
        const label = whitelist === null ? undefined : whitelistLabel(ev, key, whitelist);
        if (whitelist === null || label === undefined) {
          // A14（2026-10-13）：白名单外静默丢曾是"配置错了（如群号填反）用户无从感知"的黑洞。
          // 每会话留痕一次（warn → [source:nc] 前缀进 stderr/日志）——用户可据此对照修正白名单。
          // 只去重不置 state=error：转发多会话、白名单只收一部分是正常用法，置 error 会误报。
          if (!warnedDroppedGroups.has(key)) {
            warnedDroppedGroups.add(key);
            ctx.log.warn(
              `收到${kindWordOf(ev.message_type)} ${key} 的消息，但不在白名单（设置 → 信源 → nc 白名单未收录）——已丢弃。` +
                (whitelist === null ? "（当前白名单为空 = 全部都不收）" : ""),
            );
          }
          return reply.code(204).send(); // 白名单外丢
        }
        if (isDuplicate(ev.message_id)) return reply.code(204).send(); // 重推幂等

        const seenAt = nowWallClock(); // 到达时刻（闸门用；与消息自带时刻是两回事）
        appendToBuffer(key, toBufferedEvent(ev, label), seenAt);
        return reply.code(204).send();
      });

      // 去抖扫描：静默满窗的组封批。定时器经 ctx.setInterval 自动登记进清理表（core 关闭时撤销）。
      // ⚠️ 刻意不 unref()——unref 的定时器在事件循环低活跃期会被饿死（实测：缓冲有消息但永不封批）。
      ctx.setInterval(runSweep, SWEEP_INTERVAL_MS);
    },

    /** 停止（core 在 app.close 时调）：强制封批全部组，尽力不丢缓冲。
     *  SIGINT 归 core（index.ts 统一 process.on → app.close → exit），信源不再自己监听信号。 */
    async stop(): Promise<void> {
      if (runtime === null) return; // 未经 register（未上岗）就停——无事可做
      for (const buf of [...buffers.values()]) sealGroup(runtime.ctx, buf);
    },

    /** 声明设置项（纯数据，core 记入在岗清单供前端渲染）——群/私聊白名单 + 打包窗长。 */
    settings(): SettingField[] {
      return [
        {
          key: "groups",
          type: "record",
          label: "群白名单",
          description: "只收这些群的消息；未配置 = 群消息全不收（fail-closed）",
          keyPlaceholder: "群号（如 940641749）",
          valuePlaceholder: "备注名（随便填，显示用）",
        },
        {
          key: "privates",
          type: "record",
          label: "私聊白名单",
          description: "只收这些人的私聊消息；未配置 = 私聊全不收",
          keyPlaceholder: "对方 QQ 号",
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
      return "填进 nc 的「网络配置 → HTTP 服务器 → 反向 WebSocket / HTTP 上报」，勾选「群消息」；再在下方白名单填群号。";
    },

    /** 告诉 agent0 这批消息是什么场景（L27：此前硬编码在 prompt.ts 里）。 */
    digestHint(): string {
      return [
        "**QQ 群消息**：多人对话，一批通常是一段群聊的合并。",
        "- 身份里有群号/群名/发信人；同一批里发信人可能不止一个——判类时看是谁在说；",
        "- 群里的通知、转述、闲聊混在一起是常态：拿不准是否与用户本人有关时，按「条件受众」规则处理。",
      ].join("\n");
    },

    activity(): ActivitySignal[] {
      // 「收到」= 命中上报路径（本源的观测口径，见 register 里的 markActivity）；
      // 「入库」= 保留键，由 core 在成功落库时打点、重启后从库恢复。
      return [
        { key: "event", label: "收到" },
        { key: "ingest", label: "入库" },
      ];
    },
  };
}

/** 取组内首条事件携带的会话备注名（入缓冲时已定）——保证非空（ingest schema 的 displayName 非空校验）。 */
function displayNameOfGroup(buf: GroupBuffer): string {
  const name = buf.events[0]?.displayName.trim();
  if (name !== undefined && name !== "") return name;
  return buf.groupId !== "" ? buf.groupId : "未知来源";
}
