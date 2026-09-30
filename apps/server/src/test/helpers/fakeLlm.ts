import type { TaggedLlm, ChatMsg, ToolCall, ToolDef } from "../../shared/llm";

// 测试专用 fake LLM（digest.test.ts / chat.test.ts 共用）：
// 按脚本逐轮回放；队列空 = 模拟 LLM 调用失败。
// 默认 modelTag 与测试文件的 MODEL 常量一致——审计署名（agent0:test-model）断言零扰动。

export type Turn = { content: string | null; toolCalls?: ToolCall[] };
export type ChatArgs = { system: string; messages: ChatMsg[]; tools: ToolDef[] };

export class FakeLlm implements TaggedLlm {
  private queue: Turn[] = [];
  readonly chats: ChatArgs[] = [];
  readonly modelTag: string;

  constructor(modelTag = "test-model") {
    this.modelTag = modelTag;
  }

  push(turn: Turn): void {
    this.queue.push(turn);
  }

  async chat(args: ChatArgs) {
    // 存深快照而非引用：messages 数组会被调用方在工具循环里继续 push，存引用会「事后变形」。
    // ⚠️ 单队列不变量：多消费者（前台循环 + 异步 digest）隐式分食同一队列，轮次归属
    // 依赖 chat 同步 shift——给 chat 加任何 await 延迟都会改变消费顺序
    this.chats.push(structuredClone(args));
    const turn = this.queue.shift();
    if (!turn) throw new Error("FakeLlm 队列已空（模拟 LLM 调用失败）");
    return { content: turn.content, toolCalls: turn.toolCalls ?? [] };
  }
}

/** 取第 i 次 LLM 调用的参数快照；不存在就抛错（让测试显式失败而不是 undefined 断言）。 */
export function chatAt(llm: FakeLlm, i: number): ChatArgs {
  const args = llm.chats[i];
  if (!args) throw new Error(`FakeLlm 第 ${i} 次调用不存在`);
  return args;
}
