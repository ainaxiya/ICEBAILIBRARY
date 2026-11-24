// ─── P4 多协议：Gemini GenerativeLanguage adapter ───
// OpenAI 兼容请求 → Gemini contents/systemInstruction/generationConfig 转换，
// 端点 :generateContent（非流式）/ :streamGenerateContent?alt=sse（流式）；
// 响应（含 SSE）转回 OpenAI 形状，下游路由 usage 旁路结算逻辑不变。

import { isClientAbort, type OpenAIChatResult, type UsageInfo } from "./openai";
import { estimateTokens, transformSseToOpenAI, upstreamErrorOf } from "./sse";

const UPSTREAM_TIMEOUT_MS = 300000;

function baseOf(apiBase: string): string {
  return apiBase.replace(/\/+$/, "");
}

// ─── 请求转换（纯函数，单测覆盖） ───

interface GeminiPart {
  [k: string]: unknown;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

// OpenAI content（string | parts 数组）→ Gemini 文本（systemInstruction 用）
export function contentToTextGemini(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "object" && p !== null && (p as { type?: string }).type === "text" ? String((p as { text?: string }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// OpenAI image_url part → Gemini inline_data（base64 data URL；http url 不支持内联，跳过）
function inlineDataPart(url: string): GeminiPart | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (!m) return null; // Gemini 原生 REST 不收远程 URL 图片（file API 超范围），跳过
  return { inline_data: { mime_type: m[1], data: m[2] } };
}

// OpenAI content → Gemini parts
function contentToParts(content: unknown): GeminiPart[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: GeminiPart[] = [];
  for (const p of content) {
    if (typeof p !== "object" || p === null) continue;
    const part = p as { type?: string; text?: string; image_url?: { url?: string } };
    if (part.type === "text" && typeof part.text === "string") parts.push({ text: part.text });
    else if (part.type === "image_url" && part.image_url?.url) {
      const img = inlineDataPart(part.image_url.url);
      if (img) parts.push(img);
    }
  }
  return parts;
}

// OpenAI messages → Gemini {systemInstruction, contents}（tool ↔ functionCall/functionResponse）
export function toGeminiRequest(body: Record<string, unknown>): {
  systemInstruction: GeminiPart[] | null;
  contents: GeminiContent[];
} {
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const system: string[] = [];
  const seq: { role: "user" | "model"; parts: GeminiPart[] }[] = [];
  for (const m of rawMessages) {
    if (typeof m !== "object" || m === null) continue;
    const msg = m as { role?: string; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown; name?: unknown };
    const role = msg.role;
    if (role === "system" || role === "developer") {
      const t = contentToTextGemini(msg.content);
      if (t) system.push(t);
      continue;
    }
    if (role === "tool") {
      // 工具结果 → user + functionResponse（name 取自消息 name；缺省用 tool_call_id 兜底）
      const name = String(msg.name ?? msg.tool_call_id ?? "function");
      let result: unknown = {};
      const text = contentToTextGemini(msg.content);
      try {
        result = JSON.parse(text) || { result: text };
      } catch {
        result = { result: text };
      }
      seq.push({ role: "user", parts: [{ functionResponse: { name, response: result as Record<string, unknown> } }] });
      continue;
    }
    const asRole: "user" | "model" = role === "assistant" ? "model" : "user";
    const parts = contentToParts(msg.content);
    // assistant.tool_calls → functionCall parts
    if (role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (typeof tc !== "object" || tc === null) continue;
        const call = tc as { function?: { name?: unknown; arguments?: unknown } };
        let args: unknown = {};
        try {
          args = JSON.parse(String(call.function?.arguments ?? "{}")) || {};
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: String(call.function?.name ?? ""), args: args as Record<string, unknown> } });
      }
    }
    if (parts.length > 0) seq.push({ role: asRole, parts });
  }
  // 合并连续同角色（Gemini 要求 user/model 交替）
  const contents: GeminiContent[] = [];
  for (const item of seq) {
    const last = contents[contents.length - 1];
    if (last && last.role === item.role) last.parts.push(...item.parts);
    else contents.push({ role: item.role, parts: item.parts });
  }
  return { systemInstruction: system.length > 0 ? [{ text: system.join("\n") }] : null, contents };
}

// OpenAI body → 完整 Gemini 请求体
export function buildGeminiBody(body: Record<string, unknown>): { urlModel: string; payload: Record<string, unknown> } {
  const { systemInstruction, contents } = toGeminiRequest(body);
  const generationConfig: Record<string, unknown> = {};
  if (typeof body.temperature === "number") generationConfig.temperature = body.temperature;
  if (typeof body.top_p === "number") generationConfig.topP = body.top_p;
  if (typeof body.max_tokens === "number" && body.max_tokens > 0) generationConfig.maxOutputTokens = Math.floor(body.max_tokens);
  if (body.stop !== undefined) generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop.map(String) : [String(body.stop)];
  // response_format: json_object → responseMimeType
  const rf = body.response_format as { type?: string } | undefined;
  if (rf?.type === "json_object") generationConfig.responseMimeType = "application/json";

  const payload: Record<string, unknown> = { contents };
  if (systemInstruction) payload.systemInstruction = { parts: systemInstruction };
  if (Object.keys(generationConfig).length > 0) payload.generationConfig = generationConfig;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const decls = (body.tools as { type?: string; function?: { name?: string; description?: string; parameters?: unknown } }[])
      .filter((t) => t?.type === "function" && t.function?.name)
      .map((t) => ({
        name: t.function!.name!,
        ...(t.function!.description ? { description: t.function!.description } : {}),
        parameters: t.function!.parameters ?? { type: "object", properties: {} },
      }));
    if (decls.length > 0) payload.tools = [{ functionDeclarations: decls }];
    const choice = body.tool_choice as string | { type?: string; function?: { name?: string } } | undefined;
    if (choice === "auto") payload.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    else if (choice === "none") payload.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    else if (choice === "required") payload.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    else if (typeof choice === "object" && choice?.type === "function" && choice.function?.name) {
      payload.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.function.name] } };
    }
  }
  return { urlModel: String(body.model ?? ""), payload };
}

// ─── 响应转换（纯函数，单测覆盖） ───

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; functionCall?: { name?: string; args?: unknown } }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function mapFinishReason(reason: string | undefined): string {
  if (reason === "MAX_TOKENS") return "length";
  if (reason && reason !== "STOP") return "content_filter"; // SAFETY / RECITATION / PROHIBITED_CONTENT 等
  return "stop";
}

// Gemini 响应 → OpenAI chat.completion 形状
export function geminiToOpenAI(j: GeminiResponse, model: string): Record<string, unknown> {
  const cand = Array.isArray(j.candidates) ? j.candidates[0] : undefined;
  let text = "";
  const toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
  for (const part of Array.isArray(cand?.content?.parts) ? cand!.content!.parts! : []) {
    if (typeof part.text === "string") text += part.text;
    else if (part.functionCall?.name) {
      toolCalls.push({
        id: `call_${toolCalls.length}`,
        type: "function",
        function: { name: String(part.functionCall.name), arguments: JSON.stringify(part.functionCall.args ?? {}) },
      });
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content: text || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const prompt = Number(j.usageMetadata?.promptTokenCount) || 0;
  const completion = Number(j.usageMetadata?.candidatesTokenCount) || 0;
  return {
    id: `chatcmpl-gemini-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: mapFinishReason(cand?.finishReason) }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

// ─── SSE 转换 ───

// Gemini alt=sse 事件流 → OpenAI chunk 流（每个 data 是部分 GenerateContentResponse）
export function geminiSseToOpenAI(
  upstream: ReadableStream<Uint8Array>,
  usageRef: { current: UsageInfo | null },
  model: string,
  estPrompt: number
): ReadableStream<Uint8Array> {
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let outChars = 0;
  let toolCallIdx = 0;

  const chunkBase = () => ({
    id: `chatcmpl-gemini-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  });

  const syncUsage = () => {
    usageRef.current = {
      promptTokens: promptTokens ?? estPrompt,
      completionTokens: completionTokens ?? Math.ceil(outChars / 4),
    };
  };

  return transformSseToOpenAI(upstream, (payload) => {
    const j = JSON.parse(payload) as GeminiResponse;
    const cand = Array.isArray(j.candidates) ? j.candidates[0] : undefined;
    if (j.usageMetadata?.promptTokenCount != null) promptTokens = Number(j.usageMetadata.promptTokenCount) || null;
    if (j.usageMetadata?.candidatesTokenCount != null) completionTokens = Number(j.usageMetadata.candidatesTokenCount) || null;

    const parts = Array.isArray(cand?.content?.parts) ? cand!.content!.parts! : [];
    const delta: Record<string, unknown> = {};
    let hasDelta = false;
    for (const part of parts) {
      if (typeof part.text === "string" && part.text) {
        delta.content = String(delta.content ?? "") + part.text;
        outChars += part.text.length;
        hasDelta = true;
      } else if (part.functionCall?.name) {
        delta.tool_calls = [
          { index: toolCallIdx++, id: `call_${toolCallIdx}`, type: "function", function: { name: String(part.functionCall.name), arguments: JSON.stringify(part.functionCall.args ?? {}) } },
        ];
        hasDelta = true;
      }
    }
    syncUsage();

    const finishReason = cand?.finishReason;
    if (!hasDelta && !finishReason) return null; // 纯 usageMetadata 块不下发
    const out: Record<string, unknown> = {
      ...chunkBase(),
      choices: [{ index: 0, delta: hasDelta ? delta : {}, finish_reason: finishReason ? mapFinishReason(finishReason) : null }],
    };
    // 结束帧附带 usage（Gemini 在最后一个 chunk 带 usageMetadata；OpenAI 客户端取最后一次 usage）
    if (finishReason && usageRef.current) {
      const u = usageRef.current;
      out.usage = { prompt_tokens: u.promptTokens, completion_tokens: u.completionTokens, total_tokens: u.promptTokens + u.completionTokens };
    }
    return out;
  });
}

// ─── adapter 主入口 ───

export async function callGeminiChat(opts: {
  apiBase: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<OpenAIChatResult> {
  const usageRef: { current: UsageInfo | null } = { current: null };
  const stream = opts.body.stream === true;
  const model = String(opts.body.model ?? "");
  const { urlModel, payload } = buildGeminiBody(opts.body);

  const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const url = `${baseOf(opts.apiBase)}/models/${encodeURIComponent(urlModel)}:${method}`;

  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const fetchSignal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": opts.apiKey,
      },
      body: JSON.stringify(payload),
      signal: fetchSignal,
    });
  } catch (e) {
    const aborted = isClientAbort(e, opts.signal, timeoutSignal, "adapters/gemini.callGeminiChat");
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

  if (!stream) {
    const json = await upstream.json().catch(() => null);
    if (!json) {
      return { ok: false, status: upstream.status, usageRef, errorMessage: "上游响应无法解析" };
    }
    const j = json as GeminiResponse;
    usageRef.current = {
      promptTokens: Number(j.usageMetadata?.promptTokenCount) || estPrompt,
      completionTokens: Number(j.usageMetadata?.candidatesTokenCount) || 0,
    };
    return { ok: true, status: upstream.status, json: geminiToOpenAI(j, model), usageRef };
  }

  if (!upstream.body) {
    return { ok: false, status: upstream.status, usageRef, errorMessage: "上游未返回流式响应" };
  }
  return {
    ok: true,
    status: upstream.status,
    stream: geminiSseToOpenAI(upstream.body, usageRef, model, estPrompt),
    usageRef,
  };
}
