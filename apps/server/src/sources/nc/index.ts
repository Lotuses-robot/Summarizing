import type { FastifyInstance } from "fastify";
import type { SettingField, SourceAdapter, SourceContext } from "../types";
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

// nc 只读适配器（D-84 §3）：HTTP WebHook 快收 204 → 私有内存缓冲（按群分组）
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

/** 群白名单：`Record<群号, 群备注名>`（备注名供 sourceIdentity.name）。
 *  缺省/空对象/非对象 → null（= 未配置 = 全丢，fail-closed，D-84 Q-F）。 */
function readWhitelist(ctx: SourceContext): Record<string, string> | null {
  const v = ctx.getSetting("groups");
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    // 空串备注名不收（会产出 name="" 的身份 → ingest schema 必拒 → 该组永远封不出去）
    if (typeof val === "string" && val.trim() !== "") out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 从事件取发信人显示名（群名片 > 昵称 > user_id）。 */
function senderName(ev: NcEvent): string {
  /** 取第一个非空串（空串也跳过——?? 只挡 null/undefined）。 */
  const first = (v: string | undefined): string | null =>
    v !== undefined && v.trim() !== "" ? v : null;
  return (
    first(ev.sender?.card) ??
    first(ev.sender?.nickname) ??
    first(ev.sender?.user_id) ??
    first(ev.user_id) ??
    "未知"
  );
}

/** nc 只读适配器：register 里挂 webhook 路由 + 起封批扫描定时器（经 ctx.setInterval 自动登记）。
 *  停止时（core 关闭）`stop()` 强制封批全部组；SIGINT 归 core，信源不自己监听信号。 */
export function makeNcAdapter(): SourceAdapter {
  // 缓冲与去重集合是适配器实例级私有态（跨 register 调用保留；测试用工厂隔离）
  const buffers = new Map<string, GroupBuffer>();
  const recentIds = new Set<string>(); // 已封批消息 id（Set 保序，超限丢最旧）
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
    // 全空消息（raw_message 为空且无可展开段）= 无信息量，留痕后丢弃（留缓冲只会无限重试）。
    // hasContent 由协议层给出——行前缀会让 content 恒非空，「有没有信息量」只有它知道（specs/003 评审）。
    if (!batch.hasContent) {
      ctx.log.warn(`群 ${buf.groupId} 的批次内容为空，丢弃（${buf.events.length} 条）`);
      for (const e of buf.events) rememberId(e.messageId);
      buffers.delete(buf.groupId);
      return;
    }
    const result = ctx.ingest({
      content: batch.content,
      sourceType: NC_SOURCE_NAME,
      sourceIdentity: {
        sourceLabel: groupNameOf(buf),
        groupId: buf.groupId,
        ...(batch.sender === undefined ? {} : { sender: batch.sender }), // 多人批次省略——行协议已逐行署名（specs/003 FR-004）
      },
      eventTime: batch.eventTime,
      raw: batch.raw,
    });
    if (!result.ok) {
      // 落库失败（只剩瞬态故障可能）：留痕但不登记 id、不清缓冲——下轮重试
      ctx.log.error(`封批失败（群 ${buf.groupId}）：${result.reason}`);
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

    register(ctx: SourceContext, app: FastifyInstance): void {
      /** 读窗长（设置覆盖默认；非法值兜默认）。 */
      const windowMinutes = (): number => {
        const v = ctx.getSetting("windowMinutes");
        return typeof v === "number" && v > 0 ? v : DEFAULT_WINDOW_MINUTES;
      };
      runtime = { ctx, windowMinutes };

      // 快收：白名单过滤 → 规范化 → 入缓冲 → 204（nc 规范：无需响应体）
      app.post("/api/sources/nc/event", async (req, reply) => {
        const parsed = NcEventSchema.safeParse(req.body);
        if (!parsed.success) return reply.code(204).send(); // 非群消息/形状不符 → 静默丢
        const ev = parsed.data;

        const whitelist = readWhitelist(ctx);
        const groupName = whitelist?.[ev.group_id];
        if (whitelist === null || groupName === undefined) {
          return reply.code(204).send(); // 白名单外丢
        }
        if (isDuplicate(ev.message_id)) return reply.code(204).send(); // 重推幂等

        const buffered: BufferedEvent = {
          messageId: ev.message_id,
          content: textFromSegments(ev.message, ev.raw_message),
          sender: senderName(ev),
          senderId: ev.sender?.user_id ?? ev.user_id ?? "",
          role: ev.sender?.role,
          groupName,
          at: wallClockFromUnix(ev.time),
          raw: ev,
        };
        const existing = buffers.get(ev.group_id);
        if (existing) {
          existing.events.push(buffered);
          existing.lastAt = buffered.at;
        } else {
          buffers.set(ev.group_id, {
            groupId: ev.group_id,
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

    /** 声明设置项（纯数据，core 落库 __schema__ 供前端渲染）——白名单 + 打包窗长。 */
    settings(): SettingField[] {
      return [
        {
          key: "groups",
          type: "record",
          label: "群白名单",
          description: "只收这些群的消息，格式「群号: 备注名」；未配置 = 全不收（fail-closed）",
        },
        {
          key: "windowMinutes",
          type: "number",
          label: "打包窗长（分钟）",
          default: DEFAULT_WINDOW_MINUTES,
          description: "群内静默这么久就把这段时间的消息合并成一个批次",
        },
      ];
    },
  };
}

/** 取组内首条事件携带的群备注名（入缓冲时已定）——保证非空（ingest schema 的 name 非空校验）。 */
function groupNameOf(buf: GroupBuffer): string {
  const name = buf.events[0]?.groupName.trim();
  if (name !== undefined && name !== "") return name;
  return buf.groupId !== "" ? buf.groupId : "未知群";
}
