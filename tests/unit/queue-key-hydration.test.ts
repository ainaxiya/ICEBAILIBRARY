import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── g14：队列只传 vendorKeyId，Worker 消费时按 id 从库中解密 ───
// 这里验证复原函数：顺序保持、非 active / 解密失败跳过、空入参不查库。

const m = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { vendorApiKey: { findMany: m.findMany } },
}));

import { loadKeyCandidatesByIds } from "@/lib/gateway/router";
import { encryptSecret } from "@/lib/crypto";

function keyRow(id: number, opts: { status?: string; cipher?: string } = {}) {
  return {
    id,
    name: `key-${id}`,
    vendorId: 9,
    keyCipher: opts.cipher ?? encryptSecret(`sk-live-${id}`),
    status: opts.status ?? "active",
    vendor: { apiBase: "https://up.example/v1", protocol: "openai" },
  };
}

beforeEach(() => {
  m.findMany.mockReset();
});

describe("loadKeyCandidatesByIds（队列 Key 复原）", () => {
  it("按入队顺序还原候选，apiKey 仅在 Worker 内存中解密", async () => {
    m.findMany.mockResolvedValue([keyRow(2), keyRow(1)]);
    const out = await loadKeyCandidatesByIds([1, 2]);
    expect(out.map((c) => c.vendorKeyId)).toEqual([1, 2]);
    expect(out[0]).toMatchObject({
      keyName: "key-1",
      apiKey: "sk-live-1",
      apiBase: "https://up.example/v1",
      protocol: "openai",
    });
    expect(m.findMany).toHaveBeenCalledWith({
      where: { id: { in: [1, 2] } },
      include: { vendor: true },
    });
  });

  it("期间被禁用 / 解密失败的 Key 跳过，其余候选保持可用", async () => {
    m.findMany.mockResolvedValue([
      keyRow(1),
      keyRow(2, { status: "disabled" }),
      keyRow(3, { cipher: "enc:v1:bad:bad:bad" }),
      keyRow(4),
    ]);
    const out = await loadKeyCandidatesByIds([1, 2, 3, 4]);
    expect(out.map((c) => c.vendorKeyId)).toEqual([1, 4]);
  });

  it("空 id 列表不查库", async () => {
    const out = await loadKeyCandidatesByIds([]);
    expect(out).toEqual([]);
    expect(m.findMany).not.toHaveBeenCalled();
  });
});
