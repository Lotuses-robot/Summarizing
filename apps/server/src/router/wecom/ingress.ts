import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errText } from "@summarizing/shared";
import { nowWallClock } from "../../shared/time";
import { getRelaySetting, setRelaySetting } from "../../storage/relay-kv";
import type { RegistryDb } from "../../storage/registry";
import type { SpaceHub } from "../../spaces";
import type { RelayIngress, RouterLog } from "..";
import { deliver } from "../deliver";
import { makeIngressStores } from "..";
import { callbackSignature, decryptCallback, signatureMatches, xmlField } from "./crypto";
import {
  getAccessToken,
  getCallbackIps,
  outboundFailure,
  downloadKfMedia,
  sendKfText,
  syncKfMessages,
  wecomError,
  wecomOk,
} from "./api";
import { IpAllowList } from "./ipAllowList";

// 微信客服接入（D-130）：Router 里**只服务微信**的那一半。
//
// 这个文件是 Router 的一个接入实现（目录约定，不是新类型）——将来加爬虫就是隔壁加个目录。
// 它与协议无关的部分（绑定表、投递、凭据存取）在 `../` 下，这里只管微信协议本身：
// 验签、解密、拉取、游标、回执、媒体。
//
// ⚠️ 它**不解析消息的业务语义**——`raw` 原样交给信源的 `accept`。
// 唯一读字段的地方是 `external_userid`（查绑定必需）与 `origin`（判是否要给回执）。

/** 微信客服的源名（与信源层 `sources/wecom` 的 name 一致——Router 按它投递）。 */
const SOURCE_NAME = "wecom";

/** 从原始 URL 里取查询参数——**按 RFC 3986 解码，不把 `+` 当空格**。
 *
 *  为什么不能直接用 `req.query`：Fastify 默认按表单规则（`application/x-www-form-urlencoded`）
 *  解析查询串，会把 `+` 解成空格。企业微信的 `echostr` 是 **base64**（`+` 必然出现），
 *  且它按原样拼在 URL 上——被解成空格后算出来的签名对不上，URL 验证永远 401（实测）。
 *  官方「接收消息服务器配置 → 验证 URL 有效性」对此有明确要求：接收方须做 URL 解码。
 *
 *  `decodeURIComponent` 对裸 `+` 与 `%2B` 都得到 `+`（只有表单解码会把裸 `+` 变成空格）。
 *
 *  @param rawUrl 原始请求行里的 URL（含查询串）
 *  @returns 参数表；百分号编码坏掉的参数**跳过**（宁可后续报「参数不完整」，也不吞一个半截值）
 */
function parseQueryRfc3986(rawUrl: string): Record<string, string> {
  const start = rawUrl.indexOf("?");
  if (start === -1) return {};
  const out: Record<string, string> = {};
  for (const pair of rawUrl.slice(start + 1).split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
    try {
      out[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    } catch {
      // 坏编码：跳过
    }
  }
  return out;
}

/** Router 需要从一条消息里读到的**全部**字段：定位归属（external_userid）、
 *  定位客服账号（open_kfid）、判要不要回执（origin）。**其余一概不解释**——那是信源的事
 *  （D-130）。用最小 schema 而不是消息全形状，是为了让「Router 不认识协议」成为编译期事实：
 *  想多读一个字段，就得在这里显式加一行。 */
const RoutingFieldsSchema = z.object({
  open_kfid: z.string().optional(),
  external_userid: z.string().optional(),
  origin: z.number().optional(),
});

/** 扫描间隔：回调可能丢（重启期间的、网络抖动的），靠轮询兜底。 */
const POLL_INTERVAL_MS = 30_000;

/** 单次拉取最多追几页（防一次回调堆积过多把事件循环占住；剩下的下一轮继续）。 */
const MAX_PAGES_PER_SYNC = 5;

/** 回执文案。说「已收到」而不是「已处理」——消息此时刚落地、还没消化，
 *  说「已处理」是假声称（01§4.7「不静默、不谎报」）。 */
const REPLY_TEXT = "信息已收到";

/** 未绑定时的回执：把 external_userid 原样告诉客户，他复制给账户主人即可。
 *
 *  为什么只说「绑定码」不提「设置页」：客户不一定是 summarizing 的用户
 *  （他可能只是发消息给客服号的人），说内部界面名字对他没意义。 */
const UNBOUND_REPLY = (code: string): string =>
  `信息已收到。你的绑定码是：${code}（请把它填进 Summarizing 的设置 → 路由）`;

/** 账户停用 / 未启用时的回执。 */
const UNAVAILABLE_REPLY = "信息已收到，但接收方暂不可用，请稍后再试或联系管理员。";

/** 回调带的拉取令牌有效期：官方说 10 分钟，这里留 30 秒余量（宁可早点回落到不带令牌）。 */
const PULL_TOKEN_TTL_MS = 10 * 60_000 - 30_000;

/** 关停时等在途拉取的上限：超过就不再等（卡死的网络不该拖住 Ctrl-C）。 */
const STOP_WAIT_MS = 5_000;

/** 回调 IP 段的刷新间隔。
 *
 *  官方文档（`getcallbackip`）：「IP 段有变更可能，变更时新旧会同时保留一段时间，
 *  **建议企业每天定时拉取**」。这里取 6 小时——比官方建议更勤，代价只是一次很轻的 GET。 */
const IP_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 回执节流默认值（分钟）：同一客户在这段时间内只回一次。
 *  配额依据：客户每轮主动发消息后有 5 条 / 48 小时；10 分钟窗口让客户连发多条也只烧 1 条。 */
const DEFAULT_REPLY_THROTTLE_MINUTES = 10;

/** 消息来源（官方文档 `msg_list.origin`）：3 = 微信客户，4 = 系统事件，5 = 接待人员。 */
const ORIGIN_CUSTOMER = 3;
const ORIGIN_SYSTEM_EVENT = 4;

/** 凭据的 KV 键前缀（部署级；运维用命令行配）。 */
const KEY = {
  corpId: "wecom.corpId",
  secret: "wecom.secret",
  callbackToken: "wecom.callbackToken",
  encodingAesKey: "wecom.encodingAesKey",
  openKfids: "wecom.openKfids",
} as const;

/** 读一条部署级凭据。 */
function cred(db: RegistryDb, key: keyof typeof KEY): string {
  return getRelaySetting(db, KEY[key]) ?? "";
}

/** 游标的 KV 键（按客服账号分）。 */
const cursorKey = (openKfid: string): string => `cursor:wecom:${openKfid}`;

/** 微信客服接入的运行时：持有定时器、拉取中标记、回执节流。
 *
 *  除下面的协议特有方法外，还要满足 `RelayIngress` 的契约（name/label/description +
 *  bindings/delivery + register）——那几样由 Router 统一驱动。 */
export interface WecomIngress extends RelayIngress {
  /** 启动轮询兜底（可重复调用，幂等）。 */
  start(): void;
  /** 停止（撤销定时器 + 等在途拉取收手）。 */
  stop(): void | Promise<void>;
  /** 回调处理器（`/relay/wecom/callback` 的 GET 与 POST）。 */
  handleCallback(input: {
    method: string;
    query: unknown;
    body: unknown;
    /** 来源 IP（白名单校验用）。 */
    sourceIp: string;
  }): Promise<{ status: number; body: string }>;
  /** 取回媒体占位（`wecom-media:<id>`）背后的字节。 */
  fetchMedia(
    placeholder: string,
  ): Promise<{ bytes: Uint8Array; contentType: string | null } | null>;
}

/** 造微信客服接入。
 *
 * @param db 系统库（凭据、游标、绑定表都在这）
 * @param hub 空间集线器（投递要用）
 * @param log 日志口（core 统一加前缀）
 */
export function makeWecomIngress(db: RegistryDb, hub: SpaceHub, log: RouterLog): WecomIngress {
  // 本接入自己的绑定表与分发开关（D-134）：键按 name 分区，与其它接入互不干扰
  const { bindings, delivery } = makeIngressStores(db, SOURCE_NAME);
  /** 正在拉取（防回调与定时器并发拉同一账号 → 游标串号）。 */
  const syncing = new Set<string>();
  /** 本进程在跑的拉取（stop 要等它们收手——否则关停后还有消息往被拆掉的空间里投）。 */
  const inFlight = new Set<Promise<unknown>>();
  /** 已停：置位后 `syncAll` 立刻收手，不再发起新的拉取/投递。 */
  let stopping = false;
  /** 回执节流：客户 id → 下次允许回执的时刻（毫秒）。 */
  const repliedUntil = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  /** 最近一次回调带来的拉取令牌（官方：回调事件 `<Token>`，**10 分钟内有效**）。
   *
   *  它不是配置项——企业微信在 `kf_msg_or_event` 事件里现给，用完即弃。官方也允许不填，
   *  但「不填接口有严格的频率限制」，所以能拿到就带上。过期后自然回落到不带令牌拉取。 */
  let pullToken: { value: string; until: number } | null = null;
  /** 回调来源白名单（`null` = 还没拉过；空清单 = 拉过但一条都没解析出来，按放行处理并留痕）。 */
  let allowList: IpAllowList | null = null;
  let ipTimer: ReturnType<typeof setInterval> | null = null;

  /** 拉一次回调 IP 段并替换白名单。
   *
   *  失败**保留上一份**（不清空）：拉不到时清空会退回「全放行」，而上一份虽然可能过期、
   *  也仍然是比「谁都放进来」更紧的口径；同时留痕让人能看见。
   */
  async function refreshCallbackIps(): Promise<void> {
    const corpId = cred(db, "corpId");
    const secret = cred(db, "secret");
    if (corpId === "" || secret === "") return; // 未配置：白名单无从拉起，按放行（验签仍是主防线）
    try {
      const token = await getAccessToken(corpId, secret);
      const ips = await getCallbackIps(token);
      allowList = new IpAllowList(ips, (bad) =>
        log.warn(`回调 IP 段里有无法解析的条目（已忽略）：${bad}`),
      );
      if (allowList.isEmpty) {
        log.warn("回调 IP 段拉到了空清单——本次不启用来源白名单（验签仍是主防线）");
      } else {
        log.info(`回调 IP 白名单已更新（${ips.length} 条）`);
      }
    } catch (err) {
      log.warn(
        `拉取回调 IP 段失败（沿用上一份${allowList === null ? "：当前无白名单，按放行处理" : ""}）：${errText(err)}`,
      );
    }
  }

  /** 已配置的客服账号（逗号/空白分隔）。 */
  const configuredKfIds = (): string[] =>
    cred(db, "openKfids")
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter((s) => s !== "");

  /** 回执节流的生效值（毫秒）。
   *
   *  **非法值不许静默失效**：`Number("")` 是 0（会被 `Math.max(1, …)` 悄悄改成 1 分钟）、
   *  `Number("10分钟")` 是 NaN（`NaN > now` 恒假 ⇒ 节流整个关掉，客户被回执刷屏且无日志）。
   *  所以这里严格解析：缺省用默认值，非法值**留痕**后按默认值处理（与信源设置「坏 JSON 按未设置
   *  处理 + 留痕」同一姿势）。写入侧另由 `writeRouterSetting` 的数字类型校验拦一道（D-103）。 */
  function replyThrottleMs(): number {
    const raw = getRelaySetting(db, "wecom.replyThrottleMinutes");
    if (raw === null) return DEFAULT_REPLY_THROTTLE_MINUTES * 60_000;
    const minutes = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(minutes) || minutes <= 0) {
      log.warn(
        `回执节流设置不是正数（${JSON.stringify(raw)}），按默认 ${DEFAULT_REPLY_THROTTLE_MINUTES} 分钟处理`,
      );
      return DEFAULT_REPLY_THROTTLE_MINUTES * 60_000;
    }
    return minutes * 60_000;
  }

  /** 给某客户回执（按客户节流；失败不重试——转人工/配额满都是不该重试的情形）。 */
  async function replyOnce(
    openKfid: string,
    externalUserId: string,
    text: string,
    nowMs: number,
  ): Promise<void> {
    const throttleMs = replyThrottleMs();
    if ((repliedUntil.get(externalUserId) ?? 0) > nowMs) return; // 窗口内已回过
    // 先占位再发：并发拉取同一客户时不会重复回两次
    repliedUntil.set(externalUserId, nowMs + throttleMs);
    try {
      const token = await getAccessToken(cred(db, "corpId"), cred(db, "secret"));
      const res = await sendKfText(token, { touser: externalUserId, openKfid, content: text });
      if (!wecomOk(res)) {
        // 会话转人工/排队/已结束、或配额耗尽——留痕即可，不重试
        log.warn(`回执未送达（${externalUserId}）：${wecomError(res)}`);
      }
    } catch (err) {
      log.warn(`回执发送失败（${externalUserId}）：${errText(err)}`);
    }
  }

  /** 投递一条消息给它的归属账户，并按结果决定回什么话。
   *
   *  三种结果对应三种回执：
   *   · 投递成功 → 「信息已收到」
   *   · 未绑定 / 账户不存在 → 给绑定码
   *   · 账户停用 / 信源未启用 → 「暂不可用」
   */
  async function dispatch(msg: unknown, receivedAt: string): Promise<void> {
    const parsed = RoutingFieldsSchema.safeParse(msg);
    if (!parsed.success) return;
    const m = parsed.data;
    const ext = m.external_userid ?? "";
    const kfid = m.open_kfid ?? "";
    if (kfid === "" || ext === "") return; // 无法分流
    if (m.origin === ORIGIN_SYSTEM_EVENT) return; // 系统事件不是对话内容

    const uid = bindings.resolve(ext); // 坏绑定表会抛——响亮失败，不静默发错码
    if (uid === null) {
      if (m.origin === ORIGIN_CUSTOMER) await replyOnce(kfid, ext, UNBOUND_REPLY(ext), Date.now());
      return;
    }

    // 用户关掉了分发：客户照常收到「暂不可用」，消息不进来（比清绑定温和——客户知道人还在）
    if (!delivery.isEnabled(uid)) {
      log.info(`账户 ${uid} 已关闭分发，跳过一条来自 ${ext} 的消息`);
      if (m.origin === ORIGIN_CUSTOMER) await replyOnce(kfid, ext, UNAVAILABLE_REPLY, Date.now());
      return;
    }

    const result = await deliver(hub, uid, SOURCE_NAME, { raw: msg, receivedAt }, (space) => {
      // 媒体占位取字节：`wecom-media:<id>` 要 access_token，token 只在 Router——
      // 所以由 Router 把自己的本事塞进目标账户（幂等；空间首次投递时才被 ensure 出来）
      // 写 **relay** 那张表，不是信源那张：这张不暴露给 /api/ingest，
      // 免得任何登录用户借部署凭据去取别人的 media_id（见 SpaceDeps 的注释）
      space.relayMediaFetchers.set(SOURCE_NAME, (placeholder) => fetchMedia(placeholder));
    });
    if (result.ok) {
      if (m.origin === ORIGIN_CUSTOMER) await replyOnce(kfid, ext, REPLY_TEXT, Date.now());
      return;
    }
    // no_account：账户不在了（换绑 / 删号）→ 当作未绑定，给码
    if (result.reason === "no_account") {
      if (m.origin === ORIGIN_CUSTOMER) await replyOnce(kfid, ext, UNBOUND_REPLY(ext), Date.now());
      return;
    }
    // no_source（用户关了开关）/ rejected / ensure_failed → 暂时收不了
    log.warn(
      `投递未成功（${ext} → ${uid}）：${result.reason}${result.detail ? `（${result.detail}）` : ""}`,
    );
    if (m.origin === ORIGIN_CUSTOMER) await replyOnce(kfid, ext, UNAVAILABLE_REPLY, Date.now());
  }

  /** 当前可用的拉取令牌（过期就当成没有——带一个过期令牌比不带更容易被拒）。
   *
   *  官方：回调事件里的 `token`「10分钟内有效」；不填也能拉，只是频率限制更严。 */
  function currentPullToken(): string {
    if (pullToken === null) return "";
    if (pullToken.until <= Date.now()) {
      pullToken = null;
      return "";
    }
    return pullToken.value;
  }

  /** 拉一个客服账号的消息（最多 MAX_PAGES_PER_SYNC 页），逐条投递。 */
  async function syncOne(openKfid: string): Promise<void> {
    if (syncing.has(openKfid)) return;
    syncing.add(openKfid);
    try {
      const corpId = cred(db, "corpId");
      const secret = cred(db, "secret");
      if (corpId === "" || secret === "") {
        log.warn("未配置 corpId / secret，无法拉取客服消息");
        return;
      }
      const accessToken = await getAccessToken(corpId, secret);
      for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
        const cursor = getRelaySetting(db, cursorKey(openKfid)) ?? "";
        const res = await syncKfMessages(accessToken, cursor, currentPullToken(), openKfid);
        if (!wecomOk(res)) {
          log.error(`sync_msg 失败：${wecomError(res)}`);
          return;
        }
        const list = res.msg_list ?? [];
        const receivedAt = nowWallClock();
        for (const msg of list) {
          if (stopping) return; // 关停中：不再往空间里投（否则会重新装配出刚拆掉的空间）
          try {
            await dispatch(msg, receivedAt);
          } catch (err) {
            // 单条炸掉不许拖累整页：一页最多 1000 条，而游标只能在**整页派发完之后**推进
            // （next_cursor 是服务端按页给的）。让一条坏消息中断整页 = 这一页剩下的既不投、
            // 游标也不动，下一轮原样重来。所以逐条隔离：坏的留痕，好的照样投，游标照常推进；
            // 被跳过的那条靠信源侧的 messageId 去重不会重复入批。
            log.error(`投递单条消息失败（已跳过，继续本页）：${errText(err)}`);
          }
        }
        // 游标推进：有 next_cursor 才更新（没有 = 这条流已取完）
        if (typeof res.next_cursor === "string" && res.next_cursor !== "") {
          setRelaySetting(db, cursorKey(openKfid), res.next_cursor);
        }
        if (res.has_more !== 1) break;
      }
    } catch (err) {
      log.error(outboundFailure(err));
    } finally {
      syncing.delete(openKfid);
    }
  }

  /** 拉全部已配置的客服账号（单账号失败不影响其余）。
   *
   *  ⚠️ 两处「不能让它抛出去」：本函数是 `void syncAll()` 调起的（回调与定时器），
   *  抛出去就是**未处理 rejection**——Node ≥15 直接退进程，把优雅关停和其它账户的
   *  在途请求一起带走。读设置（`configuredKfIds`）也在 try 之外，备份持锁时
   *  better-sqlite3 会同步抛 SQLITE_BUSY。 */
  async function syncAll(): Promise<void> {
    if (stopping) return; // 关停中：不再发起新的拉取
    let kfids: string[];
    try {
      kfids = configuredKfIds();
    } catch (err) {
      log.error(`读客服账号配置失败：${errText(err)}`);
      return;
    }
    for (const kfid of kfids) {
      if (stopping) return;
      try {
        await syncOne(kfid);
      } catch (err) {
        log.error(`拉取 ${kfid} 失败：${errText(err)}`);
      }
    }
  }

  /** 起一次拉取并登记在飞（异常在这里收干净——绝不外逃）。 */
  function kickSync(): void {
    if (stopping) return;
    const p = syncAll()
      .catch((err: unknown) => {
        log.error(`拉取轮次失败：${errText(err)}`);
      })
      .finally(() => {
        inFlight.delete(p);
      });
    inFlight.add(p);
  }

  /** 验签 + 解密 + 核对 receiveId（三种失败返回错误码，成功返回明文 XML）。 */
  function verifyAndDecrypt(
    query: { msg_signature: string; timestamp: string; nonce: string },
    encrypted: string,
  ): { ok: true; xml: string } | { ok: false; status: number; error: string } {
    const token = cred(db, "callbackToken");
    const aesKey = cred(db, "encodingAesKey");
    const corpId = cred(db, "corpId");
    if (
      !signatureMatches(
        callbackSignature(token, query.timestamp, query.nonce, encrypted),
        query.msg_signature,
      )
    ) {
      log.warn("回调签名不匹配");
      return { ok: false, status: 401, error: "签名不匹配" };
    }
    let payload;
    try {
      payload = decryptCallback(encrypted, aesKey);
    } catch (err) {
      log.error(`回调解密失败：${errText(err)}`);
      return { ok: false, status: 400, error: "解密失败" };
    }
    if (corpId !== "" && payload.receiveId !== corpId) {
      // receiveId 不符 = 这个回调不是发给本企业的（配置串了/被重放）
      log.warn(`回调 receiveId 不匹配（收到 ${payload.receiveId}）`);
      return { ok: false, status: 401, error: "企业 id 不匹配" };
    }
    return { ok: true, xml: payload.xml };
  }

  /** 回调：企业微信只给一个 URL，GET 是 URL 验证、POST 是事件推送。
   *
   *  两者都必须先验签——不验签就等于让任何人都能触发拉取/冒充事件。
   *  企业微信要求 5 秒内应答，所以拉取一律异步（先回 200）。 */
  async function handleCallback({
    method,
    query,
    body,
    sourceIp,
  }: {
    method: string;
    query: unknown;
    body: unknown;
    sourceIp: string;
  }): Promise<{ status: number; body: string }> {
    // 来源白名单（第二道闸）：减少无效的验签/解密计算。**不是**唯一防线——
    // 验签才是；白名单未就绪（没配凭据/还没拉到/清单为空）时放行，否则会静默断流。
    if (allowList !== null && !allowList.isEmpty && !allowList.contains(sourceIp)) {
      log.warn(`拒绝非企业微信来源的回调（${sourceIp}）`);
      return { status: 403, body: "来源不在白名单" };
    }
    const q = z
      .object({
        msg_signature: z.string(),
        timestamp: z.string(),
        nonce: z.string(),
        echostr: z.string().optional(),
      })
      .safeParse(query);
    if (!q.success) return { status: 400, body: "回调参数不完整" };

    if (cred(db, "callbackToken") === "" || cred(db, "encodingAesKey") === "") {
      log.error("回调未配置：请用命令行填 callbackToken / encodingAesKey");
      return { status: 500, body: "未配置" };
    }

    // URL 验证：GET + echostr
    if (method === "GET") {
      const echo = q.data.echostr;
      if (echo === undefined) return { status: 400, body: "缺少 echostr" };
      const verified = verifyAndDecrypt(q.data, echo);
      if (!verified.ok) return { status: verified.status, body: verified.error };
      return { status: 200, body: verified.xml };
    }

    // 事件推送：POST（body 是 XML，含 Encrypt）
    const encrypt = xmlField(typeof body === "string" ? body : "", "Encrypt");
    if (encrypt === null) return { status: 400, body: "缺少 Encrypt" };
    const verified = verifyAndDecrypt(q.data, encrypt);
    if (!verified.ok) return { status: verified.status, body: verified.error };

    const event = xmlField(verified.xml, "Event");
    if (event === "kf_msg_or_event") {
      // 事件体里带一个 10 分钟有效的拉取令牌——记下来，拉取时带上
      // （官方：不填也能拉，但「不填接口有严格的频率限制」）
      const pulled = xmlField(verified.xml, "Token");
      if (pulled !== null && pulled !== "") {
        pullToken = { value: pulled, until: Date.now() + PULL_TOKEN_TTL_MS };
      }
      kickSync(); // 先 200 再拉（5 秒窗口）
    } else {
      log.debug(`忽略事件类型：${event ?? "（无）"}`);
    }
    return { status: 200, body: "success" };
  }

  /** 取回媒体占位背后的字节（`wecom-media:<media_id>`）。
   *
   *  企业微信的图片只给 media_id，取字节要 access_token——这正是它必须留在 Router 的原因：
   *  凭据在这里，信源层没有也不该有。Router 在首次向某账户投递时把它塞进该账户的
   *  `mediaFetchers`（见 `dispatch`），core 的图片缓存届时按批次的 source 查到它。 */
  async function fetchMedia(
    placeholder: string,
  ): Promise<{ bytes: Uint8Array; contentType: string | null } | null> {
    const prefix = "wecom-media:";
    if (!placeholder.startsWith(prefix)) return null;
    const mediaId = placeholder.slice(prefix.length);
    if (mediaId === "") return null;
    const corpId = cred(db, "corpId");
    const secret = cred(db, "secret");
    if (corpId === "" || secret === "") {
      log.warn("未配置 corpId / secret，无法取回媒体");
      return null;
    }
    try {
      const token = await getAccessToken(corpId, secret);
      const got = await downloadKfMedia(token, mediaId);
      return { bytes: got.bytes, contentType: got.contentType };
    } catch (err) {
      log.error(`取回媒体失败（${mediaId}）：${errText(err)}`);
      return null;
    }
  }

  return {
    name: SOURCE_NAME,
    label: "微信客服",
    description: "客户在微信里发给客服号的消息——按绑定码分流到各账户",
    bindings,
    delivery,

    start(): void {
      if (timer !== null) return; // 幂等
      timer = setInterval(kickSync, POLL_INTERVAL_MS);
      // 回调 IP 白名单：启动拉一次，之后每 6 小时刷新（官方建议每天一次）
      void refreshCallbackIps();
      ipTimer = setInterval(() => void refreshCallbackIps(), IP_REFRESH_INTERVAL_MS);
    },

    /** 挂本接入的 HTTP 路由（`/relay/wecom/*`）。
     *
     *  路径写在这里而不是 `app.ts`：**接入自己才知道自己的回调地址长什么样**——
     *  core 只是把 app 递过来。将来加爬虫接入，`app.ts` 一行不用改。 */
    register(app: FastifyInstance): void {
      // GET = URL 验证，POST = 事件推送（企业微信只给一个 URL）
      app.route({
        method: ["GET", "POST"],
        url: "/relay/wecom/callback",
        handler: async (req, reply) => {
          const result = await handleCallback({
            method: req.method,
            // 自己解 query（见 parseQueryRfc3986）：`req.query` 会把 base64 里的 `+` 解成空格
            query: parseQueryRfc3986(req.raw.url ?? ""),
            body: req.body,
            // trustProxy 开启时 req.ip 已是 XFF 里的真实来源（Caddy 反代后必须开）
            sourceIp: req.ip,
          });
          return reply.code(result.status).type("text/plain").send(result.body);
        },
      });
    },

    /** 停止：先置位（不再发起新拉取/新投递），再**等在途拉取收手**。
     *
     *  只 clearInterval 是不够的：一次拉取最多 5 页 × 1000 条，关停时它可能正跑到中途。
     *  不等它，`hub.forDelivery` 会在 `closeAll` 拆掉空间之后**重新装配**一个新空间，
     *  消息进了一个没有定时器扫的缓冲 → 进程退出 → 那批静默丢失。
     *
     *  等待有上限：卡死（网络挂起）也只等 STOP_WAIT_MS，之后照常返回——关停不许被无限拖住。 */
    async stop(): Promise<void> {
      stopping = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (ipTimer !== null) {
        clearInterval(ipTimer);
        ipTimer = null;
      }
      if (inFlight.size === 0) return;
      const all = Promise.allSettled([...inFlight]);
      const timeout = new Promise<void>((resolve) => {
        const t = setTimeout(() => resolve(), STOP_WAIT_MS);
        t.unref?.(); // 不要因为这个计时器把进程吊住
      });
      await Promise.race([all.then(() => undefined), timeout]);
      const left = inFlight.size;
      if (left > 0) log.warn(`关停时仍有 ${left} 个拉取未收手（已放弃等待）——这一批可能没投完`);
    },

    fetchMedia,
    handleCallback,
  };
}
