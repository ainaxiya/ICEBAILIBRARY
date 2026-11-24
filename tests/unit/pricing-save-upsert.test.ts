import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── POST /api/admin/models/models/[id]/pricing ───
// ① 同参数连续两次提交：不报 500，只有一行，结果幂等（upsert 而不是无脑 create）
// ② 同档位不同生效时刻：仍然新增历史行，键形不变
// ③ 整组档位一次提交：单事务写入，全部成功
// ④ 整组中途失败：500 且一行都没落库（全回滚）

const m = vi.hoisted(() => {
  const state = {
    rows: [] as any[],
    seq: 0,
    // 指定该档位写入时抛错，用于验证事务回滚
    failVariant: null as string | null,
  };

  const modelPricing = {
    findFirst: async ({ where, orderBy }: any) => {
      let list = state.rows.filter(
        (r) =>
          r.modelId === where.modelId &&
          (where.variant === undefined || r.variant === where.variant)
      );
      if (orderBy?.effectiveAt === "desc") {
        list = [...list].sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime());
      }
      return list[0] ?? null;
    },
    upsert: async ({ where, create, update }: any) => {
      const key = where.modelId_variant_effectiveAt;
      if (state.failVariant && key.variant === state.failVariant) {
        throw new Error("simulated db failure");
      }
      const idx = state.rows.findIndex(
        (r) =>
          r.modelId === key.modelId &&
          r.variant === key.variant &&
          r.effectiveAt.getTime() === key.effectiveAt.getTime()
      );
      // 唯一键命中 → 原地更新（createdAt 不变，历史行不翻倍）
      if (idx >= 0) {
        state.rows[idx] = { ...state.rows[idx], ...update };
        return state.rows[idx];
      }
      const row = { id: ++state.seq, createdAt: new Date(), ...create };
      state.rows.push(row);
      return row;
    },
  };

  const transaction = async (fn: (tx: any) => Promise<any>) => {
    const snapshot = state.rows.map((r) => ({ ...r }));
    try {
      return await fn({ modelPricing });
    } catch (e) {
      // 模拟数据库事务回滚：恢复到事务开始前
      state.rows.length = 0;
      state.rows.push(...snapshot);
      throw e;
    }
  };

  return { state, modelPricing, transaction };
});

vi.mock("@/lib/auth", () => ({ requireAdmin: async () => ({ id: 1 }) }));
vi.mock("@/lib/db", () => ({
  db: {
    modelPricing: m.modelPricing,
    aiModel: {
      findUnique: async () => ({ id: 207, name: "doubao-seedance-2-5-flash-261115" }),
    },
    $transaction: m.transaction,
  },
}));
vi.mock("@/lib/rbac", () => ({
  PERMISSIONS: { MODELS_READ: "models.read", MODELS_WRITE: "models.write" },
  requirePerm: async () => ({ user: { id: 1 }, ok: true }),
  logAdminAction: async () => {},
  getClientIp: async () => "127.0.0.1",
}));

import { POST } from "@/app/api/admin/models/models/[id]/pricing/route";

const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/admin/models/models/207/pricing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "207" }) }
  );

const row = (over: Record<string, unknown> = {}) => ({
  inputPrice: 1,
  outputPrice: 0,
  variant: "720p:n",
  unit: "video_second",
  meterBase: 1,
  memberInputPrice: 122,
  memberOutputPrice: null,
  currency: "CNY",
  fxRateE8: 100_000_000,
  multiplierBps: 16600,
  effectiveAt: "2026-11-19T04:30:00.000Z",
  ...over,
});

describe("POST /api/admin/models/models/[id]/pricing（upsert 幂等 + 整组事务）", () => {
  beforeEach(() => {
    m.state.rows.length = 0;
    m.state.seq = 0;
    m.state.failVariant = null;
  });

  it("同参数连续两次提交：两次都 200，只有一行，返回同一 id", async () => {
    const r1 = await post(row());
    const r2 = await post(row());
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    expect(m.state.rows).toHaveLength(1);
    const j1 = await r1.json();
    const j2 = await r2.json();
    expect(j1.pricing.id).toBe(j2.pricing.id);
    expect(j2.pricing.inputPrice).toBe(1);
    expect(j2.pricing.memberInputPrice).toBe(122);
    expect(j2.pricing.variant).toBe("720p:n");
  });

  it("同档位不同生效时刻：新增历史行，键形不变", async () => {
    await post(row());
    const r2 = await post(row({ effectiveAt: "2026-11-19T04:31:00.000Z", inputPrice: 1.2 }));
    expect(r2.status).toBe(200);
    expect(m.state.rows).toHaveLength(2);
    expect(m.state.rows.map((x) => x.variant)).toEqual(["720p:n", "720p:n"]);
  });

  it("非视频单位重复提交：写通用键且幂等", async () => {
    const tokenBody = {
      inputPrice: 0.8,
      outputPrice: 2.7,
      variant: "",
      unit: "token",
      meterBase: 1_000_000,
      memberInputPrice: 120,
      memberOutputPrice: 320,
      effectiveAt: "2026-11-19T05:00:00.000Z",
    };
    expect((await post(tokenBody)).status).toBe(200);
    expect((await post(tokenBody)).status).toBe(200);
    expect(m.state.rows).toHaveLength(1);
    expect(m.state.rows[0].variant).toBe("");
    expect(m.state.rows[0].meterBase).toBe(1_000_000);
  });

  it("整组档位一次提交：全部写入且保留老键形", async () => {
    const res = await post({
      rows: [
        row({ variant: "480p:n", inputPrice: 0.45, memberInputPrice: 50 }),
        row({ variant: "480p:v", inputPrice: 1.89, memberInputPrice: 210 }),
        row({ variant: "720p:v", inputPrice: 4.24, memberInputPrice: 455 }),
      ],
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.count).toBe(3);
    expect(m.state.rows.map((x) => x.variant)).toEqual(["480p:n", "480p:v", "720p:v"]);
    expect(m.state.rows.map((x) => x.inputPrice)).toEqual([0.45, 1.89, 4.24]);
  });

  it("整组中途失败：500 且一行都没写入（全回滚）", async () => {
    m.state.failVariant = "720p:n";
    const res = await post({
      rows: [
        row({ variant: "480p:n", inputPrice: 0.45 }),
        row({ variant: "480p:v", inputPrice: 1.89 }),
        row({ variant: "720p:n", inputPrice: 1 }),
      ],
    });
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j.error).toContain("未写入");
    expect(m.state.rows).toHaveLength(0);
  });

  it("整组重复提交同一批参数：幂等，不新增行", async () => {
    const body = {
      rows: [
        row({ variant: "480p:n", inputPrice: 0.45 }),
        row({ variant: "480p:v", inputPrice: 1.89 }),
      ],
    };
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200);
    expect(m.state.rows).toHaveLength(2);
  });

  it("整组 rows 为空：400，不写库", async () => {
    const res = await post({ rows: [] });
    expect(res.status).toBe(400);
    expect(m.state.rows).toHaveLength(0);
  });
});
