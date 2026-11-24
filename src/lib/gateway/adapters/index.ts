// ─── P4 多协议：chat adapter 协议分发 ───
// 按 vendor.protocol（openai | anthropic | gemini）选择 adapter，
// 所有 adapter 输出统一的 OpenAIChatResult（非流式 JSON / OpenAI 兼容 SSE 流），
// 下游路由的结算/透传逻辑与协议无关。

import { callAnthropicChat } from "./anthropic";
import { callChatCompletions, type OpenAIChatResult } from "./openai";
import { callGeminiChat } from "./gemini";

export type { OpenAIChatResult };

export async function callChatForProtocol(opts: {
  protocol: string;
  apiBase: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<OpenAIChatResult> {
  switch (opts.protocol) {
    case "anthropic":
      return callAnthropicChat(opts);
    case "gemini":
      return callGeminiChat(opts);
    default:
      return callChatCompletions(opts); // openai / 未知协议一律走 OpenAI 兼容
  }
}
