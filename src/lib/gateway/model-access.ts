import type { V1Auth } from "@/lib/gateway/auth";

// ─── b1：Key 模型白名单校验（独立模块，避免路由单测 mock auth 时缺导出） ───
// 仅站外 Key 生效；空白名单 = 全部允许；站内登录态不受限。
export function isModelAllowedForAuth(
  auth: Extract<V1Auth, { ok: true }>,
  model: string | null | undefined
): boolean {
  if (auth.channel !== "apikey") return true;
  const list = auth.allowedModels ?? [];
  if (!list.length) return true;
  return !!model && list.includes(model);
}
