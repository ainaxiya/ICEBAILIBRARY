import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { apiKeyAllowsModel, createApiKey, normalizeAllowedModels, verifyApiKey } from "@/lib/apikey";
import { isModelAllowedForAuth } from "@/lib/gateway/model-access";
import type { V1Auth } from "@/lib/gateway/auth";

// ─── b1 Key 模型白名单 ───
// 口径：空白名单 = 不限制；命中才允许；站内登录态不受白名单约束。

function okAuth(over: Partial<Extract<V1Auth, { ok: true }>>): Extract<V1Auth, { ok: true }> {
  return {
    ok: true,
    user: { id: 1 } as Extract<V1Auth, { ok: true }>["user"],
    channel: "apikey",
    apiKeyId: 1,
    allowedModels: [],
    ...over,
  };
}

let uid = 0;

beforeAll(async () => {
  const user = await db.user.upsert({
    where: { username: "unit-apikey-model-user" },
    update: { status: "active" },
    create: { username: "unit-apikey-model-user", passwordHash: "x", status: "active" },
  });
  uid = user.id;
  const stale = await db.userApiKey.findMany({ where: { userId: uid }, select: { id: true } });
  if (stale.length) {
    await db.apiKeyQuotaHold.deleteMany({ where: { apiKeyId: { in: stale.map((k) => k.id) } } });
  }
  await db.userApiKey.deleteMany({ where: { userId: uid } });
});

afterAll(async () => {
  await db.userApiKey.deleteMany({ where: { userId: uid } });
  await db.$disconnect();
});

describe("b1 模型白名单", () => {
  it("归一化：去空、去重、去首尾空格、上限 100 条", () => {
    expect(normalizeAllowedModels([" gpt-4o ", "gpt-4o", "", "  ", "claude"])).toEqual([
      "gpt-4o",
      "claude",
    ]);
    expect(normalizeAllowedModels(null)).toEqual([]);
    const many = Array.from({ length: 150 }, (_, i) => `m-${i}`);
    expect(normalizeAllowedModels(many)).toHaveLength(100);
  });

  it("判定：空白名单放行全部，非空只放行命中项", () => {
    expect(apiKeyAllowsModel([], "anything")).toBe(true);
    expect(apiKeyAllowsModel(null, "anything")).toBe(true);
    expect(apiKeyAllowsModel(["a", "b"], "a")).toBe(true);
    expect(apiKeyAllowsModel(["a", "b"], "c")).toBe(false);
  });

  it("鉴权层：站外 Key 白名单不命中即拒绝，站内登录态不受限", () => {
    expect(isModelAllowedForAuth(okAuth({ allowedModels: ["a"] }), "a")).toBe(true);
    expect(isModelAllowedForAuth(okAuth({ allowedModels: ["a"] }), "b")).toBe(false);
    expect(isModelAllowedForAuth(okAuth({ allowedModels: ["a"] }), "")).toBe(false);
    expect(isModelAllowedForAuth(okAuth({ allowedModels: [] }), "b")).toBe(true);
    expect(
      isModelAllowedForAuth(
        okAuth({ channel: "onsite", apiKeyId: null, allowedModels: ["a"] }),
        "b"
      )
    ).toBe(true);
  });

  it("落库与校验：创建带白名单，verifyApiKey 原样带回", async () => {
    const created = await createApiKey(uid, null, "allowlist", null, ["gpt-4o", "gpt-4o", " claude "]);
    expect(created.allowedModels).toEqual(["gpt-4o", "claude"]);
    const verified = await verifyApiKey(created.plaintext);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.key.allowedModels).toEqual(["gpt-4o", "claude"]);
  });

  it("不传白名单：落库为空数组（= 不限制）", async () => {
    const created = await createApiKey(uid, null, "no-allowlist");
    expect(created.allowedModels).toEqual([]);
  });
});
