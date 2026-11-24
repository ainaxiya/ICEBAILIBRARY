import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── POST /v1/videos 建任务失败的回滚与幂等收口 ───
// ① videoTask.create 抛错 → 预扣全额退回 + 500 task_create_failed，不启动执行器
// ② 同一 Idempotency-Key 的上一轮已退款 → 409，禁止「退了又被重放免费建任务」
// ③ 正常建任务 → 不退款
// ④ 并发同键撞 P2002 → 幂等返回已有任务，不退款（否则对方任务变免费）

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  count: vi.fn(),
  ledgerFindUnique: vi.fn(),
  preDeduct: vi.fn(),
  refund: vi.fn(),
  settle: vi.fn(),
  runVideoTask: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("@/lib/gateway/auth", () => ({
  authenticateV1: async () => ({ ok: true, user: { id: 7 }, channel: "apikey", apiKeyId: 1 }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    videoTask: { findUnique: m.findUnique, create: m.create, count: m.count },
    creditLedger: { findUnique: m.ledgerFindUnique },
  },
}));
vi.mock("@/lib/gateway/billing", () => ({
  billing: {
    preCheck: async () => ({ ok: true }),
    preDeduct: m.preDeduct,
    settle: m.settle,
    refund: m.refund,
  },
  rechargeUrlFor: () => "/recharge",
}));
vi.mock("@/lib/gateway/idempotency", () => ({ resolveRequestId: () => "req-v1-video" }));
vi.mock("@/lib/gateway/pricing", () => ({
  displayMemberCredits: () => 100,
  // v1.0.94 视频统一秒价：只认通用行；任务积分 = 每秒价 × 秒数
  genericPricing: () => ({
    id: 1,
    unit: "video_second",
    variant: "",
    meterBase: 1,
    inputPrice: 0.04,
    outputPrice: 0,
    fxRateE8: 100_000_000n,
    multiplierBps: 15000,
    memberInputPrice: 6,
    memberOutputPrice: null,
    effectiveAt: new Date(),
  }),
  // v1.0.98 档位价优先：测试里统一命中通用秒价
  videoPricingForVariant: () => ({
    id: 1,
    unit: "video_second",
    variant: "",
    meterBase: 1,
    inputPrice: 0.04,
    outputPrice: 0,
    fxRateE8: 100_000_000n,
    multiplierBps: 15000,
    memberInputPrice: 6,
    memberOutputPrice: null,
    effectiveAt: new Date(),
  }),
  videoVariantFromBody: () => "720p:n",
  videoTaskMemberCredits: (_p: unknown, seconds: number) => Math.ceil(6 * seconds),
  pricingSnapshot: () => ({ priceVersionId: 1, priceSnapshot: "{}" }),
}));
vi.mock("@/lib/gateway/credits-gate", () => ({ minBalanceCreditsFor: () => 0 }));
vi.mock("@/lib/gateway/errors", () => ({
  apiError: (status: number, message: string, type: string, code: string, requestId?: string) =>
    new Response(JSON.stringify({ error: { message, type, code, request_id: requestId } }), { status }),
  // 路由统一走 gatewayError：同形响应，status/message/type 可覆盖，缺省 500
  gatewayError: (code: string, opts: { status?: number; message?: string; type?: string; requestId?: string } = {}) =>
    new Response(
      JSON.stringify({
        error: { message: opts.message ?? code, type: opts.type ?? "api_error", code, request_id: opts.requestId },
      }),
      { status: opts.status ?? 500 }
    ),
}));
vi.mock("@/lib/gateway/router", () => ({
  resolveRoute: async () => ({
    model: { id: 1, endpointType: "video" },
    endpoints: [{ path: "video_generations", enabled: true }],
    pricing: { id: 1, unit: "video_second" },
    vendor: { protocol: "openai" },
    candidates: [{ vendorKeyId: 1, apiBase: "http://mock", apiKey: "k" }],
  }),
}));
vi.mock("@/lib/gateway/gateway-routes", () => ({ requestGatewayBase: () => "http://localhost" }));
vi.mock("@/lib/gateway/video-task", () => ({
  runVideoTask: m.runVideoTask,
  unitsForTask: () => 5,
}));
vi.mock("@/lib/queue/video-queue", () => ({
  queueEnabled: () => false,
  enqueueVideoTask: async () => ({ ok: true }),
}));
vi.mock("@/lib/gateway/usage", () => ({ recordUsage: m.recordUsage }));
vi.mock("@/lib/quota", () => ({
  acquireSlot: () => ({ ok: true, release: () => {} }),
  checkKeyRpm: () => ({ ok: true }),
  checkQuota: async () => ({ ok: true }),
  getQuotaConfig: async () => ({ concurrency: 10 }),
}));

import { POST } from "@/app/v1/videos/route";

function makeReq(key = "K1") {
  return new NextRequest("http://localhost/v1/videos", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ model: "vid-model", prompt: "a cat", duration: 5 }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.findUnique.mockResolvedValue(null);
  m.ledgerFindUnique.mockResolvedValue(null);
  m.preDeduct.mockResolvedValue({ ok: true });
  m.refund.mockResolvedValue(undefined);
  m.count.mockResolvedValue(0);
  m.runVideoTask.mockResolvedValue(undefined);
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 1,
    createdAt: new Date(),
    ...data,
  }));
});

describe("POST /v1/videos 建任务失败回滚", () => {
  it("create 抛错 → 非 seedance 无预扣，退款为空操作 + 500，且不启动执行器", async () => {
    m.create.mockRejectedValueOnce(new Error("db down"));

    const res = await POST(makeReq());

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; request_id?: string } };
    expect(body.error.code).toBe("task_create_failed");
    // g19：非 seedance 视频不预扣；失败只调用一次 refund（内部因无预扣直接返回），净扣 0
    expect(m.preDeduct).not.toHaveBeenCalled();
    expect(m.refund).toHaveBeenCalledTimes(1);
    expect(m.refund).toHaveBeenCalledWith(7, "req-v1-video");
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.runVideoTask).not.toHaveBeenCalled();
    expect(m.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", paidCredits: 0, costMilli: 0 })
    );
  });

  it("并发同 Idempotency-Key 撞 P2002 → 幂等返回已有任务，绝不退款", async () => {
    m.findUnique
      .mockResolvedValueOnce(null) // 首次 existed 检查：还没建
      .mockResolvedValueOnce({
        id: 1,
        taskId: "vt-existing",
        requestId: "req-v1-video",
        status: "queued",
        progress: 0,
        createdAt: new Date(),
      });
    m.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { task_id: string };
    expect(body.task_id).toBe("vt-existing");
    // 同一个 requestId 的预扣已归属对方任务，退款会把对方任务退成免费
    expect(m.refund).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.runVideoTask).not.toHaveBeenCalled();
  });

  it("同 Key 上一轮已退款（decision=refund）→ 409，不预扣、不建任务、不二次退款", async () => {
    m.ledgerFindUnique.mockResolvedValueOnce({ requestId: "req-v1-video:decision", refId: "refund" });

    const res = await POST(makeReq());

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("idempotency_key_refunded");
    expect(m.preDeduct).not.toHaveBeenCalled();
    expect(m.refund).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  it("正常建任务 → 202，不退款、启动执行器一次", async () => {
    const res = await POST(makeReq("K2"));

    expect(res.status).toBe(202);
    expect(m.refund).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.runVideoTask).toHaveBeenCalledTimes(1);
  });
});
