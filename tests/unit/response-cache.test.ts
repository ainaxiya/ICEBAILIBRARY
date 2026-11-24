import { describe, it, expect, afterAll } from "vitest";
import { db } from "@/lib/db";
import {
  beginIdempotentRequest,
  hasClientIdempotencyKey,
  releaseIdempotentRequest,
  saveIdempotentResponse,
} from "@/lib/gateway/response-cache";

// ─── 响应级幂等（v0.94）回归：只回放成功、执行中 409、失败可重试、过期重建 ───

let seq = 0;
function rid(tag: string): string {
  return `unit-idem-${tag}-${Date.now()}-${++seq}`;
}

afterAll(async () => {
  await db.$disconnect();
});

describe("响应级幂等", () => {
  it("未携带 Idempotency-Key 不登记（requestId 为随机 UUID，天然不去重）", async () => {
    expect(hasClientIdempotencyKey(new Request("http://x/v1/images/generations"))).toBe(false);
    expect(
      hasClientIdempotencyKey(
        new Request("http://x/v1/images/generations", { headers: { "Idempotency-Key": " k1 " } })
      )
    ).toBe(true);

    const r = rid("nokey");
    expect(await beginIdempotentRequest({ requestId: r, userId: 1, endpoint: "image_generations", keyed: false })).toEqual({
      kind: "none",
    });
    expect(await db.idempotencyRecord.findUnique({ where: { requestId: r } })).toBeNull();
  });

  it("首个请求 pending → 并发重复请求返回 in_progress（不并排再打上游）", async () => {
    const r = rid("dup");
    expect(await beginIdempotentRequest({ requestId: r, userId: 1, endpoint: "image_generations", keyed: true })).toEqual({
      kind: "none",
    });
    const second = await beginIdempotentRequest({ requestId: r, userId: 1, endpoint: "image_generations", keyed: true });
    expect(second.kind).toBe("in_progress");
  });

  it("成功后同 Key 重试直接回放原响应体，且再次 begin 不再登记", async () => {
    const r = rid("replay");
    await beginIdempotentRequest({ requestId: r, userId: 1, endpoint: "image_generations", keyed: true });
    const body = { created: 1, data: [{ url: "https://cdn/x.png", asset_id: "9" }] };
    await saveIdempotentResponse(r, 200, body);

    const replay = await beginIdempotentRequest({ requestId: r, userId: 1, endpoint: "image_generations", keyed: true });
    expect(replay).toMatchObject({ kind: "replay", status: 200 });
    if (replay.kind === "replay") expect(replay.body).toEqual(body);
  });

  it("失败释放后同 Key 可重新执行（失败不缓存）", async () => {
    const r = rid("release");
    await beginIdempotentRequest({ requestId: r, userId: 1, endpoint: "image_generations", keyed: true });
    await releaseIdempotentRequest(r);
    expect(await beginIdempotentRequest({ requestId: r, userId: 1, endpoint: "image_generations", keyed: true })).toEqual({
      kind: "none",
    });
  });

  it("已完成记录过期后视为新请求（重新生成、重新计费）", async () => {
    const r = rid("expired");
    await beginIdempotentRequest({ requestId: r, userId: 1, endpoint: "image_generations", keyed: true });
    await saveIdempotentResponse(r, 200, { ok: 1 });
    await db.idempotencyRecord.update({
      where: { requestId: r },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await beginIdempotentRequest({ requestId: r, userId: 1, endpoint: "image_generations", keyed: true })).toEqual({
      kind: "none",
    });
  });

  it("超大响应不缓存（避免 base64 / 长向量撑爆库）", async () => {
    const r = rid("huge");
    await beginIdempotentRequest({ requestId: r, userId: 1, endpoint: "embeddings", keyed: true });
    await saveIdempotentResponse(r, 200, { blob: "x".repeat(300 * 1024) });
    expect(await db.idempotencyRecord.findUnique({ where: { requestId: r } })).toBeNull();
  });
});
