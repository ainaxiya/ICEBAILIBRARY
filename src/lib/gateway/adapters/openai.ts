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
  // 客户端主动中止（不是上游失败）；熔断统计会忽略这类结果
  aborted?: boolean;
}

// 客户端取消 vs 上游失败的判定，三个条件必须同时成立：
// 1) fetch 抛的确实是 AbortError（排除 TimeoutError 与网络错误）
// 2) 调用方 signal 已 abort —— 该 signal 由路由层 AbortController 持有，
//    只挂载在 req.signal 的 "abort" 事件上（Next.js 在客户端断连时触发），没有别的 abort 来源
// 3) 本 adapter 自己的超时 signal 未触发 —— 排除 300s 上游超时
// 因此它是事件驱动的确定信号，不是靠超时时长近似。
// 防御：调用方漏传 signal（或传了非 AbortSignal 的假 signal）时，取消判定必然失效，
// 会把客户端断连误记成上游失败 —— 此时明确返回 false 并打一条可检索的 warn。
export function isClientAbort(
  e: unknown,
  clientSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  callPath = "unknown",
): boolean {
  const usable = !!clientSignal && typeof clientSignal.aborted === "boolean";
  if (!usable) {
    console.warn(
      `[gateway][isClientAbort][missing-signal] 调用方未传可用 signal，取消判定降级为 false（path=${callPath}）；客户端断连将被计为上游失败，请检查该 adapter 的 opts.signal 传参`
    );
    return false;
  }
  return (
    (e as Error)?.name === "AbortError" &&
    clientSignal!.aborted === true &&
    !timeoutSignal.aborted
  );
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
  // P2 取消传播：客户端断连 → abort 上游 fetch（流阶段 reader.cancel 已天然传播，此处覆盖等待阶段）
  signal?: AbortSignal;
}): Promise<OpenAIChatResult> {
  const usageRef: { current: UsageInfo | null } = { current: null };
  const stream = opts.body.stream === true;

  // 流式时要求上游在最后一个 chunk 带 usage（OpenAI 兼容协议）
  const upstreamBody = stream
    ? { ...opts.body, stream: true, stream_options: { include_usage: true } }
    : opts.body;

  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const fetchSignal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;

  let upstream: Response;
  try {
    upstream = await fetch(`${baseOf(opts.apiBase)}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
      signal: fetchSignal,
    });
  } catch (e) {
    const aborted = isClientAbort(e, opts.signal, timeoutSignal, "adapters/openai.callChatCompletions");
    const msg = aborted
      ? "客户端已断开"
      : (e as Error).name === "TimeoutError"
        ? "上游响应超时"
        : (e as Error).message;
    return { ok: false, status: 0, usageRef, errorMessage: msg, aborted };
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
  let sawUsage = false;

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
            sawUsage = true;
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
      // P2 运行估算：上游 usage 未到时，持续维护「已发生用量」估算，
      // 客户端中途断连（cancel）也能按实际消耗结算，而非全额退款
      if (!sawUsage) {
        usageRef.current = {
          promptTokens: estPrompt,
          completionTokens: Math.ceil(outChars / 4),
        };
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
