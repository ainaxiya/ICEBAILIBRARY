import { describe, it, expect } from "vitest";
import { togglePermission } from "@/lib/permissions";
import { REAUTH_TTL_SECONDS, isValidReauthPayload } from "@/lib/reauth-core";

// ─── b13 权限矩阵 + 敏感操作二次验证 ───

describe("togglePermission（权限矩阵单格切换）", () => {
  it("勾选未拥有的权限 → 追加", () => {
    expect(togglePermission(["user:read"], "user:write")).toEqual(["user:read", "user:write"]);
  });

  it("取消已拥有的权限 → 移除", () => {
    expect(togglePermission(["user:read", "user:write"], "user:read")).toEqual(["user:write"]);
  });

  it("勾选全部权限 → 只保留 *", () => {
    expect(togglePermission(["user:read", "prompt:read"], "*")).toEqual(["*"]);
  });

  it("再次取消全部权限 → 清空", () => {
    expect(togglePermission(["*"], "*")).toEqual([]);
  });

  it("从全部权限改为普通权限 → 自动移除 *", () => {
    expect(togglePermission(["*"], "user:read")).toEqual(["user:read"]);
  });

  it("不修改入参数组", () => {
    const src = ["user:read"];
    togglePermission(src, "user:write");
    expect(src).toEqual(["user:read"]);
  });
});

describe("isValidReauthPayload（二次验证令牌载荷）", () => {
  const now = 1_800_000_000;
  const base = { t: "ra", aid: 7, iat: now - 30 };

  it("本人 + 类型正确 + 窗口内 → 通过", () => {
    expect(isValidReauthPayload(base, 7, now)).toBe(true);
  });

  it("非二次验证令牌（登录令牌 t=a）→ 拒绝", () => {
    expect(isValidReauthPayload({ ...base, t: "a" }, 7, now)).toBe(false);
  });

  it("归属其他管理员 → 拒绝", () => {
    expect(isValidReauthPayload(base, 8, now)).toBe(false);
  });

  it("缺少签发时间 → 拒绝", () => {
    expect(isValidReauthPayload({ ...base, iat: undefined }, 7, now)).toBe(false);
  });

  it("超过有效期 → 拒绝", () => {
    expect(isValidReauthPayload({ ...base, iat: now - REAUTH_TTL_SECONDS }, 7, now)).toBe(false);
  });

  it("签发时间在未来（时钟异常）→ 拒绝", () => {
    expect(isValidReauthPayload({ ...base, iat: now + 5 }, 7, now)).toBe(false);
  });

  it("空载荷 → 拒绝", () => {
    expect(isValidReauthPayload(null, 7, now)).toBe(false);
  });
});
