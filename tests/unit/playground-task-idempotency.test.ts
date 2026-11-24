import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── L2 站内媒体任务幂等：重复提交返回同一任务，绝不退款 ───
// 只 mock 外部依赖（登录/DB/计费/配额/路由解析/媒体参数）；幂等键用真实实现，
// 以便同时验证 L1 的「同 Key 同 body 命中、换 body 不命中」。

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  count: vi.fn(),
  preDeduct: vi.fn(),
  refund: vi.fn(),
  startMediaTask: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({ id: 7, status: "active" }),
  getActiveUser: async () => ({ user: { id: 7, status: "active" }, state: "ok" }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    playgroundMediaTask: { findUnique: m.findUnique, create: m.create, count: m.count },
    playgroundSession: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 99, ...data })),
      update: vi.fn(async () => ({})),
    },
    playgroundMessage: {
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
      createMany: vi.fn(async () => ({ count: 2 })),
    },
  },
}));
vi.mock("@/lib/gateway/billing", () => ({
  billing: {
    preCheck: async () => ({ ok: true }),
    preDeduct: m.preDeduct,
    settle: async () => {},
    refund: m.refund,
  },
}));
vi.mock("@/lib/gateway/pricing", () => ({ displayMemberCredits: () => 10 }));
vi.mock("@/lib/quota", () => ({ checkQuota: async () => ({ ok: true }) }));
vi.mock("@/lib/gateway/router", () => ({
  resolveRoute: async () => ({
    model: { id: 1, endpointType: "image" },
    endpoints: [{ path: "image_generations", enabled: true }],
    pricing: { unit: "image" },
    candidates: [{ vendorKeyId: 1, apiBase: "http://mock", apiKey: "k" }],
  }),
}));
vi.mock("@/lib/playground/media-spec", () => ({
  imageSize: () => "1024x1024",
  imageSpecFor: () => ({ resolutions: ["1080"], ratios: ["16:9"] }),
  isImageRatio: () => true,
  isImageResolution: () => true,
  videoSizeFor: () => "1280x720",
}));
vi.mock("@/lib/playground/media-task-runner", () => ({
  creditsFromQuoteUsd: () => 1,
  fetchVideoQuote: async () => ({ ok: false }),
  startMediaTask: m.startMediaTask,
  toTaskView: (t: { taskId: string; status: string }) => ({ taskId: t.taskId, status: t.status }),
}));

import { POST } from "@/app/api/playground/tasks/route";

const BODY = {
  model: "img-model",
  kind: "image",
  prompt: "a cat",
  params: { resolution: "1080", aspect_ratio: "16:9", n: 1 },
};

function makeReq(key?: string, body: unknown = BODY) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["idempotency-key"] = key;
  return new NextRequest("http://localhost/api/playground/tasks", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.findUnique.mockResolvedValue(null);
  m.count.mockResolvedValue(0);
  m.preDeduct.mockResolvedValue({ ok: true });
  m.refund.mockResolvedValue(undefined);
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 1,
    createdAt: new Date(),
    ...data,
  }));
});

describe("POST /api/playground/tasks 幂等（L2）", () => {
  it("重复提交同一 Key + 同一 body → 返回已有任务，不重复扣费、不退款", async () => {
    const r1 = await POST(makeReq("K1"));
    expect(r1.status).toBe(201);
    const t1 = ((await r1.json()) as { task: { taskId: string } }).task;
    // g19：图片不再预扣，成功后按实际消费扣；这里只验证幂等，不产生预扣/退款
    expect(m.preDeduct).not.toHaveBeenCalled();

    // 第二次：库里已有该 requestId 的任务（已完成并结算）
    m.findUnique.mockResolvedValueOnce({ id: 1, taskId: t1.taskId, status: "succeeded" });
    const r2 = await POST(makeReq("K1"));
    expect(r2.status).toBe(200);
    const t2 = ((await r2.json()) as { task: { taskId: string } }).task;
    expect(t2.taskId).toBe(t1.taskId);

    expect(m.preDeduct).not.toHaveBeenCalled(); // 图片没有预扣
    expect(m.create).toHaveBeenCalledTimes(1); // 没有第二次落库
    expect(m.refund).not.toHaveBeenCalled(); // 关键：不产生退款流水
    expect(m.startMediaTask).toHaveBeenCalledTimes(1);
  });

  it("并发重复提交（P2002 唯一冲突）→ 幂等返回已有任务，不退款", async () => {
    const existing = { id: 2, taskId: "mt-dup", status: "succeeded" };
    m.findUnique.mockResolvedValueOnce(null); // 预检未命中（另一请求尚未提交）
    m.findUnique.mockResolvedValueOnce(existing); // 冲突后回查命中
    m.create.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));

    const res = await POST(makeReq("K2"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { taskId: string } };
    expect(body.task.taskId).toBe("mt-dup");
    expect(m.refund).not.toHaveBeenCalled();
  });

  it("真正的落库失败（非 P2002）→ 仍然退款并返回 500", async () => {
    m.create.mockRejectedValueOnce(Object.assign(new Error("db down"), { code: "P1001" }));
    const res = await POST(makeReq("K3"));
    expect(res.status).toBe(500);
    expect(m.refund).toHaveBeenCalledTimes(1);
  });

  it("同一 Key 换 Prompt → 幂等键不同，按新请求扣费（L1 联动）", async () => {
    await POST(makeReq("K4"));
    const ridA = (m.findUnique.mock.calls[0][0] as { where: { requestId: string } }).where.requestId;

    await POST(makeReq("K4", { ...BODY, prompt: "a dog" }));
    const ridB = (m.findUnique.mock.calls[1][0] as { where: { requestId: string } }).where.requestId;

    expect(ridA).not.toBe(ridB);
    expect(m.preDeduct).not.toHaveBeenCalled(); // g19：图片不预扣
    expect(m.refund).not.toHaveBeenCalled();
  });

  it("未带 Idempotency-Key → 每次都是新请求（幂等键随机，不误判重复）", async () => {
    await POST(makeReq());
    await POST(makeReq());
    const ridA = (m.findUnique.mock.calls[0][0] as { where: { requestId: string } }).where.requestId;
    const ridB = (m.findUnique.mock.calls[1][0] as { where: { requestId: string } }).where.requestId;
    expect(ridA).not.toBe(ridB);
    expect(m.preDeduct).not.toHaveBeenCalled(); // g19：图片不预扣
  });
});
