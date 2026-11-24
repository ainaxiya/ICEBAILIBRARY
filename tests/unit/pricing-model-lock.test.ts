import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── 计价口径防回归：计价只能锁客户端请求的模型名 ───
// 规则（用户拍板）：
//   1) 计价入口只按 body.model 精确查 AiModel.name，不做「模型名 → 厂商/上游名」换名；
//   2) 定价只取命中那一行模型自己的 ModelPricing，不能借用别的模型/厂商的价格；
//   3) displayName 不是请求名，用它请求必须 model_not_found，不能反查成功。
// 这里直接 mock 数据层，锁住 resolveRoute 的查询条件与取价来源。

const h = vi.hoisted(() => ({
  findAiModel: vi.fn(),
  findKeys: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    aiModel: { findFirst: (args: unknown) => h.findAiModel(args) },
    vendorApiKey: { findMany: (args: unknown) => h.findKeys(args) },
  },
}));

import { resolveRoute } from "@/lib/gateway/router";

function pricingRow(id: number, price: number, effectiveAt: Date) {
  return {
    id,
    modelId: 1,
    variant: "",
    meterBase: 1_000_000,
    unit: "token",
    inputPrice: price,
    outputPrice: price,
    currency: "CNY",
    fxRateE8: 100_000_000,
    multiplierBps: 10_000,
    memberInputPrice: null,
    memberOutputPrice: null,
    effectiveAt,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

const DAY = 24 * 60 * 60 * 1000;

function modelRow(name: string, pricings: ReturnType<typeof pricingRow>[]) {
  return {
    id: 1,
    vendorId: 1,
    name,
    displayName: "给用户看的展示名",
    endpointType: "chat",
    status: "online",
    capabilities: null,
    advancedConfig: null,
    remark: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    vendor: { id: 1, name: "测试厂商", slug: "test", apiBase: "https://example.com", protocol: "openai", status: "active" },
    endpoints: [{ id: 1, modelId: 1, path: "chat_completions", enabled: true }],
    pricings,
  };
}

describe("计价锁定客户端请求模型名", () => {
  beforeEach(() => {
    h.findAiModel.mockReset();
    h.findKeys.mockReset();
    h.findKeys.mockResolvedValue([]);
  });

  it("按原始请求模型名精确查 AiModel.name，且不按 displayName 反查", async () => {
    const row = modelRow("client-requested-model", [
      pricingRow(11, 2, new Date(Date.now() - DAY)),
    ]);
    h.findAiModel.mockResolvedValue(row);

    const route = await resolveRoute("client-requested-model");

    expect(route).not.toBeNull();
    const args = h.findAiModel.mock.calls[0][0] as {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
    };
    // 只认客户端原始模型名（= 上游名），不允许出现 displayName / 别名查询
    expect(args.where).toEqual({ name: "client-requested-model", status: "online" });
    // 同名多厂商时固定取最小 id，避免价格随执行计划漂移
    expect(args.orderBy).toEqual({ id: "asc" });
    expect(args.where).not.toHaveProperty("displayName");
  });

  it("定价只取命中模型自己的最新生效行，不跨模型借用", async () => {
    const row = modelRow("client-requested-model", [
      pricingRow(11, 1, new Date(Date.now() - 2 * DAY)),
      pricingRow(12, 9, new Date(Date.now() - DAY)),
    ]);
    h.findAiModel.mockResolvedValue(row);

    const route = await resolveRoute("client-requested-model");

    expect(route?.pricing?.id).toBe(12);
    expect(Number(route?.pricing?.inputPrice)).toBe(9);
    // 定价来自该模型行的 pricings，而不是别的模型/厂商映射
    expect(route?.pricings.map((p) => p.id)).toEqual([11, 12]);
  });

  it("用展示名请求必须查不到（404），不能映射回真实模型", async () => {
    // 数据层严格按 name 匹配：展示名查不到就返回 null
    h.findAiModel.mockResolvedValue(null);

    const route = await resolveRoute("给用户看的展示名");

    expect(route).toBeNull();
    const args = h.findAiModel.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(args.where).toEqual({ name: "给用户看的展示名", status: "online" });
  });

  it("下线模型不参与计价路由", async () => {
    h.findAiModel.mockResolvedValue(null);
    const route = await resolveRoute("offline-model");
    expect(route).toBeNull();
    expect((h.findAiModel.mock.calls[0][0] as { where: Record<string, unknown> }).where).toEqual({
      name: "offline-model",
      status: "online",
    });
  });
});
