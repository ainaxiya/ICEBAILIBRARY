import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { verifyApiKey } from "@/lib/apikey";

// ─── P5 站外双通道：/v1 统一鉴权 ───
// Authorization: Bearer sk-* → user_api_key 校验（channel=apikey，记 UserApiKey.id）；
// 无 Authorization 头 → 站内登录态（channel=onsite）。

type AuthUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

export type V1Auth =
  | { ok: true; user: AuthUser; channel: "onsite" | "apikey"; apiKeyId: number | null }
  | { ok: false; status: number; message: string; code: string };

export async function authenticateV1(req: NextRequest): Promise<V1Auth> {
  const authHeader = (req.headers.get("authorization") || "").trim();
  if (authHeader) {
    const m = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (!m || !m[1].startsWith("sk-")) {
      return {
        ok: false,
        status: 401,
        message: "无效的 Authorization，请使用 Authorization: Bearer sk-xxx",
        code: "invalid_api_key",
      };
    }
    const r = await verifyApiKey(m[1]);
    if (!r.ok) {
      return { ok: false, status: 401, message: r.error, code: "invalid_api_key" };
    }
    return { ok: true, user: r.user, channel: "apikey", apiKeyId: r.key.id };
  }

  const user = await getCurrentUser();
  if (!user || user.status !== "active") {
    return { ok: false, status: 401, message: "请先登录后再调用", code: "not_authenticated" };
  }
  return { ok: true, user, channel: "onsite", apiKeyId: null };
}
