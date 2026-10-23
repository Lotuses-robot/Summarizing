import type {
  AcceptResult,
  ActivitySignal,
  SettingField,
  SourceAdapter,
  SourceContext,
} from "../types";
import {
  appendLine,
  DEFAULT_KF_THRESHOLDS,
  dueStreams,
  type KfBuffer,
  type KfThresholds,
} from "./batching";
import { KfMessageSchema, mapMessage } from "./message";

// 企业微信 · 微信客服信源（D-128，D-130 分层后）。
//
// **本文件只做「消化」**：收 Router 转发的原始消息 → 解协议 → 算流键 → 装 identity →
// 缓冲 → 四闸切段 → ingest。验签/解密/拉取/绑定/回执**全部在 Router**（`router/wecom/`）——
// 那里有凭据，而信源层不该有。
//
// 单入口多流的「分流」也在 Router：它按 external_userid 查绑定表定出 uid，再投给该账户的信源。
// 本信源收到的每条消息**已经确定了归属**，它只需要回答一件事：这条属于本账户里的哪条流
// （= `open_kfid + external_userid`，同一段对话）。
//
const WECOM_SOURCE_NAME = "wecom";

/** 封批扫描间隔（只有切段在这一层；拉取在 Router）。 */
const SWEEP_INTERVAL_MS = 5_000;

/** 已封批消息 id 的环形上限（重投幂等）。与 nc 同量级：够覆盖「游标没推进就重启」的那一页。 */
const RECENT_ID_LIMIT = 500;

/** 一条流的键：客服账号 + 外部联系人。两者都缺 = 无法分流，丢弃并留痕。 */
function streamKey(openKfid: string, externalUserId: string): string {
  return `${openKfid}\u0000${externalUserId}`;
}

/** 企业微信信源适配器工厂（每账户一份实例——私有态天然隔离）。 */
export function makeWecomAdapter(): SourceAdapter {
  /** 流缓冲：键 = open_kfid + external_userid（见文件头「单入口多流」）。 */
  const buffers = new Map<string, KfBuffer>();
  /** 已封批的消息 id（Set 保序，超限丢最旧）——重投幂等，见 `isDuplicate`。 */
  const recentIds = new Set<string>();
  /** 封批失败退避（与 nc 同一策略：量闸命中后恒命中，不退避就每轮刷错）。 */
  const blockedUntil = new Map<string, number>();
  let backoffMs = 30_000;
  let runtime: { ctx: SourceContext; thresholds: () => KfThresholds } | null = null;

  /** 这条消息是否已经在缓冲里、或已经封批过（重投幂等）。
   *
   *  为什么必须要：Router 只在**整页派发完之后**才推进游标（一路 `await dispatch`），
   *  而这一页最多 1000 条。绑定表坏（`resolveBinding` 抛）、进程重启、网络抖动都会中断派发
   *  ——下一轮拉取会把同一页原样重投一遍。没有这一层，同一句话会进两遍，agent0 会当成
   *  「客户说了两次」而产出重复的碎片与证据（docs/07 把重投幂等列为每个源必须自己做的项）。
   *
   *  @param id 消息 id（`msgid`）；缺失时无从判重，按「不重复」处理（宁可多收一条也不吞）
   */
  function isDuplicate(id: string | null): boolean {
    if (id === null) return false;
    return (
      recentIds.has(id) ||
      [...buffers.values()].some((b) => b.lines.some((l) => l.messageId === id))
    );
  }

  /** 记一条已封批消息 id（环形裁剪——`Set` 保序，删最旧）。 */
  function rememberId(id: string): void {
    recentIds.add(id);
    if (recentIds.size > RECENT_ID_LIMIT) {
      const oldest = recentIds.values().next().value;
      if (oldest !== undefined) recentIds.delete(oldest);
    }
  }

  /** 流的展示名：外部联系人 id 本身就是一串不透明的 id（没有昵称）。如配置了别名就用别名，
   *  否则显示 id 尾号——**不编造**一个像名字的东西。 */
  function displayNameOf(externalUserId: string): string {
    return `客户 ${externalUserId.slice(-6)}`;
  }

  /** 封一条流：组装批次 → ingest → 成功才清缓冲。失败保留缓冲 + 退避（与 nc 同一策略）。 */
  function sealStream(ctx: SourceContext, buf: KfBuffer): void {
    const lines = buf.lines;
    const first = lines[0];
    if (first === undefined) return;
    const content = lines
      .map((l) => {
        const hm = l.at === null ? "" : `[${l.at.split("T")[1]?.slice(0, 5) ?? ""}] `;
        return `${hm}${l.sender}: ${l.content}`;
      })
      .join("\n");
    // eventTime：批内最早一条**真时刻**；全无则 null（01§5.3 禁接收时间兜底）
    const times = lines.map((l) => l.at).filter((t): t is string => t !== null);
    const eventTime = times.length === 0 ? null : times.reduce((a, b) => (a < b ? a : b));
    // 发信人：只有批内全是客户且同一个人时才署名（与 nc 的 D-91 口径一致）
    const senders = new Set(lines.map((l) => l.senderId));
    const sender = senders.size === 1 ? (first.senderId ?? undefined) : undefined;

    const [openKfid = "", externalUserId = ""] = buf.key.split("\u0000");
    const result = ctx.ingest({
      content,
      source: WECOM_SOURCE_NAME,
      identity: {
        displayName: buf.displayName,
        openKfid,
        externalUserId,
        ...(sender === undefined ? {} : { sender }),
      },
      eventTime,
      raw: lines.map((l) => ({
        messageId: l.messageId,
        mediaId: l.mediaId,
        fromCustomer: l.fromCustomer,
      })),
    });
    if (!result.ok) {
      ctx.log.error(`封批失败（${buf.displayName}）：${result.reason}——退避 ${backoffMs / 1000}s`);
      blockedUntil.set(buf.key, Date.now() + backoffMs);
      backoffMs = Math.min(backoffMs * 2, 10 * 60_000);
      return;
    }
    blockedUntil.delete(buf.key);
    backoffMs = 30_000;
    // 成功才记 id：失败时保留缓冲、**不登记去重**（否则这批既不落库、重投也被吞——静默丢数据）
    for (const l of lines) if (l.messageId !== null) rememberId(l.messageId);
    buffers.delete(buf.key);
    ctx.markActivity("seal");
  }

  /** 扫描一次：先拉各客服账号的新消息，再把命中四闸的流封批。
   *  阈值从设置读（与 nc 同语义：改即生效不重启）——两个时间阀用户可调，两个量阀保底。 */
  function runSweep(ctx: SourceContext, thresholds: KfThresholds): void {
    const now = Date.now();
    const due = dueStreams(buffers, now, thresholds).filter(
      (b) => (blockedUntil.get(b.key) ?? 0) <= now,
    );
    for (const buf of due) sealStream(ctx, buf);
  }

  return {
    name: WECOM_SOURCE_NAME,

    /** 接收一条原始客服消息（D-130）。由 Router 转发（它已查明归属），
     *  本方法自己解协议、算流键、装 identity、进缓冲。
     *
     *  入参 `raw` = 原始 sync_msg 消息对象；`receivedAt` = 到达时刻（Router 记，闸门基准）。
     */
    accept({ raw, receivedAt }: { raw: unknown; receivedAt: string }): AcceptResult {
      const parsed = KfMessageSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, reason: "消息形状不符（sync_msg 字段缺失）" };
      const line = mapMessage(parsed.data);
      if (line === null) return { ok: false, reason: "无可提取内容（事件/未知类型/空正文）" };
      const msg = parsed.data;
      const kfid = msg.open_kfid ?? "";
      const ext = msg.external_userid ?? "";
      if (kfid === "" || ext === "") return { ok: false, reason: "缺 open_kfid / external_userid" };
      if (isDuplicate(line.messageId)) return { ok: false, reason: "重复消息（已在缓冲或已封批）" };
      appendLine(buffers, streamKey(kfid, ext), displayNameOf(ext), line, receivedAt);
      return { ok: true };
    },

    register(ctx: SourceContext): void {
      /** 读切段阈值（设置覆盖默认；非法值兜默认、即时生效不重启）。
       *  @param key 设置键
       *  @param fallback 默认值
       */
      const num = (key: string, fallback: number): number => {
        const v = ctx.getSetting(key);
        return typeof v === "number" && v >= 0 ? v : fallback;
      };
      /** 当前生效的四闸阈值。 */
      const thresholds = (): KfThresholds => ({
        windowMinutes: num("windowMinutes", DEFAULT_KF_THRESHOLDS.windowMinutes),
        maxAgeMinutes: num("maxAgeMinutes", DEFAULT_KF_THRESHOLDS.maxAgeMinutes),
        // 量阀不暴露给用户（保底用）——它们的值改代码常量，不读设置
        maxEvents: DEFAULT_KF_THRESHOLDS.maxEvents,
        maxBytes: DEFAULT_KF_THRESHOLDS.maxBytes,
      });
      runtime = { ctx, thresholds };
      // 只跑封批扫描：拉取、回执、验签解密全在 Router（它持有凭据）
      ctx.setInterval(() => {
        const current = runtime;
        if (current === null) return;
        runSweep(current.ctx, current.thresholds());
      }, SWEEP_INTERVAL_MS);
    },

    async stop(): Promise<void> {
      const current = runtime;
      if (current === null) return;
      for (const buf of [...buffers.values()]) sealStream(current.ctx, buf);
    },

    settings(): SettingField[] {
      return [
        {
          key: "windowMinutes",
          type: "number",
          label: "静默切段（分钟）",
          default: DEFAULT_KF_THRESHOLDS.windowMinutes,
          description: "同一客户安静这么久就切段——一段对话的自然停顿",
        },
        {
          key: "maxAgeMinutes",
          type: "number",
          label: "最长跨度（分钟）",
          default: DEFAULT_KF_THRESHOLDS.maxAgeMinutes,
          description: "一直有新消息时按它强制切段——越小，每批越聚焦",
        },
      ];
    },

    guide(): string {
      // 接入地址不在这一页（属 Router，D-130 FR-025）——运维用 `router:list` 查；
      // 这里只说自己这一页要配什么，不指向一个界面上并不存在的「上面的接入地址」。
      return "企业微信管理后台 →「微信客服」→「API 接收消息」→ 接收消息服务器配置：URL 填运维给的 /relay/wecom/callback，Token / EncodingAESKey 与运维配置的一致；消息加密方式选「安全模式」。";
    },

    activity(): ActivitySignal[] {
      // 只声明本层真会打的两个键：`seal` 是 WECOM 自己的口径，`ingest` 是保留键
      // （core 落库成功时自动打点）。回调/拉取发生在 Router，信源看不见，不在本卡展示。
      return [
        { key: "seal", label: "封批" },
        { key: "ingest", label: "入库" },
      ];
    },
  };
}
