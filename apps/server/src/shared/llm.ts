import OpenAI from "openai";

// OpenAI 兼容协议（D-55）：baseURL 指向具体服务商，代码不感知是谁。
// LlmClient 是接口：生产用 makeOpenAiLlm，测试注入 fake（digest.test.ts）。

export type ToolCall = { id: string; name: string; argsJson: string };

export type ChatMsg =
  | { role: "user"; content: string }
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
  }): Promise<{ content: string | null; toolCalls: ToolCall[] }>;
}

/** 带模型标识的 LLM 客户端：热切换后路由逐请求取 llmRef.current，modelTag 进 agent0: 署名永不说谎。 */
export type TaggedLlm = LlmClient & { readonly modelTag: string };

/** 由设置表单值合成 env（.env 做底，表单非空字段覆盖）——设置路由与启动种子共用（05§五）。 */
export function envFromAiSettings(
  s: { baseUrl: string; model: string; apiKey?: string },
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    OPENAI_BASE_URL: s.baseUrl,
    OPENAI_MODEL: s.model,
    ...(s.apiKey !== undefined && s.apiKey !== "" ? { OPENAI_API_KEY: s.apiKey } : {}),
  };
}

/** 生产 LLM 客户端：OpenAI 兼容协议（D-55），baseURL/model 来自 .env 或设置的合成 env；缺配置直接抛错不静默。 */
export function makeOpenAiLlm(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 60_000, // 测试连接传短超时（15s），日常消化保持长超时防网关挂起
): TaggedLlm {
  const baseURL = env.OPENAI_BASE_URL;
  const model = env.OPENAI_MODEL;
  if (!baseURL || !model) {
    // 「无数据」不得静默当作已配置（01§8.3）
    throw new Error("缺少 OPENAI_BASE_URL / OPENAI_MODEL，请参照 .env.example 配置 .env");
  }
  const client = new OpenAI({
    baseURL,
    apiKey: env.OPENAI_API_KEY || "not-needed",
    // 网关挂起（非拒绝）会永久阻塞请求——超时让它变成可捕获的失败
    timeout: timeoutMs,
    maxRetries: 1,
  });
  return {
    modelTag: model,
    async chat({ system, messages, tools }) {
      const res = await client.chat.completions.create({
        model,
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
      return { content: msg?.content ?? null, toolCalls };
    },
  };
}

/** 内部消息格式 → OpenAI SDK 消息格式（含工具调用的双向转换）。 */
function toOpenAiMessage(msg: ChatMsg): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (msg.role) {
    case "user":
      return { role: "user", content: msg.content };
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
