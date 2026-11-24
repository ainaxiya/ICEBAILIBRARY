import { describe, expect, it } from "vitest";
import {
  CLIENT_INTEGRATIONS,
  clientEndpoint,
  renderClientStep,
} from "@/lib/client-integrations";

describe("b3 客户端接入信息", () => {
  it("收录 4-6 款国产客户端且 id 不重复", () => {
    expect(CLIENT_INTEGRATIONS.length).toBeGreaterThanOrEqual(4);
    expect(CLIENT_INTEGRATIONS.length).toBeLessThanOrEqual(6);
    const ids = CLIENT_INTEGRATIONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每款都给出官网、地址字段与手动步骤（不编造深链）", () => {
    for (const c of CLIENT_INTEGRATIONS) {
      expect(c.homepage.startsWith("https://")).toBe(true);
      expect(c.addressLabel.length).toBeGreaterThan(0);
      expect(c.steps.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("地址形态区分：普通客户端填 /v1，沉浸式翻译要完整 chat/completions", () => {
    const cherry = CLIENT_INTEGRATIONS.find((c) => c.id === "cherry-studio")!;
    const immersive = CLIENT_INTEGRATIONS.find((c) => c.id === "immersive-translate")!;
    expect(clientEndpoint(cherry, "https://example.com/v1")).toBe("https://example.com/v1");
    expect(clientEndpoint(immersive, "https://example.com/v1")).toBe(
      "https://example.com/v1/chat/completions"
    );
  });

  it("步骤占位符按客户端端点渲染", () => {
    const c = CLIENT_INTEGRATIONS[1];
    const out = renderClientStep("填 {{base}} 或 {{endpoint}}", {
      base: "https://a/v1",
      endpoint: "https://a/v1/chat/completions",
    });
    expect(out).toBe("填 https://a/v1 或 https://a/v1/chat/completions");
  });
});
