import { describe, it, expect } from "vitest";
import { resolveRequestId } from "@/lib/gateway/idempotency";

// ─── L1 幂等键作用域单测（纯函数，不连库） ───
// 目标：同一次请求的网络重试仍然幂等；换端点 / 换模型 / 换参数不再命中旧扣费。

function req(key?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (key) headers.set("idempotency-key", key);
  return new Request("http://localhost/v1/chat/completions", { method: "POST", headers });
}

const chatBody = { model: "gpt-x", messages: [{ role: "user", content: "hi" }], max_tokens: 16 };
const imageBody = { model: "img-y", prompt: "a cat", n: 1 };
const chatScope = { endpoint: "chat.completions", model: "gpt-x", body: chatBody };

describe("幂等键绑定端点与请求体（L1）", () => {
  it("同用户 + 同 Key + 同端点/模型/body → 同一 requestId（网络重试只扣一次）", () => {
    const a = resolveRequestId(1, req("K1"), chatScope);
    const b = resolveRequestId(1, req("K1"), chatScope);
    expect(a).toBe(b);
  });

  it("body 键序不同但内容相同 → 仍是同一 requestId（稳定序列化）", () => {
    const a = resolveRequestId(1, req("K1"), chatScope);
    const reordered = {
      body: { max_tokens: 16, messages: [{ content: "hi", role: "user" }], model: "gpt-x" },
      endpoint: "chat.completions",
      model: "gpt-x",
    };
    expect(resolveRequestId(1, req("K1"), reordered)).toBe(a);
  });

  it("换端点 → requestId 不同（廉价 chat 的 Key 不再复用到生图）", () => {
    const chat = resolveRequestId(1, req("K1"), chatScope);
    const image = resolveRequestId(1, req("K1"), { endpoint: "image_generations", model: "img-y", body: imageBody });
    expect(chat).not.toBe(image);
  });

  it("换模型 → requestId 不同", () => {
    const a = resolveRequestId(1, req("K1"), chatScope);
    const b = resolveRequestId(1, req("K1"), { ...chatScope, model: "gpt-y" });
    expect(a).not.toBe(b);
  });

  it("换请求参数 → requestId 不同（换参数不再命中旧扣费）", () => {
    const a = resolveRequestId(1, req("K1"), chatScope);
    const b = resolveRequestId(1, req("K1"), { ...chatScope, body: { ...chatBody, max_tokens: 32 } });
    expect(a).not.toBe(b);
  });

  it("同 Key 不同用户 → requestId 不同（沿用 userId 作用域）", () => {
    expect(resolveRequestId(1, req("K1"), chatScope)).not.toBe(resolveRequestId(2, req("K1"), chatScope));
  });

  it("大字段（图片 base64）只取摘要：内容相同则幂等、内容不同则区分、键长度有界", () => {
    const base64 = "data:image/png;base64," + "A".repeat(50_000);
    const s1 = { endpoint: "image_generations", model: "img-y", body: { model: "img-y", image: base64 } };
    const s2 = { endpoint: "image_generations", model: "img-y", body: { image: base64, model: "img-y" } };
    const s3 = { endpoint: "image_generations", model: "img-y", body: { model: "img-y", image: base64.slice(0, -1) + "B" } };
    const a = resolveRequestId(1, req("K1"), s1);
    const b = resolveRequestId(1, req("K1"), s2);
    const c = resolveRequestId(1, req("K1"), s3);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBeLessThan(256);
    expect(a).not.toContain("AAAAAAAAAAAAAAAAAAAA");
  });

  it("未带 Idempotency-Key → 随机 UUID（不启用幂等，行为与改造前一致）", () => {
    const a = resolveRequestId(1, req(), chatScope);
    const b = resolveRequestId(1, req(), chatScope);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("非法字符 Key 清洗后为空 → 视为未传（随机）", () => {
    const a = resolveRequestId(1, req("!!!###$$$%%%"), chatScope);
    const b = resolveRequestId(1, req("!!!###$$$%%%"), chatScope);
    expect(a).not.toBe(b);
  });
});
