// b13 敏感操作二次验证：常量与纯函数（不依赖 next/headers，便于单测）
// 管理员在敏感操作前重输密码，服务端签发 10 分钟短期令牌（独立 Cookie），
// 敏感接口强制校验令牌；前端弹窗只是交互，绕过前端也会被后端拒绝。

export const REAUTH_COOKIE = "admin_reauth";
export const REAUTH_TTL_SECONDS = 10 * 60;
export const REAUTH_REQUIRED_CODE = "REAUTH_REQUIRED";

// 校验二次验证令牌载荷：类型必须是 ra、归属当前管理员、签发时间在有效窗口内
export function isValidReauthPayload(
  payload: { t?: unknown; aid?: unknown; iat?: unknown } | null | undefined,
  adminId: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!payload || payload.t !== "ra") return false;
  if (payload.aid !== adminId) return false;
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) return false;
  const age = nowSec - payload.iat;
  return age >= 0 && age < REAUTH_TTL_SECONDS;
}
