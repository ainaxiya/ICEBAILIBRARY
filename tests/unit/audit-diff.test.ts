import { describe, it, expect } from "vitest";
import { auditValue, diffFields, extractChanges, withChanges } from "@/lib/audit-diff";

// ─── b17 审计日志变更前后 ───
// 校验：只记真正变化的字段、日期/Decimal 归一化、超长截断、detail JSON 读写兼容

describe("audit-diff 变更前后", () => {
  it("只输出发生变化的字段，并带中文标签", () => {
    const before = { nickname: "旧昵称", status: "active", bio: "同一段简介" };
    const after = { nickname: "新昵称", status: "active", bio: "同一段简介" };
    const changes = diffFields(before, after, ["nickname", "status", "bio"], {
      nickname: "昵称",
      status: "状态",
      bio: "简介",
    });
    expect(changes).toEqual([{ field: "nickname", label: "昵称", before: "旧昵称", after: "新昵称" }]);
  });

  it("Date / Decimal / bigint / 超长文本归一化", () => {
    const before = {
      birthday: new Date("2020-01-01T00:00:00.000Z"),
      price: { toNumber: () => 12.5 },
      balance: 10n,
      title: "长".repeat(300),
    };
    const after = {
      birthday: new Date("2021-01-01T00:00:00.000Z"),
      price: { toNumber: () => 20 },
      balance: 20n,
      title: "短标题",
    };
    const changes = diffFields(before, after, ["birthday", "price", "balance", "title"]);
    expect(changes).toHaveLength(4);
    expect(changes.find((c) => c.field === "birthday")?.after).toBe("2021-01-01T00:00:00.000Z");
    expect(changes.find((c) => c.field === "price")?.after).toBe(20);
    expect(changes.find((c) => c.field === "balance")?.after).toBe(20);
    expect(String(changes.find((c) => c.field === "title")?.before)).toMatch(/…$/);
    expect(auditValue(null)).toBeNull();
  });

  it("withChanges 合并 changes；无变更时保持原 detail", () => {
    const withDiff = JSON.parse(
      withChanges({ title: "t" }, [{ field: "title", before: "a", after: "b" }])
    );
    expect(withDiff).toMatchObject({ title: "t", changes: [{ field: "title", before: "a", after: "b" }] });

    const noDiff = JSON.parse(withChanges({ title: "t" }, []));
    expect(noDiff).toEqual({ title: "t" });
  });

  it("extractChanges 兼容旧日志与非 JSON", () => {
    expect(extractChanges(null)).toEqual([]);
    expect(extractChanges("not-json")).toEqual([]);
    expect(extractChanges(JSON.stringify({ title: "无 changes" }))).toEqual([]);
    expect(
      extractChanges(JSON.stringify({ changes: [{ field: "status", before: "draft", after: "published" }] }))
    ).toEqual([{ field: "status", label: undefined, before: "draft", after: "published" }]);
  });
});
