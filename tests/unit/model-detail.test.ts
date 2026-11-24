import { describe, it, expect } from "vitest";
import { availabilityRate, buildModelSample } from "@/lib/model-detail";

// ─── b9 模型详情：调用示例与近 7 天可用性口径 ───

describe("model-detail 模型详情", () => {
  it("对话模型使用 /chat/completions，包含模型名与鉴权头", () => {
    const s = buildModelSample({ name: "gpt-4o", endpointType: "chat" }, "https://api.example.com/v1");
    expect(s).toContain("https://api.example.com/v1/chat/completions");
    expect(s).toContain('"model":"gpt-4o"');
    expect(s).toContain("Authorization: Bearer YOUR_API_KEY");
  });

  it("图像 / 视频共用 /images/generations，音频 / 向量路径正确", () => {
    const base = "https://api.example.com/v1";
    expect(buildModelSample({ name: "seedream", endpointType: "image" }, base)).toContain(
      "/v1/images/generations"
    );
    expect(buildModelSample({ name: "seedance", endpointType: "video" }, base)).toContain(
      "/v1/images/generations"
    );
    expect(buildModelSample({ name: "seed-tts", endpointType: "audio" }, base)).toContain(
      "/v1/audio/speech"
    );
    expect(buildModelSample({ name: "text-embedding-3", endpointType: "embeddings" }, base)).toContain(
      "/v1/embeddings"
    );
  });

  it("Base URL 末尾斜杠归一化，空值回落 /v1", () => {
    const s = buildModelSample({ name: "m", endpointType: "chat" }, "https://a.com/v1/");
    expect(s).toContain("https://a.com/v1/chat/completions");
    expect(s).not.toContain("v1//");
    expect(buildModelSample({ name: "m", endpointType: "chat" }, "")).toContain("/v1/chat/completions");
  });

  it("近 7 天无调用返回 null，不估算为 0% / 100%", () => {
    expect(availabilityRate(null)).toBeNull();
    expect(availabilityRate(undefined)).toBeNull();
    expect(availabilityRate({ calls: 0, success: 0 })).toBeNull();
  });

  it("成功率保留 1 位小数，异常成功数夹取到有效范围", () => {
    expect(availabilityRate({ calls: 3, success: 2 })).toBe(66.7);
    expect(availabilityRate({ calls: 100, success: 100 })).toBe(100);
    expect(availabilityRate({ calls: 10, success: 99 })).toBe(100);
    expect(availabilityRate({ calls: 10, success: -5 })).toBe(0);
  });
});
