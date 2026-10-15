import type { SettingField, SourceAdapter, SourceContext, SourceRouter } from "../types";
import { wallClockFromUnix } from "../../shared/time";
import {
  assembleBatch,
  dueGroups,
  NcEventSchema,
  type BufferedEvent,
  type GroupBuffer,
  type NcEvent,
  type NcSegment,
} from "./types";

// nc 只读适配器（D-84 §3）：HTTP WebHook 快收 204 → 私有内存缓冲（按会话分组）
// → 去抖封批 → ctx.ingest（与手动源同一条管线）。只读：不发消息、不代操作。
//
// 归属与生命周期：缓冲区是本适配器私有内存态，core 不读写；崩溃丢最近 ≤1 窗口
// （消息仍在 QQ 群里，手动可补）；关闭时 stop() 尽力强制封批（SIGINT 归 core，见 index.ts）。

/** 源的唯一短名：sourceType、信源设置命名空间、from 排障标记共用。 */
const NC_SOURCE_NAME = "nc";
const DEFAULT_WINDOW_MINUTES = 3; // 窗长默认 3 分钟（KV 可调，改即生效不重启）
export const SWEEP_INTERVAL_MS = 5_000; // 扫描间隔：以 5s 一跳实现去抖语义（≥窗口即封批）
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

/** 会话白名单：`Record<键, 备注名>`（备注名供 sourceLabel）；键 = 群号 / 对方 QQ 号，原样取用。
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
  let runtime: { ctx: SourceContext; windowMinutes: () => number } | null = null;

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
   *  组装端已保证载荷恒合法（见 groupNameOf / 组装兜底），ingest 拒收只剩真瞬态故障，重试才成立。 */
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
      sourceType: NC_SOURCE_NAME,
      sourceIdentity: {
        sourceLabel: groupNameOf(buf),
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
      // 落库失败（只剩瞬态故障可能）：留痕但不登记 id、不清缓冲——下轮重试
      ctx.log.error(`封批失败（${kindWord} ${buf.groupId}）：${result.reason}`);
      return;
    }
    for (const e of buf.events) rememberId(e.messageId);
    buffers.delete(buf.groupId);
  };

  /** 扫描一次：静默满窗的组封批（ctx.setInterval 每 SWEEP_INTERVAL_MS 调一次）。 */
  const runSweep = (): void => {
    if (runtime === null) return;
    const due = dueGroups(buffers, Date.now(), runtime.windowMinutes());
    for (const buf of due) sealGroup(runtime.ctx, buf);
  };

  return {
    name: NC_SOURCE_NAME,

    register(ctx: SourceContext, router: SourceRouter): void {
      /** 读窗长（设置覆盖默认；非法值兜默认）。 */
      const windowMinutes = (): number => {
        const v = ctx.getSetting("windowMinutes");
        return typeof v === "number" && v > 0 ? v : DEFAULT_WINDOW_MINUTES;
      };
      runtime = { ctx, windowMinutes };

      // 快收：白名单过滤 → 规范化 → 入缓冲 → 204（nc 规范：无需响应体）
      // 卡片文案：动态段名（实测 nc 上报路径形如 /event），实际可达地址由 core 按账户令牌拼
      router.post("/event", async (req, reply) => {
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

        const buffered: BufferedEvent = {
          messageId: ev.message_id,
          content: textFromSegments(ev.message, ev.raw_message),
          sender: senderName(ev),
          senderId: ev.sender?.user_id ?? ev.user_id ?? "",
          role: ev.sender?.role,
          groupName: label, // 白名单里的备注名（群名 / 私聊对方备注名）——封批直接用作 sourceLabel
          // 机械时刻（去抖/行前缀用）——桥接发 null 时按接收时刻；真伪由 trueTime 区分（01§5.3 禁兜底进 eventTime）
          at: wallClockFromUnix(ev.time ?? Math.floor(Date.now() / 1000)),
          trueTime: typeof ev.time === "number",
          raw: ev,
        };
        const existing = buffers.get(key);
        if (existing) {
          existing.events.push(buffered);
          existing.lastAt = buffered.at;
        } else {
          buffers.set(key, {
            groupId: key, // 会话键（群号 / private:<QQ>）——GroupBuffer 沿用此名
            events: [buffered],
            lastAt: buffered.at,
          });
        }
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

    /** 声明设置项（纯数据，core 落库 __schema__ 供前端渲染）——群/私聊白名单 + 打包窗长。 */
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
          label: "打包窗长（分钟）",
          default: DEFAULT_WINDOW_MINUTES,
          description: "同一会话静默这么久就把这段时间的消息合并成一个批次",
        },
      ];
    },
  };
}

/** 取组内首条事件携带的会话备注名（入缓冲时已定）——保证非空（ingest schema 的 name 非空校验）。 */
function groupNameOf(buf: GroupBuffer): string {
  const name = buf.events[0]?.groupName.trim();
  if (name !== undefined && name !== "") return name;
  return buf.groupId !== "" ? buf.groupId : "未知来源";
}
