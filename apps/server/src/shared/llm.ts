import OpenAI from "openai";
import { z } from "zod";
import type { AiSettings } from "@summarizing/shared";

// OpenAI 兼容协议（D-55）：baseURL 指向具体服务商，代码不感知是谁。
// LlmClient 是接口：生产用 makeOpenAiLlm，测试注入 fake（digest.test.ts）。

export type ToolCall = { id: string; name: string; argsJson: string };

/** 一次调用的 token 用量（010）。cachedTokens = null ⇔ 服务商没给缓存字段——与「命中 0」不同义。 */
export type LlmUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
};

/** 用户消息的内容块（多模态）：文本 + 图片（data URL 或直链）——OpenAI 兼容协议的通用子集。
 *  图片走 user 消息而非 tool 消息：协议的 tool 结果只能放文本（fetch_image 的注入路径，digest.ts）。 */
type ChatContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMsg =
  | { role: "user"; content: string | ChatContentPart[] }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

export type ToolDef = {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
};

export interface LlmClient {
  chat(args: {
    system: string;
    messages: ChatMsg[];
    tools: ToolDef[];
  }): Promise<{ content: string | null; toolCalls: ToolCall[]; usage: LlmUsage | null }>;
}

/** 带模型标识的 LLM 客户端：热切换后路由逐请求取 llmRef.current，modelTag 进 agent0: 署名永不说谎。 */
export type TaggedLlm = LlmClient & { readonly modelTag: string };

/** 生产 LLM 客户端：OpenAI 兼容协议（D-55）。配置用 shared 的 **AiSettings**（单一来源；已过 zod）。
 *  **必须显式传入**（不再读 .env——多用户下 .env 兜底 = 全站共享一把 key，已废；006 用户走查）。
 *  缺 baseUrl/model 直接抛错不静默。 */
export function makeOpenAiLlm(
  config: AiSettings,
  timeoutMs = 60_000, // 测试连接传短超时（15s），日常消化保持长超时防网关挂起
): TaggedLlm {
  if (config.baseUrl === "" || config.model === "") {
    // 「无数据」不得静默当作已配置（01§8.3）
    throw new Error("AI 接入未配置：请填 Base URL 与模型（设置 → AI）");
  }
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey !== undefined && config.apiKey !== "" ? config.apiKey : "not-needed",
    // 网关挂起（非拒绝）会永久阻塞请求——超时让它变成可捕获的失败
    timeout: timeoutMs,
    maxRetries: 1,
  });
  return {
    modelTag: config.model,
    async chat({ system, messages, tools }) {
      const res = await client.chat.completions.create({
        model: config.model,
        // 部分兼容网关默认 max_tokens 很小，会把 JSON 截断在半截（实测发生过）
        max_tokens: 4000,
        messages: [{ role: "system", content: system }, ...messages.map(toOpenAiMessage)],
        tools: tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parametersJsonSchema,
          },
        })),
      });
      const msg = res.choices[0]?.message;
      const toolCalls = (msg?.tool_calls ?? []).flatMap((tc) => {
        if (tc.type !== "function") return [];
        return [
          {
            id: tc.id,
            name: tc.function.name,
            argsJson: tc.function.arguments,
          },
        ];
      });
      return { content: msg?.content ?? null, toolCalls, usage: parseUsage(res.usage) };
    },
  };
}

/** 未配置占位客户端（006）：构造**不抛**——服务照常启动、界面可用（FR-009「未配置 = 明确提示」；
 *  多用户下未配 key 是常态而非异常）；真正发起调用时才报人话错（消化把批次标「未处理」）。 */
export function makeUnconfiguredLlm(): TaggedLlm {
  return {
    modelTag: "未配置",
    async chat() {
      throw new Error("尚未配置 AI 接入——去 设置 → AI 填 Base URL / 模型 / Key");
    },
  };
}

/** 服务商返回的 usage 的**运行时**形状（zod 解析，不用类型断言——见 CLAUDE.md 类型绕过禁令）。
 *  OpenAI 标准字段 + DeepSeek 等的兼容字段 `prompt_cache_hit_tokens` 都在内。
 *  0 是合法值；负数/小数/字符串由 zod 判失败 → 整条 usage 作废（统计要真数，不猜）。 */
const RawUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens_details: z
    .object({ cached_tokens: z.number().int().nonnegative().optional() })
    .optional(),
});

/** 从服务商返回的 usage 里取三件事（010）：输入 / 输出 / 缓存命中。
 *  缺失或形状不符 → null（= 未提供）并 stderr 留痕——界面照实说「服务商未提供」，不拿 0 冒充。
 *  缓存命中优先 OpenAI 标准字段 `prompt_tokens_details.cached_tokens`，兼容 `prompt_cache_hit_tokens`。 */
function parseUsage(raw: unknown): LlmUsage | null {
  if (raw === undefined || raw === null) return null;
  const parsed = RawUsageSchema.safeParse(raw);
  if (!parsed.success) {
    process.stderr.write(
      `[llm] usage 形状不可用，按未提供处理：${JSON.stringify(raw).slice(0, 200)}\n`,
    );
    return null;
  }
  const { prompt_tokens, completion_tokens, prompt_tokens_details, prompt_cache_hit_tokens } =
    parsed.data;
  const cachedTokens = prompt_tokens_details?.cached_tokens ?? prompt_cache_hit_tokens ?? null;
  return { promptTokens: prompt_tokens, completionTokens: completion_tokens, cachedTokens };
}

/** 内部消息格式 → OpenAI SDK 消息格式（含工具调用的双向转换；多模态内容块逐块重建，
 *  让 SDK 联合类型自行校验形状，不做类型绕过）。 */
function toOpenAiMessage(msg: ChatMsg): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (msg.role) {
    case "user":
      if (typeof msg.content === "string") {
        return { role: "user", content: msg.content };
      }
      return {
        role: "user",
        content: msg.content.map((part) =>
          part.type === "text"
            ? { type: "text" as const, text: part.text }
            : { type: "image_url" as const, image_url: { url: part.image_url.url } },
        ),
      };
    case "assistant":
      return {
        role: "assistant",
        content: msg.content,
        ...(msg.toolCalls
          ? {
              tool_calls: msg.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.argsJson },
              })),
            }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: msg.toolCallId, content: msg.content };
  }
}
