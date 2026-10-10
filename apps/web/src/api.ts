import type {
  AiSettings,
  AiSettingsView,
  AiTestResult,
  BoardView,
  ChatHistoryItem,
  ChatHistoryResponse,
  ChatResponse,
  DigestState,
  GetItemResult,
  Item,
  PipelineRun,
  PipelineRunDetail,
  SourceSummary,
  UncertainInput,
} from "@summarizing/shared";

/** 类型化 API 客户端：web 只跟这些函数打交道。 */

/** 统一响应处理：非 2xx 抛错；2xx 返回按泛型标注的 JSON（调用方用 shared 类型标注）。 */
async function to<T>(res: Response): Promise<T> {
  ensureOk(res);
  return (await res.json()) as T;
}

/** 无响应体的写操作守卫：非 2xx 抛错（与 to 同一错误口径）。 */
function ensureOk(res: Response): void {
  if (!res.ok) throw new Error(`请求失败 ${res.status}`);
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
  board: (): Promise<BoardView> => fetch("/api/board").then((r) => to<BoardView>(r)),

  item: (id: string): Promise<GetItemResult> =>
    fetch(`/api/items/${id}`).then((r) => to<GetItemResult>(r)),

  complete: (id: string): Promise<Item> =>
    fetch(`/api/items/${id}/complete`, post({})).then((r) => to<Item>(r)),

  /** 恢复待办（D-82）：误标可逆，与 complete 对称。 */
  reopen: (id: string): Promise<Item> =>
    fetch(`/api/items/${id}/reopen`, post({})).then((r) => to<Item>(r)),

  /** 归档（D-83 最小归档）：todo → archived，进看板归档段；恢复走 reopen。 */
  archive: (id: string): Promise<Item> =>
    fetch(`/api/items/${id}/archive`, post({})).then((r) => to<Item>(r)),

  /** 标记事项已查看（「新」微标消除，点开即报；204 无响应体）。 */
  viewed: (id: string): Promise<void> =>
    fetch(`/api/items/${id}/viewed`, post({})).then((r) => ensureOk(r)),

  /** 前台对话（D-78）：history 为本条消息之前的轮次，客户端持有、服务端无状态；
   *  mentions = 输入框 @ 提及的事项（随请求上传，服务端注入给前台）。 */
  chat: (
    message: string,
    history: ChatHistoryItem[],
    mentions: { id: string; title: string }[] = [],
  ): Promise<ChatResponse> =>
    fetch("/api/chat", post({ message, history, mentions })).then((r) => to<ChatResponse>(r)),

  /** 失败批次重试（D-71）：仅「未处理」可重试；202 = 已受理重跑。 */
  retryRaw: (id: string): Promise<DigestAck> =>
    fetch(`/api/raw/${id}/retry`, post({})).then((r) => to<DigestAck>(r)),

  // ── 设置面板（05§五）——备份不走这：直接 <a href="/api/backup"> 让浏览器下载 ──

  /** 读 AI 设置视图（Key 只回掩码）。 */
  aiSettings: (): Promise<AiSettingsView> =>
    fetch("/api/settings/ai").then((r) => to<AiSettingsView>(r)),

  /** 保存即热切换；apiKey 空 = 沿用现值。（服务端注册的是 PUT——评审 C1：曾误用 POST 打 404） */
  saveAiSettings: (s: AiSettings): Promise<AiSettingsView> =>
    fetch("/api/settings/ai", put(s)).then((r) => to<AiSettingsView>(r)),

  /** 清除覆盖，回 .env。 */
  clearAiSettings: (): Promise<AiSettingsView> =>
    fetch("/api/settings/ai", { method: "DELETE" }).then((r) => to<AiSettingsView>(r)),

  /** 测试连接：表单值实测一次最小请求，不动当前客户端。 */
  testAiSettings: (s: AiSettings): Promise<AiTestResult> =>
    fetch("/api/settings/ai/test", post(s)).then((r) => to<AiTestResult>(r)),

  // ── 信源（D-89 信源区真界面 / 审核页）──

  /** 信源列表 + 运行状态 + 设置 schema（前端按 schema 渲染通用表单，不知道信源名）。 */
  sources: (): Promise<SourceSummary[]> =>
    fetch("/api/sources").then((r) => to<SourceSummary[]>(r)),

  /** 读某信源的全部设置值（不含 schema）。 */
  sourceSettings: (name: string): Promise<Record<string, unknown>> =>
    fetch(`/api/sources/${name}/settings`).then((r) => to<Record<string, unknown>>(r)),

  /** 写某信源的单键设置值（任意 JSON；core 不解释内容）。 */
  setSourceSetting: (name: string, key: string, value: unknown): Promise<void> =>
    fetch(`/api/sources/${name}/settings/${key}`, put(value)).then((r) => ensureOk(r)),

  /** 删某信源的单键设置（回到「未设置」——运行时兜默认值；如窗长清空 = 回默认）。 */
  deleteSourceSetting: (name: string, key: string): Promise<void> =>
    fetch(`/api/sources/${name}/settings/${key}`, { method: "DELETE" }).then((r) => ensureOk(r)),

  // ── 存疑信息库（D-89 审核页）──

  /** 存疑库列表（默认 open，needsHuman 倒序）。 */
  uncertain: (status: "open" | "merged" | "discarded" = "open"): Promise<UncertainInput[]> =>
    fetch(`/api/uncertain?status=${status}`).then((r) => to<UncertainInput[]>(r)),

  /** 人工移除一条（D-89）：404=不存在 / 409=已被处置——都算「已不在」，正常 resolve（调用方静默刷新）；
   *  其余非 2xx 抛错（调用方须可见提示——不静默）。 */
  resolveUncertain: (id: string): Promise<void> =>
    fetch(`/api/uncertain/${id}`, { method: "PUT" }).then((r) => {
      if (r.status === 404 || r.status === 409) return;
      ensureOk(r);
    }),

  // ── 对话历史（D-89 启动回填）──

  /** 最近 N 轮历史（时间升序）；纯文本气泡，chips 不回填（L20）。 */
  chatHistory: (limit = 50): Promise<ChatHistoryResponse> =>
    fetch(`/api/chat/history?limit=${limit}`).then((r) => to<ChatHistoryResponse>(r)),

  // ── 流水（specs/005 进站台账）──

  /** 进站台账：最近 N 个批次概要（含流水计数与消化结果一句话）。 */
  pipelineRuns: (limit = 50): Promise<{ runs: PipelineRun[] }> =>
    fetch(`/api/pipeline/runs?limit=${limit}`).then((r) => to<{ runs: PipelineRun[] }>(r)),

  /** 单批详情：原文 + 全部流水事件（视图按单一时间线渲染，最新在上）。 */
  pipelineRun: (id: string): Promise<PipelineRunDetail> =>
    fetch(`/api/pipeline/runs/${id}`).then((r) => to<PipelineRunDetail>(r)),
};
