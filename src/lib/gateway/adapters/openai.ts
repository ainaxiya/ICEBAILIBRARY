// ─── P1 聚合网关：通用 OpenAI 兼容 adapter（chat/completions） ───
// 上游 fetch 直连 apiBase；SSE 流式用 ReadableStream 逐块透传（不缓冲、不重组），
// 透传同时旁路解析 usage（prompt_tokens/completion_tokens）供结算；
// 上游未带 usage 时按 4 字符 ≈ 1 token 粗估兜底。

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
}

export interface OpenAIChatResult {
  ok: boolean;
  status: number;
  // 非流式：完整响应 JSON（原样透传给客户端）
  json?: unknown;
  // 流式：逐块透传的 SSE 流
  stream?: ReadableStream<Uint8Array>;
  // usage 回填槽（流结束时已就绪）
  usageRef: { current: UsageInfo | null };
  errorMessage?: string;
}

const UPSTREAM_TIMEOUT_MS = 300000;

function baseOf(apiBase: string): string {
  return apiBase.replace(/\/+$/, "");
}

// 粗估 token（≈4 字符 1 token），仅作 usage 缺失兜底
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function callChatCompletions(opts: {
  apiBase: string;
  apiKey: string;
  // OpenAI 兼容 body（model/messages/stream/temperature/max_tokens 等，原样透传）
  body: Record<string, unknown>;
}): Promise<OpenAIChatResult> {
  const usageRef: { current: UsageInfo | null } = { current: null };
  const stream = opts.body.stream === true;

  // 流式时要求上游在最后一个 chunk 带 usage（OpenAI 兼容协议）
  const upstreamBody = stream
    ? { ...opts.body, stream: true, stream_options: { include_usage: true } }
    : opts.body;

  let upstream: Response;
  try {
    upstream = await fetch(`${baseOf(opts.apiBase)}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    const msg =
      (e as Error).name === "TimeoutError" ? "上游响应超时" : (e as Error).message;
    return { ok: false, status: 0, usageRef, errorMessage: msg };
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    let detail = "";
    try {
      detail = (JSON.parse(text)?.error?.message as string) || "";
    } catch {
      detail = text.slice(0, 200);
    }
    return {
      ok: false,
      status: upstream.status,
      usageRef,
      errorMessage: `HTTP ${upstream.status}${detail ? `：${detail}` : ""}`,
    };
  }

  // ── 非流式：整包解析 ──
  if (!stream) {
    const json = await upstream.json().catch(() => null);
    if (!json) {
      return { ok: false, status: upstream.status, usageRef, errorMessage: "上游响应无法解析" };
    }
    const u = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
    if (u) {
      usageRef.current = {
        promptTokens: Number(u.prompt_tokens) || 0,
        completionTokens: Number(u.completion_tokens) || 0,
      };
    }
    return { ok: true, status: upstream.status, json, usageRef };
  }

  // ── 流式：逐块透传 + 旁路解析 usage ──
  if (!upstream.body) {
    return { ok: false, status: upstream.status, usageRef, errorMessage: "上游未返回流式响应" };
  }

  const estPrompt = estimateTokens(JSON.stringify(opts.body.messages ?? ""));
  const decoder = new TextDecoder();
  let sseBuf = "";
  let outChars = 0;

  const parser = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk); // 原样透传，逐块不缓冲
      sseBuf += decoder.decode(chunk, { stream: true });
      const lines = sseBuf.split("\n");
      sseBuf = lines.pop() || "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          if (j.usage) {
            usageRef.current = {
              promptTokens: Number(j.usage.prompt_tokens) || 0,
              completionTokens: Number(j.usage.completion_tokens) || 0,
            };
          }
          const piece = j.choices?.[0]?.delta?.content;
          if (typeof piece === "string") outChars += piece.length;
        } catch {
          // 忽略无法解析的心跳/元数据行
        }
      }
    },
    flush() {
      // 上游没带 usage：按输出字符粗估兜底，保证结算有数
      if (!usageRef.current) {
        usageRef.current = {
          promptTokens: estPrompt,
          completionTokens: Math.ceil(outChars / 4),
        };
      }
    },
  });

  return {
    ok: true,
    status: upstream.status,
    stream: upstream.body.pipeThrough(parser),
    usageRef,
  };
}
