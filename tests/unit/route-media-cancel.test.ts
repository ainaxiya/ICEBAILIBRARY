import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── 同步图片路由的断连语义（v1.0 起与视频 worker 统一）───
// 客户端断连不中断生成：路由不监听 req.signal、不把 signal 传给 adapter，
// 服务器照常跑完 → 结算 → 产物转存进「我的资产」。
// 真实上游失败仍按原口径换 Key / 退款 / 熔断。

const h = vi.hoisted(() => {
  const KEY_ID = 880001;
  const billing = {
    preCheck: vi.fn(async () => ({ ok: true })),
    preDeduct: vi.fn(async () => ({ ok: true })),
    refund: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
  };
  const saveAsset = vi.fn(async () => ({ ok: true, assetId: 1 }));
  const recordUsage = vi.fn(async () => 1);
  return { KEY_ID, billing, saveAsset, recordUsage };
});

vi.mock("@/lib/gateway/auth", () => ({
  authenticateV1: async () => ({ ok: true, user: { id: 1 }, channel: "apikey", apiKeyId: 1 }),
}));
vi.mock("@/lib/gateway/idempotency", () => ({ resolveRequestId: () => "req-test" }));
vi.mock("@/lib/gateway/billing", () => ({ billing: h.billing }));
vi.mock("@/lib/gateway/usage", () => ({ recordUsage: h.recordUsage }));
vi.mock("@/lib/assets", () => ({ saveGeneratedAsset: h.saveAsset }));
vi.mock("@/lib/quota", () => ({
  acquireSlot: () => ({ ok: true, release: () => {} }),
  checkKeyRpm: () => ({ ok: true }),
  checkQuota: async () => ({ ok: true }),
  getQuotaConfig: async () => ({ concurrency: 10 }),
}));
vi.mock("@/lib/gateway/pricing", () => ({
  costMilli: () => 0,
  displayMemberCredits: () => 10,
  pricingSnapshot: () => ({}),
}));
vi.mock("@/lib/gateway/adapters/media", () => ({ callMediaGenerations: vi.fn() }));
vi.mock("@/lib/gateway/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gateway/router")>();
  return {
    ...actual,
    markKeyUsed: () => {},
    resolveRoute: async () => ({
      model: { id: 1, endpointType: "image" },
      endpoints: [{ path: "image_generations", enabled: true }],
      pricing: { unit: "image" },
      vendor: { protocol: "openai" },
      candidates: [{ vendorKeyId: h.KEY_ID, apiBase: "http://mock", apiKey: "k" }],
    }),
  };
});

import { POST } from "@/app/v1/images/generations/route";
import { callMediaGenerations } from "@/lib/gateway/adapters/media";
import { keyIsAvailable, resetKeyHealth } from "@/lib/gateway/router";

const media = vi.mocked(callMediaGenerations);

// aborted=true 模拟「客户端已断开」的请求：Next 会在连接断开时 abort signal
function makeAbortedReq() {
  const ac = new AbortController();
  ac.abort();
  return new NextRequest("http://localhost/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "img-model", prompt: "a cat" }),
    signal: ac.signal,
  });
}

beforeEach(() => {
  resetKeyHealth(h.KEY_ID);
  media.mockReset();
  h.billing.settle.mockClear();
  h.billing.refund.mockClear();
  h.saveAsset.mockClear();
  h.recordUsage.mockClear();
});

describe("POST /v1/images/generations 断连语义", () => {
  it("客户端已断连 → 生成不中断、照常结算并转存入库（200）", async () => {
    media.mockResolvedValue({ ok: true, status: 200, urls: ["https://up/img.png"] });

    const res = await POST(makeAbortedReq());

    expect(res.status).toBe(200);
    // 不能把 signal 传给 adapter（传了就会在断连时 abort 上游）
    expect(media.mock.calls[0][0].signal).toBeUndefined();
    // 照常结算 + 转存（产物进「我的资产」），不退款
    expect(h.billing.settle).toHaveBeenCalledTimes(1);
    expect(h.billing.refund).not.toHaveBeenCalled();
    expect(h.saveAsset).toHaveBeenCalledTimes(1);
    expect(h.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }));
  });

  it("连续 20 次断连请求 → 全部 200，熔断器保持可用", async () => {
    media.mockResolvedValue({ ok: true, status: 200, urls: ["https://up/img.png"] });
    for (let i = 0; i < 20; i++) {
      const res = await POST(makeAbortedReq());
      expect(res.status).toBe(200);
    }
    expect(keyIsAvailable(h.KEY_ID)).toBe(true);
  });

  it("真实上游失败累计满窗口 → 仍然正常熔断（行为未被削弱）", async () => {
    media.mockResolvedValue({ ok: false, status: 502, urls: [], errorMessage: "HTTP 502" });
    // 每个请求只命中 1 个候选 Key → 1 个失败样本；MIN_SAMPLES=5，跑 6 次必熔断
    for (let i = 0; i < 6; i++) {
      const res = await POST(makeAbortedReq());
      expect(res.status).toBe(502);
    }
    expect(keyIsAvailable(h.KEY_ID)).toBe(false);
    expect(h.billing.settle).not.toHaveBeenCalled();
    expect(h.billing.refund).toHaveBeenCalled();
  });
});
