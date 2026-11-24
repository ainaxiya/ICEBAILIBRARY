import { describe, it, expect } from "vitest";
import { toAnthropicRequest, buildAnthropicBody, anthropicToOpenAI } from "@/lib/gateway/adapters/anthropic";
import { toGeminiRequest, buildGeminiBody, geminiToOpenAI, contentToTextGemini } from "@/lib/gateway/adapters/gemini";
import { geminiEmbedToOpenAI } from "@/lib/gateway/adapters/embeddings";
import { checkChatParams, parseCapabilities } from "@/lib/gateway/capabilities";

// ─── P4 协议转换纯函数单测（不依赖 DB/网络） ───

describe("Anthropic 请求转换", () => {
  it("system 消息提取为顶层 system；其余映射 messages", () => {
    const r = toAnthropicRequest({
      messages: [
        { role: "system", content: "be nice" },
        { role: "developer", content: "be kind" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "how are you" },
      ],
    });
    expect(r.system).toBe("be nice\nbe kind");
    expect(r.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "text", text: "how are you" }] },
    ]);
  });

  it("连续同角色合并（Anthropic 要求 user/assistant 交替）", () => {
    const r = toAnthropicRequest({
      messages: [
        { role: "user", content: "a" },
        { role: "user", content: [{ type: "text", text: "b" }] },
      ],
    });
    expect(r.messages.length).toBe(1);
    expect(r.messages[0].role).toBe("user");
    expect(r.messages[0].content).toEqual([{ type: "text", text: "a" }, { type: "text", text: "b" }]);
  });

  it("assistant.tool_calls → tool_use 块；tool 角色消息 → user + tool_result", () => {
    const r = toAnthropicRequest({
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"BJ"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"temp":25}' },
      ],
    });
    expect(r.messages[1].content).toContainEqual({ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "BJ" } });
    // tool 结果合并进 user 消息（与 assistant 相邻后取反角色）
    expect(r.messages[2].role).toBe("user");
    expect(r.messages[2].content).toContainEqual({ type: "tool_result", tool_use_id: "call_1", content: '{"temp":25}' });
  });

  it("buildAnthropicBody：max_tokens 兜底 4096 / stop → stop_sequences / tools / tool_choice", () => {
    const b = buildAnthropicBody({
      messages: [{ role: "user", content: "hi" }],
      stop: "END",
      temperature: 0.7,
      top_p: 0.9,
      tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
      tool_choice: "required",
    });
    expect(b.max_tokens).toBe(4096);
    expect(b.stop_sequences).toEqual(["END"]);
    expect(b.temperature).toBe(0.7);
    expect(b.top_p).toBe(0.9);
    expect(b.tools).toEqual([{ name: "f", description: "d", input_schema: { type: "object" } }]);
    expect(b.tool_choice).toEqual({ type: "any" });

    const b2 = buildAnthropicBody({ messages: [{ role: "user", content: "hi" }], max_tokens: 100, tools: [{ type: "function", function: { name: "f", parameters: {} } }], tool_choice: { type: "function", function: { name: "f" } } });
    expect(b2.max_tokens).toBe(100);
    expect(b2.tool_choice).toEqual({ type: "tool", name: "f" });
  });
});

describe("Anthropic 响应转换", () => {
  it("content 块聚合 text + tool_use → tool_calls；stop_reason 映射；usage 透传", () => {
    const out = anthropicToOpenAI(
      {
        id: "msg_1",
        content: [
          { type: "text", text: "think " },
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "BJ" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 11, output_tokens: 7 },
      },
      "claude-test"
    );
    expect(out.object).toBe("chat.completion");
    expect(out.model).toBe("claude-test");
    const choice = (out.choices as { index: number; message: Record<string, unknown>; finish_reason: string }[])[0];
    expect(choice.message.content).toBe("think ");
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"BJ"}' } }]);
    expect(out.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });

    expect(anthropicToOpenAI({ stop_reason: "max_tokens", content: [] }, "m").choices[0].finish_reason).toBe("length");
    expect(anthropicToOpenAI({ stop_reason: "end_turn", content: [] }, "m").choices[0].finish_reason).toBe("stop");
  });
});

describe("Gemini 请求转换", () => {
  it("system → systemInstruction.parts；assistant → model；tool → functionResponse", () => {
    const r = toGeminiRequest({
      messages: [
        { role: "system", content: "sys prompt" },
        { role: "user", content: "weather?" },
        { role: "assistant", content: "checking", tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"BJ"}' } }] },
        { role: "tool", tool_call_id: "c1", name: "get_weather", content: '{"temp":25}' },
      ],
    });
    expect(r.systemInstruction).toEqual([{ text: "sys prompt" }]);
    expect(r.contents[0]).toEqual({ role: "user", parts: [{ text: "weather?" }] });
    expect(r.contents[1].role).toBe("model");
    expect(r.contents[1].parts).toContainEqual({ text: "checking" });
    expect(r.contents[1].parts).toContainEqual({ functionCall: { name: "get_weather", args: { city: "BJ" } } });
    // tool 结果与相邻 model 消息合并成 user
    expect(r.contents[2].role).toBe("user");
    expect(r.contents[2].parts).toContainEqual({ functionResponse: { name: "get_weather", response: { temp: 25 } } });
  });

  it("buildGeminiBody：generationConfig 映射 + response_format + tools", () => {
    const { payload } = buildGeminiBody({
      model: "gemini-test",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 128,
      temperature: 0.5,
      top_p: 0.8,
      stop: ["END1", "END2"],
      response_format: { type: "json_object" },
      tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
      tool_choice: "auto",
    });
    expect(payload.generationConfig).toEqual({ temperature: 0.5, topP: 0.8, maxOutputTokens: 128, stopSequences: ["END1", "END2"], responseMimeType: "application/json" });
    expect(payload.tools).toEqual([{ functionDeclarations: [{ name: "f", description: "d", parameters: { type: "object" } }] }]);
    expect(payload.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(payload.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("contentToTextGemini：字符串与 parts 数组均取文本", () => {
    expect(contentToTextGemini("plain")).toBe("plain");
    expect(contentToTextGemini([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });
});

describe("Gemini 响应转换", () => {
  it("parts.text 聚合 + functionCall → tool_calls + finishReason/usage 映射", () => {
    const out = geminiToOpenAI(
      {
        candidates: [
          {
            content: { parts: [{ text: "part1" }, { text: "part2" }, { functionCall: { name: "f", args: { a: 1 } } }] },
            finishReason: "MAX_TOKENS",
          },
        ],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
      },
      "gemini-test"
    );
    const choice = (out.choices as { message: Record<string, unknown>; finish_reason: string }[])[0];
    expect(choice.message.content).toBe("part1part2");
    expect(choice.finish_reason).toBe("length");
    expect(choice.message.tool_calls).toEqual([{ id: "call_0", type: "function", function: { name: "f", arguments: '{"a":1}' } }]);
    expect(out.usage).toEqual({ prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 });
  });
});

describe("Gemini embeddings 响应转换", () => {
  it("embeddings[].values → OpenAI list 形状", () => {
    const out = geminiEmbedToOpenAI({ embeddings: [{ values: [1, 2] }, { values: [3, 4] }] }, "embed-gtest", 12);
    expect(out.object).toBe("list");
    expect(out.model).toBe("embed-gtest");
    expect(out.data).toEqual([
      { object: "embedding", index: 0, embedding: [1, 2] },
      { object: "embedding", index: 1, embedding: [3, 4] },
    ]);
    expect(out.usage).toEqual({ prompt_tokens: 12, total_tokens: 12 });
  });
});

describe("#17 能力协商", () => {
  it("parseCapabilities：null/字符串/对象", () => {
    expect(parseCapabilities(null)).toBe(null);
    expect(parseCapabilities(undefined)).toBe(null);
    expect(parseCapabilities('{"params":["temperature"]}')).toEqual({ params: ["temperature"] });
    expect(parseCapabilities({ params: ["stop"] })).toEqual({ params: ["stop"] });
    expect(parseCapabilities("not-json")).toBe(null);
  });

  it("未配置 capabilities → 全透传", () => {
    expect(checkChatParams(null, { model: "m", messages: [], foo: 1 })).toEqual({ ok: true });
    expect(checkChatParams({}, { model: "m", messages: [], foo: 1 })).toEqual({ ok: true });
    expect(checkChatParams({ params: [] }, { model: "m", messages: [] })).toEqual({ ok: true });
  });

  it("白名单内参数通过；核心参数 model/messages/stream 不参与校验", () => {
    const caps = { params: ["temperature", "max_tokens"] };
    expect(checkChatParams(caps, { model: "m", messages: [], stream: true, temperature: 1, max_tokens: 10 })).toEqual({ ok: true });
  });

  it("白名单外参数 → 全部指名（不只第一个）", () => {
    const caps = { params: ["temperature"] };
    const r = checkChatParams(caps, { model: "m", messages: [], logit_bias: {}, frequency_penalty: 1, seed: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unsupported.sort()).toEqual(["frequency_penalty", "logit_bias", "seed"]);
  });
});
