import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { creditBilling } from "@/lib/gateway/billing";
import { grant, getBalance } from "@/lib/credits";
import { resolveRequestId } from "@/lib/gateway/idempotency";

// ─── L1 回归（直连 prompthub_test 测试库）：幂等键必须区分端点/请求内容 ───
// 验证「同一把 Idempotency-Key 先打廉价 chat、再打生图」不再复用旧扣费流水，
// 同时「同一次请求的网络重试」仍然只扣一次。

let uid: number;

beforeAll(async () => {
  const user = await db.user.upsert({
    where: { username: "unit-idem-scope-user" },
    update: { status: "active" },
    create: { username: "unit-idem-scope-user", passwordHash: "x", status: "active" },
  });
  uid = user.id;
  await grant(uid, "trial", 100000n, "unit-idem-scope-fixture").catch(() => {});
});

afterAll(async () => {
  await db.$disconnect();
});

function req(key: string) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
  });
}

describe("幂等键绑定端点/请求体（L1）", () => {
  it("同一 Key 跨端点：各自独立预扣，不再复用旧流水", async () => {
    const key = `K-cross-${Date.now()}`;
    const chatId = resolveRequestId(uid, req(key), {
      endpoint: "chat.completions",
      model: "model-a",
      body: { model: "model-a", messages: [{ role: "user", content: "hi" }] },
    });
    const imageId = resolveRequestId(uid, req(key), {
      endpoint: "image_generations",
      model: "model-b",
      body: { model: "model-b", prompt: "a cat", n: 1 },
    });
    expect(chatId).not.toBe(imageId);

    const before = await getBalance(uid);
    expect((await creditBilling.preDeduct(uid, 1, chatId)).ok).toBe(true);
    expect((await creditBilling.preDeduct(uid, 100, imageId)).ok).toBe(true);
    expect(before - (await getBalance(uid))).toBe(101n);

    const rows = await db.creditLedger.findMany({ where: { requestId: { in: [chatId, imageId] } } });
    expect(rows.length).toBe(2);
  });

  it("同一次请求重试：同一 requestId，只扣一次", async () => {
    const key = `K-retry-${Date.now()}`;
    const scope = { endpoint: "image_generations", model: "model-b", body: { model: "model-b", prompt: "a cat" } };
    const id1 = resolveRequestId(uid, req(key), scope);
    const id2 = resolveRequestId(uid, req(key), scope); // 客户端网络重试（同 body）
    expect(id2).toBe(id1);

    const before = await getBalance(uid);
    expect((await creditBilling.preDeduct(uid, 40, id1)).ok).toBe(true);
    expect((await creditBilling.preDeduct(uid, 40, id2)).ok).toBe(true);
    expect(before - (await getBalance(uid))).toBe(40n);

    const rows = await db.creditLedger.findMany({ where: { requestId: id1 } });
    expect(rows.length).toBe(1);
  });

  it("同一 Key 换请求参数：视为新请求，按新预估独立扣费", async () => {
    const key = `K-param-${Date.now()}`;
    const base = { endpoint: "image_generations", model: "model-b" };
    const id1 = resolveRequestId(uid, req(key), { ...base, body: { prompt: "a cat", n: 1 } });
    const id2 = resolveRequestId(uid, req(key), { ...base, body: { prompt: "a cat", n: 2 } });
    expect(id2).not.toBe(id1);

    const before = await getBalance(uid);
    expect((await creditBilling.preDeduct(uid, 10, id1)).ok).toBe(true);
    expect((await creditBilling.preDeduct(uid, 20, id2)).ok).toBe(true);
    expect(before - (await getBalance(uid))).toBe(30n);
  });
});
