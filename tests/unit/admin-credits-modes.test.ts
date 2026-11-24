import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── b12 后台额度调整三模式 ───
// ① 预览：increase / deduct / set 的前后值；② 覆盖仅超管；③ 扣减超过余额被拒；④ 备注必填

const m = vi.hoisted(() => ({
  state: {
    isSuper: false,
    // b13：二次验证是否已通过（false = 敏感接口应拒绝）
    needReauth: false,
    balance: 100n,
    adjustCalls: [] as any[],
    setCalls: [] as any[],
  },
}));

vi.mock("@/lib/db", () => ({
  db: { user: { findUnique: async () => ({ id: 7 }) } },
}));
vi.mock("@/lib/rbac", () => ({
  PERMISSIONS: { USER_WRITE: "user.write" },
  requirePerm: async () => ({ admin: { id: 1, isSuper: m.state.isSuper }, ok: true }),
  requireSensitivePerm: async () => ({
    admin: { id: 1, isSuper: m.state.isSuper },
    ok: true,
    needReauth: m.state.needReauth,
  }),
  reauthRequired: () =>
    new Response(JSON.stringify({ error: "敏感操作需二次验证", code: "REAUTH_REQUIRED" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }),
  logAdminAction: async () => {},
  getClientIp: async () => "127.0.0.1",
}));
vi.mock("@/lib/credits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/credits")>();
  return {
    ...actual,
    getBalance: async () => m.state.balance,
    adminAdjust: async (...args: any[]) => {
      m.state.adjustCalls.push(args);
      return { ok: true };
    },
    adminSetBalance: async (...args: any[]) => {
      m.state.setCalls.push(args);
      m.state.balance = args[1];
      return { ok: true };
    },
  };
});

import { GET, POST } from "@/app/api/admin/users/[id]/credits/route";

const ctx = { params: Promise.resolve({ id: "7" }) };
const get = (qs = "") => GET(new NextRequest(`http://x/api/admin/users/7/credits${qs}`), ctx);
const post = (body: unknown) =>
  POST(
    new NextRequest("http://x/api/admin/users/7/credits", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    ctx
  );

beforeEach(() => {
  m.state.isSuper = false;
  m.state.needReauth = false;
  m.state.balance = 100n;
  m.state.adjustCalls = [];
  m.state.setCalls = [];
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("GET 预览", () => {
  it("increase 预览：100 → 130", async () => {
    const res = await get("?mode=increase&amount=30");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      balance: 100,
      canOverride: false,
      preview: { ok: true, delta: 30, after: 130 },
    });
  });

  it("deduct 超过余额：预览标记不合法", async () => {
    const res = await get("?mode=deduct&amount=150");
    expect(await res.json()).toMatchObject({ preview: { ok: false, after: -50 } });
  });

  it("非超管请求 set 预览：403", async () => {
    const res = await get("?mode=set&amount=50");
    expect(res.status).toBe(403);
  });

  it("超管可预览 set：100 → 50", async () => {
    m.state.isSuper = true;
    const res = await get("?mode=set&amount=50");
    expect(await res.json()).toMatchObject({ canOverride: true, preview: { ok: true, after: 50 } });
  });
});

describe("POST 调整", () => {
  it("非超管提交 set：403 且不调账", async () => {
    const res = await post({ mode: "set", amount: 10, note: "清零" });
    expect(res.status).toBe(403);
    expect(m.state.setCalls).toHaveLength(0);
  });

  it("超管 set：写 adminSetBalance，返回调整前后", async () => {
    m.state.isSuper = true;
    const res = await post({ mode: "set", amount: 10, note: "测试覆盖" });
    expect(res.status).toBe(200);
    expect(m.state.setCalls[0][1]).toBe(10n);
    expect(await res.json()).toMatchObject({ ok: true, before: 100, after: 10 });
  });

  it("扣减超过余额：400 且不调账", async () => {
    const res = await post({ mode: "deduct", amount: 150, note: "测试" });
    expect(res.status).toBe(400);
    expect(m.state.adjustCalls).toHaveLength(0);
  });

  it("备注为空：400", async () => {
    const res = await post({ mode: "increase", amount: 10, note: "   " });
    expect(res.status).toBe(400);
    expect(m.state.adjustCalls).toHaveLength(0);
  });

  it("increase 正常：调用 adminAdjust 正数", async () => {
    const res = await post({ mode: "increase", amount: 20, note: "活动赠送" });
    expect(res.status).toBe(200);
    expect(m.state.adjustCalls[0][1]).toBe(20n);
  });

  it("b13 未通过二次验证：403 + REAUTH_REQUIRED 且不调账", async () => {
    m.state.needReauth = true;
    const res = await post({ mode: "increase", amount: 20, note: "活动赠送" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(m.state.adjustCalls).toHaveLength(0);
  });
});
