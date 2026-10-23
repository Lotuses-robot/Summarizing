import { z } from "zod";
import { errText } from "@summarizing/shared";
import { IMAGE_DOWNLOAD_MAX_BYTES } from "../../shared/imageDownloader";

// 企业微信 API 出站客户端（D-128）：只管「把请求发到固定官方域名并解析 JSON」，不含业务判断。
//
// 域名写死在代码里（不来自设置/消息）= 结构上不可能被诱导去连别处——
// 这比「配一个可自由填写的 baseUrl」安全得多：后者等于给信源开了一个 SSRF 出口。
// 需要网关/代理的场景（企业内网）走 `WECOM_API_BASE` 环境变量，且**只允许 https**。

const DEFAULT_API_BASE = "https://qyapi.weixin.qq.com";

/** 一次出站调用的超时：企业微信接口都快，超时说明网络或凭据出了问题，宁可失败也别挂死扫描。 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 单份媒体的字节上限（与公开 URL 那条路同一个口径——`imageDownloader` 的常量是单一出处）。 */
const MEDIA_MAX_BYTES = IMAGE_DOWNLOAD_MAX_BYTES;

/** 接口返回的通用信封。`errcode !== 0` 即失败——由调用方决定怎么处置（留痕/退避）。 */
export interface WecomEnvelope {
  errcode?: number;
  errmsg?: string;
}

/** 取 API 基地址（默认官方域名；环境变量可覆盖，只接受 https）。 */
function apiBase(): string {
  const configured = process.env.WECOM_API_BASE;
  if (configured === undefined || configured.trim() === "") return DEFAULT_API_BASE;
  if (!configured.startsWith("https://")) {
    throw new Error("WECOM_API_BASE 必须是 https:// 开头的地址");
  }
  return configured.replace(/\/$/, "");
}

/** 发一个 GET 并解析 JSON（query 由调用方拼好并自行 encode）。
 *
 * @param path 接口路径（如 `/cgi-bin/gettoken`）
 * @param query 已经编码好的查询串（不含 `?`）
 * @returns 解析后的 JSON（含 errcode 也可能含数据字段）
 * @throws 网络错误/超时/非 JSON
 */
async function wecomGet<T extends object>(path: string, query: string): Promise<T> {
  const url = `${apiBase()}${path}?${query}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`企业微信接口 HTTP ${res.status}：${text.slice(0, 200)}`);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`企业微信接口返回非对象：${text.slice(0, 200)}`);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

/** 发一个 POST（JSON body）并解析 JSON。
 *
 * @param path 接口路径
 * @param body 请求体（会被 JSON 序列化）
 * @returns 解析后的 JSON
 * @throws 网络错误/超时/非 JSON
 */
async function wecomPost<T extends object>(path: string, body: unknown): Promise<T> {
  const url = `${apiBase()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`企业微信接口 HTTP ${res.status}：${text.slice(0, 200)}`);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`企业微信接口返回非对象：${text.slice(0, 200)}`);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

/** 判一次调用是否成功（errcode 缺省视为 0——部分接口成功时不带该字段）。 */
export function wecomOk(res: WecomEnvelope): boolean {
  return (res.errcode ?? 0) === 0;
}

/** 失败原因的人话（给留痕用；errcode 一并保留，便于对照官方文档）。 */
export function wecomError(res: WecomEnvelope): string {
  return `errcode=${String(res.errcode ?? "?")} ${res.errmsg ?? "（无说明）"}`;
}

/** 把一次出站失败包成人话（保留 errcode 便于排障）。 */
export function outboundFailure(err: unknown): string {
  return `企业微信接口调用失败：${errText(err)}`;
}

// ── 鉴权 ────────────────────────────────────────────────────────────────

/** access_token 缓存：企业微信的 token 有效期 7200s、调用频次有限——**必须缓存**，
 *  否则每次拉消息都要换一次 token，很快触发频率限制。提前 5 分钟过期以避开边界。 */
interface TokenCache {
  token: string;
  expiresAt: number; // epoch ms
}

const tokenCache = new Map<string, TokenCache>();

/** 拿一个可用的 access_token（按 corpid+secret 缓存）。
 *
 * @param corpId 企业 id
 * @param secret 应用的 Secret
 * @returns access_token
 * @throws 换取失败（errcode 非 0）
 */
export async function getAccessToken(corpId: string, secret: string): Promise<string> {
  const cacheKey = `${corpId}\u0000${secret}`;
  const cached = tokenCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.token;

  const res = await wecomGet<WecomEnvelope & { access_token?: string; expires_in?: number }>(
    "/cgi-bin/gettoken",
    `corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`,
  );
  if (!wecomOk(res) || typeof res.access_token !== "string") {
    throw new Error(`换取 access_token 失败：${wecomError(res)}`);
  }
  const ttlSec = typeof res.expires_in === "number" ? res.expires_in : 7200;
  tokenCache.set(cacheKey, {
    token: res.access_token,
    expiresAt: Date.now() + Math.max(60, ttlSec - 300) * 1000,
  });
  return res.access_token;
}

// ── 回调来源（官方「获取企业微信回调IP段」）──────────────────────────────

/** 取企业微信回调的来源 IP 段。
 *
 *  官方文档（`getcallbackip`）：企业微信回调是「通过特定的 IP 发送出去的」，
 *  建议**每天定时拉取**更新防火墙；IP 段变更时新旧会同时保留一段时间。
 *  这就是本项目的「只收微信发来的回调」的可靠做法——我们是**接收方**，
 *  看不到对方的域名，只能看来源 IP。
 *
 *  @param token access_token
 *  @returns IP（或 CIDR）字符串数组
 *  @throws 换取失败（errcode 非 0）或返回形状不对
 */
export async function getCallbackIps(token: string): Promise<string[]> {
  const res = await wecomGet<WecomEnvelope & { ip_list?: unknown }>(
    "/cgi-bin/getcallbackip",
    `access_token=${encodeURIComponent(token)}`,
  );
  if (!wecomOk(res)) throw new Error(`获取回调 IP 段失败：${wecomError(res)}`);
  const parsed = z.array(z.string()).safeParse(res.ip_list);
  if (!parsed.success) throw new Error("获取回调 IP 段失败：ip_list 形状不符");
  return parsed.data;
}

// ── 微信客服（kf）────────────────────────────────────────────────────────

/** sync_msg 的响应体。
 *
 *  `msg_list` 刻意是 `unknown[]`：**Router 不认识消息长什么样**（D-130）——
 *  它只把每条原样转给信源的 `accept`，只有信源才解析协议字段。 */
export interface SyncMsgResult extends WecomEnvelope {
  next_cursor?: string;
  has_more?: number;
  msg_list?: unknown[];
}

/** 拉取一批客服消息。
 *
 * @param token access_token
 * @param cursor 上次的游标（空串 = 从头）
 * @param token_ 拉取消息用的 Token（部署级设置 `wecom.pullToken`，非 access_token）
 * @param openKfid 客服账号 id（**一次只拉一个**——多个账号各自有独立游标）
 * @returns 响应体（含 next_cursor / has_more / msg_list）
 * @throws 网络或 JSON 错误（errcode 由调用方判断）
 */
export async function syncKfMessages(
  token: string,
  cursor: string,
  token_: string,
  openKfid: string,
): Promise<SyncMsgResult> {
  return wecomPost<SyncMsgResult>(
    `/cgi-bin/kf/sync_msg?access_token=${encodeURIComponent(token)}`,
    {
      cursor,
      token: token_,
      limit: 1000,
      voice_format: 0,
      open_kfid: openKfid,
    },
  );
}

/** 下载客服消息里的媒体（图片/语音/文件）字节。
 *
 * 为什么这个接口需要带 access_token：企业微信不把媒体放在公开 URL 上，只给 media_id。
 * 取字节因此必须由**持有凭据的 Router** 做——信源只写 `[图片](wecom-media:<id>)` 占位，
 * 从不接触 token（D-130）。
 *
 * @param token access_token
 * @param mediaId 媒体 id
 * @returns 字节与 content-type
 * @throws 网络错误/HTTP 错误/企业微信返回 JSON 错误信封
 */
export async function downloadKfMedia(
  token: string,
  mediaId: string,
): Promise<{ bytes: Buffer; contentType: string | null }> {
  const url = `${apiBase()}/cgi-bin/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`下载媒体 HTTP ${res.status}`);
    const contentType = res.headers.get("content-type");
    // 失败时企业微信回的是 JSON（errcode），不是文件——按 content-type 嗅一下，
    // 别把一段错误 JSON 当成图片存进媒体库（那会变成「一张打不开的图」）
    if (contentType !== null && contentType.includes("application/json")) {
      const text = await res.text();
      throw new Error(`下载媒体失败：${text.slice(0, 200)}`);
    }
    // 流式卡上限：`arrayBuffer()` 是**先整份进内存再判**——2C2G 的机器上两个并发就能吃满。
    // 公开 URL 那条路（imageDownloader）早就在流上数字节了，这里补齐同一道闸。
    const declared = res.headers.get("content-length");
    if (declared !== null && Number(declared) > MEDIA_MAX_BYTES) {
      throw new Error(`媒体超过大小上限（${MEDIA_MAX_BYTES / 1024 / 1024} MiB）`);
    }
    // ⚠️ undici 的 `ReadableStream` 不带元素类型（`body: ReadableStream | null`），
    // `for await` 出来的 chunk 是 any——必须收窄，不能让 any 流进字节累加（工程红线）。
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body !== null) {
      for await (const chunk of res.body) {
        // `for await` 的元素是 any（undici 的 ReadableStream 不带泛型）：先收窄再用
        const bytes: unknown = chunk;
        if (!(bytes instanceof Uint8Array)) throw new Error("媒体下载返回了非字节块");
        total += bytes.byteLength;
        if (total > MEDIA_MAX_BYTES) throw new Error("媒体超过大小上限");
        chunks.push(bytes);
      }
    }
    return { bytes: Buffer.concat(chunks), contentType };
  } finally {
    clearTimeout(timer);
  }
}

/** 发送客服消息（文本）。
 *
 * 官方限制（《发送消息》文档 2026-02-27 版）：
 *  - 仅当客户处于「新接入待处理」(0) 或「由智能助手接待」(1) 时可用；
 *    会话被人工接入 (3) / 排队 (2) / 已结束 (4) 时调用会失败。
 *  - 客户主动发消息后的 48 小时内最多下发 5 条；客户再发消息可再次下发。
 * 因为存在这两条限制，本函数**不重试**：失败基本是状态或配额问题，重试只会持续失败。
 *
 * @param token access_token
 * @param body 收件人与内容
 * @param body.touser 客户的 external_userid
 * @param body.openKfid 客服账号 id
 * @param body.content 纯文本内容
 * @returns 响应信封（errcode 由调用方判断）
 */
export async function sendKfText(
  token: string,
  body: { touser: string; openKfid: string; content: string },
): Promise<WecomEnvelope & { msgid?: string }> {
  return wecomPost(`/cgi-bin/kf/send_msg?access_token=${encodeURIComponent(token)}`, {
    touser: body.touser,
    open_kfid: body.openKfid,
    msgtype: "text",
    text: { content: body.content },
  });
}

/** 会话状态（官方「概述」的状态表）：只有 0/1/2 允许调 `send_msg` 回消息。
 *
 *  - 0 未处理（客户发消息后进入，**可回**）
 *  - 1 由智能助手接待（**可回**）
 *  - 2 待接入池排队中（可转接待，但**不能直接回**）
 *  - 3 由人工接待（**不可回**——95018 就是这个）
 *  - 4 已结束/未开始（**不可回**；客户再发消息会转 0）
 */
export type KfServiceState = 0 | 1 | 2 | 3 | 4;

/** 查一个客户在某客服账号下的会话状态。
 *
 *  查它的理由：`send_msg` 失败只给 `95018 session status invalid`，说不出**为什么**——
 *  是人工接手了（3）、排队中（2），还是会话已结束（4）？三者的处置完全不同
 *  （前者不该回，后者等客户再发就有了）。把状态打出来，「回执发不出去」才可判读。
 *
 * @param token access_token
 * @param openKfid 客服账号 id
 * @param externalUserId 客户 id
 * @returns 会话状态；接口失败返回 null（查状态是排障用的，不该反过来影响主流程）
 */
export async function getServiceState(
  token: string,
  openKfid: string,
  externalUserId: string,
): Promise<KfServiceState | null> {
  try {
    const res = await wecomPost<WecomEnvelope & { service_state?: unknown }>(
      `/cgi-bin/kf/service_state/get?access_token=${encodeURIComponent(token)}`,
      { open_kfid: openKfid, external_userid: externalUserId },
    );
    if (!wecomOk(res)) return null;
    const state = res.service_state;
    // 0–4 是官方定义的全部取值；其余（字符串/越界）当作查不到——不让脏值冒充实类型
    if (typeof state !== "number" || !Number.isInteger(state)) return null;
    if (state < 0 || state > 4) return null;
    return state === 0 || state === 1 || state === 2 || state === 3 || state === 4 ? state : null;
  } catch {
    return null; // 查不到就只是少一条诊断信息，不能因此中断回执流程
  }
}

/** 把会话转成「由智能助手接待」（状态 1）。
 *
 *  **这是「通过 API 管理客服账号」必须自己做的一步**。官方说明原文：
 *  「用户咨询客服时，将由开发者通过 API 来做**会话分配**和消息收发。原先在帐号详情处设置的
 *  接待规则……将暂时不对该账号生效。」
 *  也就是说，一旦把账号交给 API 管理，微信**不再**帮你决定会话归谁——新消息就停在
 *  「待接入池排队中」（状态 2），而那个状态下**不允许发消息**（实测 95018）。
 *  所以收到新消息后必须先把它转成「智能助手接待」，才谈得上回执。
 *
 *  官方允许的流转（概述状态表）：0 → 1、2→3、3→转接/结束。**2 不能直接回 1**，
 *  所以从 2 进来时先结束会话（→4），客户下一条消息会重新回到 0，那时就能转 1。
 *
 * @param token access_token
 * @param openKfid 客服账号 id
 * @param externalUserId 客户 id
 * @param target 目标状态（本项目只用 1=智能助手接待 / 4=结束会话）
 * @param servicerUserId 指定接待人员（转 3 时必填；转 1/4 不需要）
 * @returns 成功与否（失败只留痕，由调用方决定要不要继续尝试回执）
 */
export async function transServiceState(
  token: string,
  openKfid: string,
  externalUserId: string,
  target: KfServiceState,
  servicerUserId?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await wecomPost<WecomEnvelope>(
      `/cgi-bin/kf/service_state/trans?access_token=${encodeURIComponent(token)}`,
      {
        open_kfid: openKfid,
        external_userid: externalUserId,
        service_state: target,
        ...(servicerUserId === undefined ? {} : { servicer_userid: servicerUserId }),
      },
    );
    return wecomOk(res) ? { ok: true } : { ok: false, reason: wecomError(res) };
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
}

/** 本客服账号的接待人员（官方 `kf/servicer/list`）。
 *
 *  为什么需要：把会话转成「人工接待」（状态 3）时 `servicer_userid` **必填**，
 *  且该人须处于「正在接待」。要自动走 2→3→4 这条重置链路，就得先知道有谁可用。
 */
export async function listServicers(
  token: string,
  openKfid: string,
): Promise<Array<{ userId: string; status: number }>> {
  try {
    const res = await wecomGet<WecomEnvelope & { servicer_list?: unknown }>(
      "/cgi-bin/kf/servicer/list",
      `access_token=${encodeURIComponent(token)}&open_kfid=${encodeURIComponent(openKfid)}`,
    );
    if (!wecomOk(res)) return [];
    // 官方形状：userid + status(0 接待中 / 1 停止接待)；也可能给 department_id（无 userid）
    const parsed = z
      .array(
        z.object({
          userid: z.string().optional(),
          status: z.number().optional(),
        }),
      )
      .safeParse(res.servicer_list);
    if (!parsed.success) return [];
    return parsed.data.flatMap((s) =>
      s.userid === undefined ? [] : [{ userId: s.userid, status: s.status ?? 1 }],
    );
  } catch {
    return []; // 查不到就当作没有可用接待人员——调用方会放弃并留痕
  }
}

/** 会话状态 → 人话（日志用；说明「为什么不能回」）。 */
export function serviceStateText(state: KfServiceState): string {
  switch (state) {
    case 0:
      return "未处理（可回）";
    case 1:
      return "由智能助手接待（可回）";
    case 2:
      return "待接入池排队中（不能直接回）";
    case 3:
      return "由人工接待（不能回）";
    case 4:
      return "已结束/未开始（不能回——客户再发消息会转「未处理」）";
  }
}
