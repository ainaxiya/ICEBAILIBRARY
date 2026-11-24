// ─── P4 多协议：Anthropic Messages adapter ───
// 客户端仍以 OpenAI 兼容格式调用 /v1/chat/completions，网关按 vendor.protocol 分发：
// 请求 OpenAI → Anthropic 转换（system 提取为顶层 system、max_tokens 必填兜底 4096、
//   stop → stop_sequences、tool_calls ↔ tool_use/tool_result）；
// 响应 Anthropic → OpenAI 形状（非流式 JSON / SSE 流均在 adapter 内转换），
// 下游路由的 usage 旁路结算逻辑不变。

import { isClientAbort, type OpenAIChatResult, type UsageInfo } from "./openai";
import { estimateTokens, transformSseToOpenAI, upstreamErrorOf } from "./sse";

const UPSTREAM_TIMEOUT_MS = 300000;
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

function baseOf(apiBase: string): string {
  return apiBase.replace(/\/+$/, "");
}

// ─── 请求转换（纯函数，单测覆盖） ───

interface AnthropicBlock {
  type: string;
  [k: string]: unknown;
}

// OpenAI content（string | parts 数组）→ Anthropic 文本（system 提取用）
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "object" && p !== null && (p as { type?: string }).type === "text" ? String((p as { text?: string }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// OpenAI image_url part → Anthropic image block（base64 data URL / http url）
function imageBlock(url: string): AnthropicBlock | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
  if (/^https?:\/\//.test(url)) return { type: "image", source: { type: "url", url } };
  return null;
}

// OpenAI content → Anthropic content blocks（string → [{type:"text"}]，保持块语义）
function contentToBlocks(content: unknown): AnthropicBlock[] | string {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: AnthropicBlock[] = [];
  for (const p of content) {
    if (typeof p !== "object" || p === null) continue;
    const part = p as { type?: string; text?: string; image_url?: { url?: string } };
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url" && part.image_url?.url) {
      const img = imageBlock(part.image_url.url);
      if (img) blocks.push(img);
    }
  }
  return blocks;
}

// OpenAI messages → Anthropic {system, messages}（同角色合并；tool → tool_result 块）
export function toAnthropicRequest(body: Record<string, unknown>): {
  system: string;
  messages: { role: "user" | "assistant"; content: AnthropicBlock[] }[];
  maxTokens: number;
} {
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const system: string[] = [];
  // 先展开为带角色标签的块序列（tool 角色转 user + tool_result）
  const seq: { role: "user" | "assistant"; blocks: AnthropicBlock[] }[] = [];
  for (const m of rawMessages) {
    if (typeof m !== "object" || m === null) continue;
    const msg = m as { role?: string; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown };
    const role = msg.role;
    if (role === "system" || role === "developer") {
      const t = contentToText(msg.content);
      if (t) system.push(t);
      continue;
    }
    if (role === "tool") {
      seq.push({
        role: "user",
        blocks: [{ type: "tool_result", tool_use_id: String(msg.tool_call_id ?? ""), content: contentToText(msg.content) }],
      });
      continue;
    }
    const asRole: "user" | "assistant" = role === "assistant" ? "assistant" : "user";
    const blocks: AnthropicBlock[] = [];
    const converted = contentToBlocks(msg.content);
    if (Array.isArray(converted)) blocks.push(...converted);
    // assistant.tool_calls → tool_use 块
    if (role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (typeof tc !== "object" || tc === null) continue;
        const call = tc as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
        let input: unknown = {};
        try {
          input = JSON.parse(String(call.function?.arguments ?? "{}")) || {};
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: String(call.id ?? ""), name: String(call.function?.name ?? ""), input });
      }
    }
    seq.push({ role: asRole, blocks });
  }
  // 合并连续同角色（Anthropic 要求 user/assistant 交替）
  const messages: { role: "user" | "assistant"; content: AnthropicBlock[] }[] = [];
  for (const item of seq) {
    const last = messages[messages.length - 1];
    if (last && last.role === item.role) last.content.push(...item.blocks);
    else messages.push({ role: item.role, content: item.blocks });
  }
  const maxTokens = typeof body.max_tokens === "number" && body.max_tokens > 0 ? Math.floor(body.max_tokens) : DEFAULT_MAX_TOKENS;
  return { system: system.join("\n"), messages, maxTokens };
}

// OpenAI body → 完整 Anthropic 请求体（tools/stop/采样参数）
export function buildAnthropicBody(body: Record<string, unknown>): Record<string, unknown> {
  const { system, messages, maxTokens } = toAnthropicRequest(body);
  const out: Record<string, unknown> = { messages, max_tokens: maxTokens };
  if (system) out.system = system;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (body.stop !== undefined) out.stop_sequences = Array.isArray(body.stop) ? body.stop.map(String) : [String(body.stop)];

  // tools：OpenAI function 定义 → Anthropic input_schema
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = (body.tools as { type?: string; function?: { name?: string; description?: string; parameters?: unknown } }[])
      .filter((t) => t?.type === "function" && t.function?.name)
      .map((t) => ({
        name: t.function!.name!,
        ...(t.function!.description ? { description: t.function!.description } : {}),
        input_schema: t.function!.parameters ?? { type: "object", properties: {} },
      }));
    if (tools.length > 0) out.tools = tools;
    // tool_choice 映射：auto→auto / required→any / 指名→tool；none → 不带 tools
    const choice = body.tool_choice as string | { type?: string; function?: { name?: string } } | undefined;
    if (choice === "auto") out.tool_choice = { type: "auto" };
    else if (choice === "required") out.tool_choice = { type: "any" };
    else if (typeof choice === "object" && choice?.type === "function" && choice.function?.name) {
      out.tool_choice = { type: "tool", name: choice.function.name };
    }
  }
  return out;
}

// ─── 响应转换（纯函数，单测覆盖） ───

interface AnthropicResponse {
  id?: string;
  content?: { type?: string; text?: string; id?: string; name?: string; input?: unknown }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function mapStopReason(reason: string | undefined): string {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "refusal") return "content_filter";
  return "stop"; // end_turn / stop_sequence / 其他
}

// Anthropic 响应 → OpenAI chat.completion 形状
export function anthropicToOpenAI(j: AnthropicResponse, model: string): Record<string, unknown> {
  let text = "";
  const toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
  for (const block of Array.isArray(j.content) ? j.content : []) {
    if (block?.type === "text" && typeof block.text === "string") text += block.text;
    else if (block?.type === "tool_use") {
      toolCalls.push({
        id: String(block.id ?? ""),
        type: "function",
        function: { name: String(block.name ?? ""), arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content: text || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: `chatcmpl-${j.id ?? "anthropic"}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: mapStopReason(j.stop_reason) }],
    usage: {
      prompt_tokens: Number(j.usage?.input_tokens) || 0,
      completion_tokens: Number(j.usage?.output_tokens) || 0,
      total_tokens: (Number(j.usage?.input_tokens) || 0) + (Number(j.usage?.output_tokens) || 0),
    },
  };
}

// ─── SSE 转换 ───

// Anthropic 事件流 → OpenAI chunk 流（usage 旁路：message_start 带输入、message_delta 带输出）
export function anthropicSseToOpenAI(
  upstream: ReadableStream<Uint8Array>,
  usageRef: { current: UsageInfo | null },
  model: string,
  estPrompt: number
): ReadableStream<Uint8Array> {
  let promptTokens: number | null = null;
  let sawOutputUsage = false;
  let stopReason: string | undefined;
  let outChars = 0;
  let blockTypeByIndex = new Map<number, string>();

  const chunkBase = () => ({
    id: `chatcmpl-anthropic-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  });

  return transformSseToOpenAI(upstream, (payload) => {
    const j = JSON.parse(payload) as {
      type?: string;
      index?: number;
      message?: { id?: string; usage?: { input_tokens?: number } };
      content_block?: { type?: string; id?: string; name?: string };
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
      usage?: { output_tokens?: number };
      error?: { message?: string };
    };

    switch (j.type) {
      case "message_start": {
        promptTokens = Number(j.message?.usage?.input_tokens) || null;
        usageRef.current = { promptTokens: promptTokens ?? estPrompt, completionTokens: 0 };
        return { ...chunkBase(), choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] };
      }
      case "content_block_start": {
        const idx = Number(j.index) || 0;
        const type = j.content_block?.type ?? "text";
        blockTypeByIndex.set(idx, type);
        if (type === "tool_use") {
          return {
            ...chunkBase(),
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: idx, id: j.content_block?.id ?? "", type: "function", function: { name: j.content_block?.name ?? "", arguments: "" } }] },
                finish_reason: null,
              },
            ],
          };
        }
        return null;
      }
      case "content_block_delta": {
        const idx = Number(j.index) || 0;
        if (j.delta?.type === "text_delta" && typeof j.delta.text === "string") {
          outChars += j.delta.text.length;
          if (!sawOutputUsage && usageRef.current) {
            usageRef.current = { promptTokens: promptTokens ?? estPrompt, completionTokens: Math.ceil(outChars / 4) };
          }
          return { ...chunkBase(), choices: [{ index: 0, delta: { content: j.delta.text }, finish_reason: null }] };
        }
        if (j.delta?.type === "input_json_delta" && typeof j.delta.partial_json === "string") {
          return {
            ...chunkBase(),
            choices: [
              { index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: j.delta.partial_json } }] }, finish_reason: null },
            ],
          };
        }
        return null;
      }
      case "message_delta": {
        stopReason = j.delta?.stop_reason;
        if (j.usage?.output_tokens != null) {
          sawOutputUsage = true;
          usageRef.current = { promptTokens: promptTokens ?? estPrompt, completionTokens: Number(j.usage.output_tokens) || 0 };
        }
        return {
          ...chunkBase(),
          choices: [{ index: 0, delta: {}, finish_reason: mapStopReason(stopReason) }],
        };
      }
      case "message_stop": {
        // 最终 usage 帧（OpenAI stream_options.include_usage 惯例：choices 为空数组）
        const usage = usageRef.current ?? { promptTokens: promptTokens ?? estPrompt, completionTokens: Math.ceil(outChars / 4) };
        usageRef.current = usage;
        return { ...chunkBase(), choices: [], usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.promptTokens + usage.completionTokens } };
      }
      default:
        return null; // ping / content_block_stop / error 等不下发
    }
  });
}

// ─── adapter 主入口（与 openai.callChatCompletions 同形） ───

export async function callAnthropicChat(opts: {
  apiBase: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<OpenAIChatResult> {
  const usageRef: { current: UsageInfo | null } = { current: null };
  const stream = opts.body.stream === true;
  const model = String(opts.body.model ?? "");

  const upstreamBody = buildAnthropicBody(opts.body);
  if (stream) upstreamBody.stream = true;

  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const fetchSignal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;

  let upstream: Response;
  try {
    upstream = await fetch(`${baseOf(opts.apiBase)}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(upstreamBody),
      signal: fetchSignal,
    });
  } catch (e) {
    const aborted = isClientAbort(e, opts.signal, timeoutSignal, "adapters/anthropic.callAnthropicChat");
    const msg = aborted
      ? "客户端已断开"
      : (e as Error).name === "TimeoutError"
        ? "上游响应超时"
        : (e as Error).message;
    return { ok: false, status: 0, usageRef, errorMessage: msg, aborted };
  }

  if (!upstream.ok) {
    return {
      ok: false,
      status: upstream.status,
      usageRef,
      errorMessage: await upstreamErrorOf(upstream, (j) => String((j.error as { message?: unknown } | undefined)?.message ?? "")),
    };
  }

  const estPrompt = estimateTokens(JSON.stringify(opts.body.messages ?? ""));

  // 非流式：整包解析并转换为 OpenAI 形状
  if (!stream) {
    const json = await upstream.json().catch(() => null);
    if (!json) {
      return { ok: false, status: upstream.status, usageRef, errorMessage: "上游响应无法解析" };
    }
    const j = json as AnthropicResponse;
    usageRef.current = {
      promptTokens: Number(j.usage?.input_tokens) || estPrompt,
      completionTokens: Number(j.usage?.output_tokens) || 0,
    };
    return { ok: true, status: upstream.status, json: anthropicToOpenAI(j, model), usageRef };
  }

  // 流式：Anthropic SSE → OpenAI SSE 转换
  if (!upstream.body) {
    return { ok: false, status: upstream.status, usageRef, errorMessage: "上游未返回流式响应" };
  }
  return {
    ok: true,
    status: upstream.status,
    stream: anthropicSseToOpenAI(upstream.body, usageRef, model, estPrompt),
    usageRef,
  };
}
