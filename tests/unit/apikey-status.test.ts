import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { createApiKey, revokeApiKey, setApiKeyDisabled, verifyApiKey } from "@/lib/apikey";

// ─── b2：Key 行内启停（直连 prompthub_test） ───
// active ↔ disabled 可恢复；revoked 为终态，不能再启用，鉴权提示区分停用与吊销。

let uid: number;

beforeAll(async () => {
  const user = await db.user.upsert({
    where: { username: "unit-apikey-status-user" },
    update: { status: "active" },
    create: { username: "unit-apikey-status-user", passwordHash: "x", status: "active" },
  });
  uid = user.id;
  await db.userApiKey.deleteMany({ where: { userId: uid } });
});

afterAll(async () => {
  await db.userApiKey.deleteMany({ where: { userId: uid } });
  await db.$disconnect();
});

describe("b2 Key 行内启停", () => {
  it("active → disabled → active，吊销后不可再启用", async () => {
    const k = await createApiKey(uid, null, "b2-test");
    expect((await verifyApiKey(k.plaintext)).ok).toBe(true);

    expect(await setApiKeyDisabled(k.id, uid, true)).toBe(true);
    const disabled = await verifyApiKey(k.plaintext);
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error).toContain("disabled");

    expect(await setApiKeyDisabled(k.id, uid, false)).toBe(true);
    expect((await verifyApiKey(k.plaintext)).ok).toBe(true);

    expect(await revokeApiKey(k.id, uid)).toBe(true);
    expect(await setApiKeyDisabled(k.id, uid, true)).toBe(false);
    const revoked = await verifyApiKey(k.plaintext);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.error).toContain("revoked");
  });

  it("不能操作他人的 Key", async () => {
    const k = await createApiKey(uid, null, "b2-owner");
    expect(await setApiKeyDisabled(k.id, uid + 100000, true)).toBe(false);
    expect(await revokeApiKey(k.id, uid + 100000)).toBe(false);
  });
});
