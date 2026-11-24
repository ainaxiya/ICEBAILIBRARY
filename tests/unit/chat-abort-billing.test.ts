import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── 等待阶段断连的计费口径 ───
// ① 一次上游请求都没发出（进入调用前已断连）→ 平台无成本 → 全额退回预扣
// ② 已把请求发给上游但响应未知 → 上游可能已按输入计费 → 只收输入 token，差额退回
// ③ 上游真实失败（非断连）→ 仍按原口径全额退回

const h = vi.hoisted(() => {
  const billing = {
    preCheck: vi.fn(async () => ({ ok: true })),
    preDeduct: vi.fn(async () => ({ ok: true })),
    refund: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
  };
  const recordUsage = vi.fn(async () => 1);
  const chat = vi.fn();
  return { billing, recordUsage, chat };
});

vi.mock("@/lib/gateway/billing", () => ({ billing: h.billing }));
vi.mock("@/lib/gateway/usage", () => ({ recordUsage: h.recordUsage }));
vi.mock("@/lib/gateway/idempotency", () => ({ resolveRequestId: () => "req-abort" }));
vi.mock("@/lib/gateway/adapters", () => ({ callChatForProtocol: h.chat }));
vi.mock("@/lib/gateway/auth", () => ({
  authenticateV1: async () => ({ ok: true, user: { id: 7 }, channel: "onsite", apiKeyId: null }),
}));
vi.mock("@/lib/gateway/response-cache", () => ({
  beginIdempotentRequest: async () => ({ hit: false }),
  hasClientIdempotencyKey: () => false,
  releaseIdempotentRequest: async () => {},
  saveIdempotentResponse: async () => {},
}));
vi.mock("@/lib/quota", () => ({
  acquireSlot: () => ({ ok: true, release: () => {} }),
  checkKeyRpm: () => ({ ok: true }),
  checkQuota: async () => ({ ok: true }),
  getQuotaConfig: async () => ({ concurrency: 10 }),
}));
vi.mock("@/lib/gateway/pricing", () => ({
  // 预估（输入+输出）100 积分；只算输入时 3 积分 → 断连时差额退回
  estimateCredits: () => 100,
  displayMemberCredits: (_p: unknown, _input: number, output: number) => (output === 0 ? 3 : 100),
  pricingSnapshot: () => ({}),
  totalCostMilli: () => 0,
}));
vi.mock("@/lib/gateway/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gateway/router")>();
  return {
    ...actual,
    markKeyUsed: () => {},
    tryAcquireKeyCall: () => true,
    recordKeyOutcome: () => {},
    recordKeyCancelled: () => {},
    releaseKeyProbe: () => {},
    resolveRoute: async () => ({
      model: { id: 1 },
      endpoints: [{ path: "chat_completions", enabled: true }],
      pricing: { unit: "token" },
      vendor: { protocol: "openai" },
      candidates: [{ vendorKeyId: 1, apiBase: "http://mock", apiKey: "k" }],
    }),
  };
});
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({ id: 7, status: "active" }),
  getActiveUser: async () => ({ user: { id: 7, status: "active" }, state: "ok" }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    skill: { findMany: async () => [] },
    siteSetting: { findMany: async () => [], findUnique: async () => null },
    playgroundSession: {
      count: async () => 0,
      findFirst: async () => null,
      create: async () => ({ id: 1 }),
      deleteMany: async () => ({ count: 0 }),
    },
    playgroundMessage: { count: async () => 0 },
  },
}));

import { POST as postV1 } from "@/app/v1/chat/completions/route";
import { POST as postOnsite } from "@/app/api/playground/chat/route";

const BODY = { model: "m", messages: [{ role: "user", content: "hi" }] };

function makeReq(url: string, signal?: AbortSignal) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(BODY),
    signal,
  });
}

beforeEach(() => {
  h.chat.mockReset();
  h.billing.refund.mockClear();
  h.billing.settle.mockClear();
  h.billing.preCheck.mockClear();
  h.billing.preDeduct.mockClear();
  h.recordUsage.mockClear();
});

describe.each([
  ["/v1/chat/completions", postV1],
  ["/api/playground/chat", postOnsite],
])("%s 等待阶段断连计费", (url, post) => {
  it("进入调用前已断连 → 不碰上游，全额退款、不结算", async () => {
    const ac = new AbortController();
    ac.abort();

    const res = await post(makeReq(url, ac.signal));

    expect(res.status).toBe(499);
    expect(h.chat).not.toHaveBeenCalled();
    expect(h.billing.refund).toHaveBeenCalledTimes(1);
    expect(h.billing.settle).not.toHaveBeenCalled();
    // 预扣 100 已全额退回 → 净扣 0
    expect(h.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", paidCredits: 0, costMilli: 0 })
    );
  });

  it("已向上游发出请求后断连 → 只按输入结算 3 积分（无预扣，不做整单退）", async () => {
    const ac = new AbortController();
    h.chat.mockImplementation(async (args: { signal?: AbortSignal }) => {
      // 上游请求已发出，此时客户端断开
      ac.abort();
      void args.signal;
      return { ok: false, status: 499, aborted: true, errorMessage: "client aborted" };
    });

    const res = await post(makeReq(url, ac.signal));

    expect(res.status).toBe(499);
    expect(h.chat).toHaveBeenCalledTimes(1);
    // g19：文本不再预扣，settle 直接按已发输入扣 3；v1 额外带 apiKeyId（此处为 null）
    expect(h.billing.settle.mock.calls[0].slice(0, 3)).toEqual([7, "req-abort", 3]);
    expect(h.billing.refund).not.toHaveBeenCalled();
    expect(h.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", paidCredits: 3, outputTokens: 0 })
    );
  });

  it("上游真实失败（非断连）→ 仍全额退款（原口径不变）", async () => {
    h.chat.mockResolvedValue({ ok: false, status: 502, errorMessage: "HTTP 502" });

    const res = await post(makeReq(url));

    expect(res.status).toBe(502);
    expect(h.billing.refund).toHaveBeenCalledTimes(1);
    expect(h.billing.settle).not.toHaveBeenCalled();
  });
});
