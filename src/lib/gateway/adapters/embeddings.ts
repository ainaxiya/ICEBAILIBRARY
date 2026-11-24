// ─── P4 多模态：embeddings adapter（协议分发） ───
// openai 协议：POST {apiBase}/embeddings 原样透传；
// gemini 协议：转 :batchEmbedContents（requests[].content.parts），响应转回 OpenAI list 形状；
// anthropic 协议：无 embeddings 能力，直接失败（路由层会提前拦截给更清晰错误）。

import { estimateTokens } from "./sse";
import { isClientAbort } from "./openai";

export interface EmbeddingsResult {
  ok: boolean;
  status: number;
  // OpenAI list 形状（openai 透传原样；gemini 转换后）
  json?: unknown;
  // 输入 token 数（结算依据：按 input tokens 计费）
  promptTokens: number;
  errorMessage?: string;
  // 客户端主动中止（不是上游失败）；熔断统计会忽略这类结果
  aborted?: boolean;
}

const UPSTREAM_TIMEOUT_MS = 300000;

function baseOf(apiBase: string): string {
  return apiBase.replace(/\/+$/, "");
}

// OpenAI input（string | string[]）→ 文本数组
function textsOf(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input.map((t) => (typeof t === "string" ? t : String(t ?? "")));
  return [];
}

// ─── Gemini 转换（纯函数，单测覆盖） ───

export interface GeminiBatchEmbedResponse {
  embeddings?: { values?: number[] }[];
}

// Gemini batchEmbedContents 响应 → OpenAI list 形状
export function geminiEmbedToOpenAI(j: GeminiBatchEmbedResponse, model: string, promptTokens: number): Record<string, unknown> {
  const list = Array.isArray(j.embeddings) ? j.embeddings : [];
  return {
    object: "list",
    data: list.map((e, i) => ({ object: "embedding", index: i, embedding: Array.isArray(e.values) ? e.values : [] })),
    model,
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  };
}

// ─── adapter 主入口 ───

export async function callEmbeddings(opts: {
  protocol: string;
  apiBase: string;
  apiKey: string;
  body: Record<string, unknown>;
  // 客户端取消传播（同步 HTTP 路径传请求 signal）
  signal?: AbortSignal;
}): Promise<EmbeddingsResult> {
  const model = String(opts.body.model ?? "");
  const texts = textsOf(opts.body.input);
  const estTokens = estimateTokens(JSON.stringify(texts));

  if (opts.protocol === "anthropic") {
    return { ok: false, status: 400, promptTokens: 0, errorMessage: "Anthropic 协议不支持 embeddings 端点" };
  }

  // ── Gemini：batchEmbedContents 转换 ──
  if (opts.protocol === "gemini") {
    const payload = {
      requests: texts.map((t) => ({
        model: `models/${model}`,
        content: { parts: [{ text: t }] },
      })),
    };
    let upstream: Response;
    const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    const fetchSignal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
    try {
      upstream = await fetch(`${baseOf(opts.apiBase)}/models/${encodeURIComponent(model)}:batchEmbedContents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": opts.apiKey },
        body: JSON.stringify(payload),
        signal: fetchSignal,
      });
    } catch (e) {
      const aborted = isClientAbort(e, opts.signal, timeoutSignal, "adapters/embeddings.callEmbeddings(gemini)");
      const msg = aborted ? "客户端已断开" : (e as Error).name === "TimeoutError" ? "上游响应超时" : (e as Error).message;
      return { ok: false, status: 0, promptTokens: 0, errorMessage: msg, aborted };
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      let detail = "";
      try {
        detail = String((JSON.parse(text)?.error as { message?: unknown } | undefined)?.message ?? "");
      } catch {
        detail = text.slice(0, 200);
      }
      return { ok: false, status: upstream.status, promptTokens: 0, errorMessage: `HTTP ${upstream.status}${detail ? `：${detail}` : ""}` };
    }
    const json = await upstream.json().catch(() => null);
    if (!json) {
      return { ok: false, status: upstream.status, promptTokens: 0, errorMessage: "上游响应无法解析" };
    }
    return {
      ok: true,
      status: upstream.status,
      json: geminiEmbedToOpenAI(json as GeminiBatchEmbedResponse, model, estTokens),
      promptTokens: estTokens, // Gemini embeddings 不返回用量，按字符粗估
    };
  }

  // ── OpenAI 兼容：原样透传 ──
  let upstream: Response;
  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const fetchSignal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
  try {
    upstream = await fetch(`${baseOf(opts.apiBase)}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ ...opts.body, input: texts.length === 1 ? texts[0] : texts }),
      signal: fetchSignal,
    });
  } catch (e) {
    const aborted = isClientAbort(e, opts.signal, timeoutSignal, "adapters/embeddings.callEmbeddings(openai)");
    const msg = aborted ? "客户端已断开" : (e as Error).name === "TimeoutError" ? "上游响应超时" : (e as Error).message;
    return { ok: false, status: 0, promptTokens: 0, errorMessage: msg, aborted };
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    let detail = "";
    try {
      detail = String((JSON.parse(text)?.error as { message?: unknown } | undefined)?.message ?? "");
    } catch {
      detail = text.slice(0, 200);
    }
    return { ok: false, status: upstream.status, promptTokens: 0, errorMessage: `HTTP ${upstream.status}${detail ? `：${detail}` : ""}` };
  }
  const json = await upstream.json().catch(() => null);
  if (!json) {
    return { ok: false, status: upstream.status, promptTokens: 0, errorMessage: "上游响应无法解析" };
  }
  const usage = (json as { usage?: { prompt_tokens?: number } }).usage;
  return {
    ok: true,
    status: upstream.status,
    json,
    promptTokens: Number(usage?.prompt_tokens) || estTokens,
  };
}
