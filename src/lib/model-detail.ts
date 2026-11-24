// b9 模型详情页：调用示例生成与近 7 天可用性口径（纯函数，便于单测）
// 只使用现有 usage_record 能算出的「调用量 / 成功数」；
// 首字延迟、吞吐等未采集指标不在本模块出现，也不做任何推算。

export type SampleModelRef = {
  /** 模型名（请求体 model 参数） */
  name: string;
  /** chat | image | video | audio | embeddings */
  endpointType: string;
};

const AUTH_HEADERS = `  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\`;

/** 按模型类型生成可复制的 curl 示例（与站内 API 文档的 Base URL 同源） */
export function buildModelSample(m: SampleModelRef, baseUrl: string): string {
  const base = (baseUrl || "/v1").replace(/\/+$/, "");
  const body = (s: string) => `  -d '${s}'`;
  switch (m.endpointType) {
    case "image":
      return `curl ${base}/images/generations \\\n${AUTH_HEADERS}\n${body(
        `{"model":"${m.name}","prompt":"一只在雪山上看极光的柴犬","n":1,"size":"1024x1024"}`
      )}`;
    case "video":
      return `curl ${base}/images/generations \\\n${AUTH_HEADERS}\n${body(
        `{"model":"${m.name}","prompt":"镜头缓慢推进，雪山日出，电影质感"}`
      )}`;
    case "audio":
      return `curl ${base}/audio/speech \\\n${AUTH_HEADERS}\n${body(
        `{"model":"${m.name}","input":"你好，欢迎使用","voice":"alloy","response_format":"mp3"}`
      )}`;
    case "embeddings":
      return `curl ${base}/embeddings \\\n${AUTH_HEADERS}\n${body(
        `{"model":"${m.name}","input":"hello world"}`
      )}`;
    default:
      return `curl ${base}/chat/completions \\\n${AUTH_HEADERS}\n${body(
        `{"model":"${m.name}","messages":[{"role":"user","content":"你好，介绍一下你自己"}],"stream":false}`
      )}`;
  }
}

/**
 * 近 7 天成功率（0-100，保留 1 位小数）。
 * 无调用返回 null —— 前端显示「暂无调用」，不按 0% / 100% 估算。
 */
export function availabilityRate(
  stats: { calls: number; success: number } | null | undefined
): number | null {
  if (!stats || stats.calls <= 0) return null;
  const success = Math.min(Math.max(stats.success, 0), stats.calls);
  return Math.round((success / stats.calls) * 1000) / 10;
}
