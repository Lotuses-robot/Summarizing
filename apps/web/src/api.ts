import type {
  AiSettings,
  AiSettingsView,
  AiTestResult,
  AuthOk,
  BoardView,
  ChatHistoryItem,
  ChatHistoryResponse,
  ChatResponse,
  DigestState,
  GetItemResult,
  Item,
  LoginRequest,
  MeView,
  NoticeView,
  PipelineRun,
  PipelineRunDetail,
  RegisterRequest,
  RejectionRulesView,
  RotateTokenResponse,
  SourceSummary,
  TrashView,
  UncertainInput,
  UsageRange,
  UsageSummary,
  MediaUploadResponse,
} from "@summarizing/shared";

/** 类型化 API 客户端：web 只跟这些函数打交道。 */

// ── 401 单点拦截（006 / contracts/http.md 前端规约）──
// 任何**受保护**请求 401 → 全局「未认证」信号（App 切回未登录壳；清状态/停轮询由回调自理）。
// 豁免仅限：公开三件（register/login/logout）+ 启动探测 me——password/rotate 是受保护端点，
// 过期会话必须触发切壳（评审修复：曾整段豁免 /api/auth/*，改密失败只报「未登录」不切壳）。

const AUTH_401_EXEMPT = [
  "/api/auth/register",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
];

let onUnauthorized: (() => void) | null = null;

/** 注册全局 401 回调（App 挂一次；卸载时传 null 撤销）。 */
export function setOnUnauthorized(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/** 受保护请求的统一入口：fetch 后先过 401 哨兵（仅豁免上表），行为与裸 fetch 一致。 */
async function req(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status === 401 && !AUTH_401_EXEMPT.some((p) => url.startsWith(p))) onUnauthorized?.();
  return res;
}

/** 统一响应处理：非 2xx 抛错；2xx 返回按泛型标注的 JSON（调用方用 shared 类型标注）。 */
async function to<T>(res: Response): Promise<T> {
  ensureOk(res);
  return (await res.json()) as T;
}

/** 无响应体的写操作守卫：非 2xx 抛错（与 to 同一错误口径）。 */
function ensureOk(res: Response): void {
  if (!res.ok) throw new Error(`请求失败 ${res.status}`);
}

/** 从 unknown 安全提取 `issues[].message`（运行时类型守卫——不用 as 让编译器闭嘴，工程红线）。
 *  zod issues 形状 `{message?: string}[]`；非数组/元素非对象/message 非串都跳过。 */
function issueMessages(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const items: unknown[] = v; // Array.isArray 收窄为 any[]；赋给 unknown[] 收回元素静态类型
  const out: string[] = [];
  for (const item of items) {
    if (
      typeof item === "object" &&
      item !== null &&
      "message" in item &&
      typeof item.message === "string"
    ) {
      out.push(item.message);
    }
  }
  return out;
}

/** 认证端点非 2xx 的错误文案（校验类优先 issues 逐条消息；其余 {error}；非 JSON 兜底）。
 *  服务端校验失败返 `{error:"请求体不合法", issues:[zod 逐条中文]}——issues 才是「用户名至少 2 个字符」
 *  这类真话，顶层 error 只说明"哪里错了没写清"（A13：曾只取 error，用户永远看不到规则）。 */
async function authErrorText(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null) {
      if ("issues" in body) {
        const messages = issueMessages(body.issues);
        if (messages.length > 0) return messages.join("；");
      }
      if ("error" in body && typeof body.error === "string") {
        return body.error;
      }
    }
  } catch {
    // 非 JSON——用兜底文案
  }
  return `请求失败 ${res.status}`;
}

/** 认证端点响应（有体）：非 2xx 优先抛服务端 error 文案（登录表单要显示「账户已停用」等）；2xx 解析 JSON。 */
async function toAuth<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await authErrorText(res));
  return (await res.json()) as T;
}

/** 认证端点（成功态无体，如改密 204）：非 2xx 抛服务端文案；2xx 不解析 body
 *  （评审修复：toAuth 对 204 空体 res.json() 会抛 SyntaxError——改密明明成功了却报失败）。 */
async function ensureAuthOk(res: Response): Promise<void> {
  if (!res.ok) throw new Error(await authErrorText(res));
}

/** 构造 JSON 写请求的 fetch 参数（POST/PUT 共用——C1 教训：方法与后端注册的路由须一致）。 */
function jsonInit(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** 构造 POST 用的 fetch 参数（JSON 体）。 */
function post(body: unknown): RequestInit {
  return jsonInit("POST", body);
}

/** 构造 PUT 用的 fetch 参数（JSON 体）。 */
function put(body: unknown): RequestInit {
  return jsonInit("PUT", body);
}

/** ingest / retry 的受理回执（202 返回体）。 */
type DigestAck = { id: string; digestState: DigestState };

/** 后端 API 的类型化客户端：URL 和形状都收在这里。 */
export const api = {
  // ── 认证（006）──

  /** 注册（凭邀请码；成功即登录——Set-Cookie 由浏览器接洽）。 */
  register: (body: RegisterRequest): Promise<AuthOk> =>
    req("/api/auth/register", post(body)).then((r) => toAuth<AuthOk>(r)),

  /** 登录（错凭据/停用/锁定 → 服务端人话文案经 toAuth 抛出）。 */
  login: (body: LoginRequest): Promise<AuthOk> =>
    req("/api/auth/login", post(body)).then((r) => toAuth<AuthOk>(r)),

  /** 登出（清 cookie；幂等）。 */
  logout: (): Promise<void> => req("/api/auth/logout", post({})).then((r) => ensureOk(r)),

  /** 当前账户（启动探测：401 = 未登录的正常首屏路径，不进单点拦截）。 */
  me: (): Promise<MeView> => req("/api/auth/me").then((r) => to<MeView>(r)),

  /** 修改密码（其余端下线、本端续签；成功 204 无体）。 */
  changePassword: (oldPassword: string, newPassword: string): Promise<void> =>
    req("/api/auth/password", put({ oldPassword, newPassword })).then((r) => ensureAuthOk(r)),

  /** 轮换接入令牌（旧值即刻作废——全部旧接入地址 401）。 */
  rotateSourceToken: (): Promise<RotateTokenResponse> =>
    req("/api/auth/source-token/rotate", post({})).then((r) => toAuth<RotateTokenResponse>(r)),

  // ── 数据 ──

  board: (): Promise<BoardView> => req("/api/board").then((r) => to<BoardView>(r)),

  /** Token 用量（010）：活动栏「用量」仪表盘（三个总数互不重叠；cachedTokens 为 null = 服务商未提供）。 */
  usage: (range: UsageRange): Promise<UsageSummary> =>
    req(`/api/usage?range=${range}`).then((r) => to<UsageSummary>(r)),

  /** 上传图片（009）：原始字节 + Content-Type；返回 `/api/media/<sha256>` 供正文占位。
   *  服务端会做 MIME/魔数校验、>2 MiB 压缩、内容寻址去重——失败一律 reject 人话错误。 */
  uploadMedia: (file: File): Promise<MediaUploadResponse> =>
    req("/api/media", {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    }).then((r) => to<MediaUploadResponse>(r)),

  /** 通知页（007）：kind=notice 的独立查看入口。 */
  notices: (): Promise<NoticeView> => req("/api/notices").then((r) => to<NoticeView>(r)),

  item: (id: string): Promise<GetItemResult> =>
    req(`/api/items/${id}`).then((r) => to<GetItemResult>(r)),

  complete: (id: string): Promise<Item> =>
    req(`/api/items/${id}/complete`, post({})).then((r) => to<Item>(r)),

  /** 恢复待办（D-82）：误标可逆，与 complete 对称。 */
  reopen: (id: string): Promise<Item> =>
    req(`/api/items/${id}/reopen`, post({})).then((r) => to<Item>(r)),

  /** 删除（007 回收站）：追加 trashed 版本——进回收站、可恢复，不物理删。 */
  trash: (id: string): Promise<Item> =>
    req(`/api/items/${id}/trash`, post({})).then((r) => to<Item>(r)),

  /** 从回收站恢复（007）：status 回到删前的值。 */
  restore: (id: string): Promise<Item> =>
    req(`/api/items/${id}/restore`, post({})).then((r) => to<Item>(r)),

  /** 回收站列表（007）：trashed 信息（两类混合，按删时倒序）。 */
  trashList: (): Promise<TrashView> => req("/api/trash").then((r) => to<TrashView>(r)),

  /** 一键清理回收站（007）：物理清除 trashed 超过 15 天的信息；原文档案不动。 */
  purgeTrash: (): Promise<{ purged: number }> =>
    req("/api/trash/purge", post({})).then((r) => to<{ purged: number }>(r)),

  /** 标记事项已查看（「新」微标消除，点开即报；204 无响应体）。 */
  viewed: (id: string): Promise<void> =>
    req(`/api/items/${id}/viewed`, post({})).then((r) => ensureOk(r)),

  /** 前台对话（D-78）：history 为本条消息之前的轮次，客户端持有、服务端无状态；
   *  mentions = 输入框 @ 提及的事项（随请求上传，服务端注入给前台）。 */
  chat: (
    message: string,
    history: ChatHistoryItem[],
    mentions: { id: string; title: string }[] = [],
  ): Promise<ChatResponse> =>
    req("/api/chat", post({ message, history, mentions })).then((r) => to<ChatResponse>(r)),

  /** 失败批次重试（D-71）：仅「未处理」可重试；202 = 已受理重跑。 */
  retryRaw: (id: string): Promise<DigestAck> =>
    req(`/api/raw/${id}/retry`, post({})).then((r) => to<DigestAck>(r)),

  // ── 设置面板（05§五）——备份不走这：直接 <a href="/api/backup"> 让浏览器下载 ──

  /** 读 AI 设置视图（Key 只回掩码）。 */
  aiSettings: (): Promise<AiSettingsView> =>
    req("/api/settings/ai").then((r) => to<AiSettingsView>(r)),

  /** 保存即热切换；apiKey 空 = 沿用现值。（服务端注册的是 PUT——评审 C1：曾误用 POST 打 404） */
  saveAiSettings: (s: AiSettings): Promise<AiSettingsView> =>
    req("/api/settings/ai", put(s)).then((r) => to<AiSettingsView>(r)),

  /** 清除本账户 AI 配置（回「未配置」）。 */
  clearAiSettings: (): Promise<AiSettingsView> =>
    req("/api/settings/ai", { method: "DELETE" }).then((r) => to<AiSettingsView>(r)),

  /** 读用户拒收规则（D-107）：用户自由文本，原样注入 agent0 提示词作硬闸。 */
  rejectionRules: (): Promise<RejectionRulesView> =>
    req("/api/settings/rejection-rules").then((r) => to<RejectionRulesView>(r)),

  /** 存用户拒收规则（整段覆盖；空串 = 清空）。 */
  saveRejectionRules: (rules: string): Promise<RejectionRulesView> =>
    req("/api/settings/rejection-rules", put({ rules })).then((r) => to<RejectionRulesView>(r)),

  /** 测试连接：表单值实测一次最小请求，不动当前客户端。 */
  testAiSettings: (s: AiSettings): Promise<AiTestResult> =>
    req("/api/settings/ai/test", post(s)).then((r) => to<AiTestResult>(r)),

  // ── 信源（D-89 信源区真界面 / 审核页）──

  /** 信源列表 + 运行状态 + 设置 schema（前端按 schema 渲染通用表单，不知道信源名）。 */
  sources: (): Promise<SourceSummary[]> => req("/api/sources").then((r) => to<SourceSummary[]>(r)),

  /** 读某信源的全部设置值（不含 schema）。 */
  sourceSettings: (name: string): Promise<Record<string, unknown>> =>
    req(`/api/sources/${name}/settings`).then((r) => to<Record<string, unknown>>(r)),

  /** 写某信源的单键设置值（任意 JSON；core 不解释内容）。 */
  setSourceSetting: (name: string, key: string, value: unknown): Promise<void> =>
    req(`/api/sources/${name}/settings/${key}`, put(value)).then((r) => ensureOk(r)),

  /** 删某信源的单键设置（回到「未设置」——运行时兜默认值；如窗长清空 = 回默认）。 */
  deleteSourceSetting: (name: string, key: string): Promise<void> =>
    req(`/api/sources/${name}/settings/${key}`, { method: "DELETE" }).then((r) => ensureOk(r)),

  // ── 存疑信息库（D-89 审核页）──

  /** 存疑库列表（默认 open，needsHuman 倒序）。 */
  uncertain: (status: "open" | "merged" | "discarded" = "open"): Promise<UncertainInput[]> =>
    req(`/api/uncertain?status=${status}`).then((r) => to<UncertainInput[]>(r)),

  /** 人工移除一条（D-89）：404=不存在 / 409=已被处置——都算「已不在」，正常 resolve（调用方静默刷新）；
   *  其余非 2xx 抛错（调用方须可见提示——不静默）。 */
  resolveUncertain: (id: string): Promise<void> =>
    req(`/api/uncertain/${id}`, { method: "PUT" }).then((r) => {
      if (r.status === 404 || r.status === 409) return;
      ensureOk(r);
    }),

  // ── 对话历史（D-89 启动回填）──

  /** 最近 N 轮历史（时间升序）；纯文本气泡，chips 不回填（L20）。 */
  chatHistory: (limit = 50): Promise<ChatHistoryResponse> =>
    req(`/api/chat/history?limit=${limit}`).then((r) => to<ChatHistoryResponse>(r)),

  // ── 流水（specs/005 进站台账）──

  /** 进站台账：最近 N 个批次概要（含流水计数与消化结果一句话）。 */
  pipelineRuns: (limit = 50): Promise<{ runs: PipelineRun[] }> =>
    req(`/api/pipeline/runs?limit=${limit}`).then((r) => to<{ runs: PipelineRun[] }>(r)),

  /** 单批详情：原文 + 全部流水事件（视图按单一时间线渲染，最新在上）。 */
  pipelineRun: (id: string): Promise<PipelineRunDetail> =>
    req(`/api/pipeline/runs/${id}`).then((r) => to<PipelineRunDetail>(r)),
};
