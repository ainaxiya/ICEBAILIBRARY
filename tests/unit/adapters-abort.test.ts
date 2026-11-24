import { describe, it, expect, vi, afterEach } from "vitest";
import { callImageGenerations, callMediaGenerations } from "@/lib/gateway/adapters/media";
import { callEmbeddings } from "@/lib/gateway/adapters/embeddings";

// ─── media / embeddings adapter 的客户端取消判定（与 chat 同一套三条件） ───

const abortErr = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// fetch 桩：跟随传入 signal，abort 时抛 AbortError（模拟真实 fetch 行为）
function stubFetchAbortable() {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      const sig = init?.signal;
      return new Promise((_resolve, reject) => {
        if (sig?.aborted) {
          reject(abortErr());
          return;
        }
        sig?.addEventListener("abort", () => reject(abortErr()), { once: true });
      });
    })
  );
}

function stubFetchReject(name: string, message: string) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(Object.assign(new Error(message), { name }))));
}

describe("media adapter 取消判定", () => {
  it("同步出图：客户端已 abort → aborted=true，不当作上游失败", async () => {
    const client = new AbortController();
    stubFetchAbortable();
    client.abort();
    const r = await callImageGenerations({
      apiBase: "http://mock",
      apiKey: "k",
      body: { model: "m", prompt: "p" },
      signal: client.signal,
    });
    expect(r.ok).toBe(false);
    expect(r.aborted).toBe(true);
    expect(r.status).toBe(0);
    expect(r.errorMessage).toBe("客户端已断开");
  });

  it("同步出图：客户端 signal 未 abort 的网络错误 → 仍是上游失败（aborted 不为 true）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetchReject("TypeError", "fetch failed");
    const client = new AbortController();
    const r = await callImageGenerations({
      apiBase: "http://mock",
      apiKey: "k",
      body: { model: "m", prompt: "p" },
      signal: client.signal,
    });
    expect(r.ok).toBe(false);
    expect(r.aborted).toBe(false);
    expect(r.errorMessage).toBe("fetch failed");
    expect(warn).not.toHaveBeenCalled();
  });

  it("同步出图：自身超时触发 → 不判为取消", async () => {
    stubFetchReject("TimeoutError", "The operation was aborted due to timeout");
    const client = new AbortController();
    client.abort(); // 客户端也 abort 了，但超时优先
    const r = await callImageGenerations({
      apiBase: "http://mock",
      apiKey: "k",
      body: { model: "m", prompt: "p" },
      signal: client.signal,
    });
    expect(r.aborted).toBe(false);
    expect(r.errorMessage).toBe("上游响应超时");
  });

  it("未传 signal（worker 口径）→ 不判为取消，并打 missing-signal 告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetchReject("TypeError", "fetch failed");
    const r = await callImageGenerations({ apiBase: "http://mock", apiKey: "k", body: { model: "m", prompt: "p" } });
    expect(r.aborted).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("adapters/media.callImageGenerations");
  });

  it("callMediaGenerations 透传 signal（endpointType=image）", async () => {
    const client = new AbortController();
    stubFetchAbortable();
    client.abort();
    const r = await callMediaGenerations({
      endpointType: "image",
      apiBase: "http://mock",
      apiKey: "k",
      body: { model: "m", prompt: "p" },
      signal: client.signal,
    });
    expect(r.aborted).toBe(true);
  });
});

describe("embeddings adapter 取消判定", () => {
  it("openai 协议：客户端已 abort → aborted=true", async () => {
    const client = new AbortController();
    stubFetchAbortable();
    client.abort();
    const r = await callEmbeddings({
      protocol: "openai",
      apiBase: "http://mock",
      apiKey: "k",
      body: { model: "m", input: "hello" },
      signal: client.signal,
    });
    expect(r.ok).toBe(false);
    expect(r.aborted).toBe(true);
    expect(r.errorMessage).toBe("客户端已断开");
  });

  it("gemini 协议：客户端已 abort → aborted=true", async () => {
    const client = new AbortController();
    stubFetchAbortable();
    client.abort();
    const r = await callEmbeddings({
      protocol: "gemini",
      apiBase: "http://mock",
      apiKey: "k",
      body: { model: "m", input: "hello" },
      signal: client.signal,
    });
    expect(r.aborted).toBe(true);
  });

  it("openai 协议：真实网络错误 → aborted 不为 true", async () => {
    stubFetchReject("TypeError", "fetch failed");
    const client = new AbortController();
    const r = await callEmbeddings({
      protocol: "openai",
      apiBase: "http://mock",
      apiKey: "k",
      body: { model: "m", input: "hello" },
      signal: client.signal,
    });
    expect(r.aborted).toBe(false);
    expect(r.errorMessage).toBe("fetch failed");
  });
});
