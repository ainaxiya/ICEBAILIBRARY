// ─── P4 多协议：SSE 流转换工具 ───
// Anthropic / Gemini 的 SSE 与 OpenAI 格式不同，adapter 在流层面做协议转换：
// 上游 SSE 逐块解析 → 生成 OpenAI 兼容 chunk → 以 `data: {...}\n\n` 帧下发，
// 下游 chat 路由无需感知上游协议差异（透传/结算逻辑不变）。

const encoder = new TextEncoder();

// 上游 SSE → OpenAI SSE 转换流
// onData：每收到一个上游 data: 事件调用一次；
//   返回 OpenAI chunk 对象 → 编码为标准帧下发；返回 null → 跳过不发。
// 流结束时自动补发 `data: [DONE]\n\n`（OpenAI 惯例收尾帧）。
export function transformSseToOpenAI(
  upstream: ReadableStream<Uint8Array>,
  onData: (payload: string) => Record<string, unknown> | null
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buf = "";
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, chunk: Record<string, unknown>) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };
  const feed = (controller: TransformStreamDefaultController<Uint8Array>, payload: string) => {
    try {
      const out = onData(payload);
      if (out) emit(controller, out);
    } catch {
      // 跳过无法解析的事件（心跳/元数据），不断流
    }
  };

  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue; // event: / 注释行跳过，只认 data
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          feed(controller, payload);
        }
      },
      flush(controller) {
        // 缓冲区残留兜底（正常 SSE 以 \n 结尾）
        const line = buf.trim();
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload && payload !== "[DONE]") feed(controller, payload);
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      },
    })
  );
}

// 粗估 token（≈4 字符 1 token），仅作 usage 缺失兜底
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// 从上游错误响应体提取可读信息（不泄漏上游内部细节给客户端之外的场景）
export async function upstreamErrorOf(res: Response, pickMessage: (j: Record<string, unknown>) => string): Promise<string> {
  const text = await res.text().catch(() => "");
  let detail = "";
  try {
    detail = pickMessage(JSON.parse(text));
  } catch {
    detail = text.slice(0, 200);
  }
  return `HTTP ${res.status}${detail ? `：${detail}` : ""}`;
}
