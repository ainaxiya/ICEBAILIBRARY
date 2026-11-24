import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── v2「获取全部模型」收敛：预览口径 + 勾选入库口径 ───
// ① 预览只把「可用且未入库」算候选；已在库 / 不可用分别计数
// ② 预览的下线计数与入库动作同口径：Retiring（待下线）不自动标记下线
// ③ 勾选入库只创建被勾选的可用新模型；已在库不覆盖；不可用已在库才置 offline

const m = vi.hoisted(() => ({
  keyFindUnique: vi.fn(),
  modelFindUnique: vi.fn(),
  modelCreate: vi.fn(),
  modelUpdate: vi.fn(),
  endpointCreate: vi.fn(),
  modelCount: vi.fn(),
  modelFindMany: vi.fn(),
  fxFindUnique: vi.fn(),
  existing: new Map<string, { id: number; status: string; endpointType: string }>(),
  nextId: 100,
}));

vi.mock("@/lib/auth", () => ({ requireAdmin: async () => ({ id: 1, isSuper: true }) }));
vi.mock("@/lib/rbac", () => ({
  PERMISSIONS: { MODELS_WRITE: "models:write" },
  requirePerm: async () => ({ user: { id: 1 }, ok: true }),
  logAdminAction: async () => {},
  getClientIp: async () => "127.0.0.1",
}));
vi.mock("@/lib/crypto", () => ({ decryptSecret: () => "sk-test" }));
vi.mock("@/lib/db", () => ({
  db: {
    vendorApiKey: { findUnique: m.keyFindUnique },
    aiModel: {
      findUnique: m.modelFindUnique,
      create: m.modelCreate,
      update: m.modelUpdate,
      count: m.modelCount,
      findMany: m.modelFindMany,
    },
    modelEndpoint: { create: m.endpointCreate },
    fxRate: { findUnique: m.fxFindUnique },
  },
}));

// 上游 /models 清单：覆盖 可用未入库 / 已在库 / 不可用已在库 / 待下线已在库 / 不可用未入库
const UPSTREAM = [
  { id: "gpt-ok", object: "model", owned_by: "openai" },
  { id: "gpt-exist", object: "model", owned_by: "openai" },
  { id: "gpt-new-unselected", object: "model", owned_by: "openai" },
  { id: "gpt-dead", object: "model", owned_by: "openai", status: "Unavailable" },
  { id: "gpt-retire", object: "model", owned_by: "openai", status: "Retiring" },
  { id: "gpt-off", object: "model", owned_by: "openai", status: "Unavailable" },
];

const fetchMock = vi.fn(async (input: any) => {
  const url = String(input);
  if (url.includes("type=video")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
  if (url.endsWith("/models")) return new Response(JSON.stringify({ object: "list", data: UPSTREAM }), { status: 200 });
  return new Response("not found", { status: 404 });
});

async function callGet() {
  const { GET } = await import("@/app/api/admin/models/keys/[id]/fetch-models/route");
  return GET(new NextRequest("http://localhost/api/admin/models/keys/1/fetch-models"), {
    params: Promise.resolve({ id: "1" }),
  });
}

async function callPost(body: unknown) {
  const { POST } = await import("@/app/api/admin/models/keys/[id]/fetch-models/route");
  return POST(
    new NextRequest("http://localhost/api/admin/models/keys/1/fetch-models", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: "1" }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  m.existing.clear();
  m.existing.set("gpt-exist", { id: 11, status: "online", endpointType: "chat" });
  m.existing.set("gpt-dead", { id: 12, status: "online", endpointType: "chat" });
  m.existing.set("gpt-retire", { id: 13, status: "online", endpointType: "chat" });
  m.nextId = 100;

  m.keyFindUnique.mockResolvedValue({
    id: 1,
    keyPrefix: "sk-xx",
    keyCipher: "cipher",
    vendorId: 10,
    vendor: { id: 10, name: "TestVendor", apiBase: "https://api.test.local/v1" },
  });
  m.modelFindUnique.mockImplementation(async ({ where }: any) => {
    const hit = m.existing.get(where.vendorId_name.name);
    return hit ? { ...hit, vendorId: 10, name: where.vendorId_name.name } : null;
  });
  m.modelCreate.mockImplementation(async ({ data }: any) => ({ id: m.nextId++, ...data }));
  m.modelUpdate.mockResolvedValue({});
  m.endpointCreate.mockResolvedValue({});
  m.modelCount.mockResolvedValue(3);
  m.modelFindMany.mockResolvedValue([]);
  m.fxFindUnique.mockResolvedValue(null);
  vi.stubGlobal("fetch", fetchMock);
});

describe("v2 获取全部模型：预览收敛", () => {
  it("候选只含可用且未入库；已在库/不可用分别计数；Retiring 不计入下线", async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const d = await res.json();

    expect(d.total).toBe(6);
    // 候选 = 可用且未入库：gpt-ok（勾选）+ gpt-new-unselected（可用但未勾选）
    expect(d.counts.candidates).toBe(2);
    expect(d.counts.available).toBe(3);
    expect(d.counts.inDb).toBe(3);
    expect(d.counts.skippedUnavailable).toBe(1);
    // gpt-dead 计入；gpt-retire（Retiring）不计入，与 POST 实际动作一致
    expect(d.counts.toDeactivate).toBe(1);
    expect(d.candidates.map((i: any) => i.name)).toEqual(["gpt-ok", "gpt-new-unselected"]);

    const byName = Object.fromEntries(d.items.map((i: any) => [i.name, i]));
    expect(byName["gpt-ok"]).toMatchObject({ available: true, inDb: false });
    expect(byName["gpt-exist"]).toMatchObject({ available: true, inDb: true });
    expect(byName["gpt-dead"]).toMatchObject({ available: false, inDb: true, unavailableReason: "status_unavailable" });
    expect(byName["gpt-retire"]).toMatchObject({ available: false, inDb: true, unavailableReason: "retiring" });
    expect(byName["gpt-off"]).toMatchObject({ available: false, inDb: false });
  });
});

describe("v2 获取全部模型：勾选入库", () => {
  it("只创建勾选的可用新模型，已有不覆盖，不可用已在库才置下线", async () => {
    const res = await callPost({ names: ["gpt-ok"] });
    expect(res.status).toBe(200);
    const d = await res.json();

    expect(d.created).toBe(1);
    expect(d.kept).toBe(2);
    expect(d.deactivated).toBe(1);
    expect(d.skipped).toBe(1);
    expect(d.unselected).toBe(1);

    // 只新建勾选的 gpt-ok
    expect(m.modelCreate).toHaveBeenCalledTimes(1);
    expect(m.modelCreate.mock.calls[0][0].data.name).toBe("gpt-ok");
    expect(m.endpointCreate).toHaveBeenCalledTimes(1);

    // 已有模型只在「不可用且非 Retiring」时更新状态，且只改 status
    expect(m.modelUpdate).toHaveBeenCalledTimes(1);
    expect(m.modelUpdate.mock.calls[0][0].where.id).toBe(12);
    expect(m.modelUpdate.mock.calls[0][0].data).toEqual({ status: "offline" });

    const byName = Object.fromEntries(d.items.map((i: any) => [i.name, i]));
    expect(byName["gpt-exist"].state).toBe("kept");
    expect(byName["gpt-retire"].state).toBe("kept");
    expect(byName["gpt-dead"].state).toBe("deactivated");
    expect(byName["gpt-off"].state).toBe("skipped");
    expect(byName["gpt-new-unselected"].state).toBe("unselected");
  });
});
