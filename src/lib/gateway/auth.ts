import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { verifyApiKey } from "@/lib/apikey";
import { getGatewayRoutes, hostnamesOfRoutes } from "@/lib/gateway/gateway-routes";
import { API_GATEWAY_HOSTS } from "@/lib/site-config";

// ─── P5 站外双通道：/v1 统一鉴权 ───
// Authorization: Bearer sk-* → user_api_key 校验（channel=apikey，记 UserApiKey.id）；
// 无 Authorization 头 → 站内登录态（channel=onsite）。

// ─── /v1 网关域名白名单（后台多线路 Base URL 的域名集合，v0.92） ───
// 非白名单域名访问 /v1 一律 404 静默隐藏，不暴露接口存在。
export const DEFAULT_API_GATEWAY_HOSTS = API_GATEWAY_HOSTS;

// 归一化主机名：去协议/路径/端口、转小写
function normalizeHost(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

// Host 与 X-Forwarded-Host（如有）都必须命中白名单，防伪造转发头绕过
export function isApiHostAllowed(req: NextRequest, allow: string[]): boolean {
  const hosts = [req.headers.get("host"), req.headers.get("x-forwarded-host")]
    .flatMap((h) => (h ? h.split(",") : []))
    .map(normalizeHost)
    .filter(Boolean);
  return hosts.length > 0 && hosts.every((h) => allow.includes(h));
}

type AuthUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

export type V1Auth =
  | { ok: true; user: AuthUser; channel: "onsite" | "apikey"; apiKeyId: number | null }
  | { ok: false; status: number; message: string; code: string };

export async function authenticateV1(req: NextRequest): Promise<V1Auth> {
  // ── 0. 网关域名白名单（多线路 Base URL 域名）：非配置域名 404 静默隐藏 ──
  const allow = hostnamesOfRoutes(await getGatewayRoutes());
  if (!isApiHostAllowed(req, allow.length ? allow : DEFAULT_API_GATEWAY_HOSTS)) {
    return { ok: false, status: 404, message: "Not Found", code: "not_found" };
  }

  const authHeader = (req.headers.get("authorization") || "").trim();
  if (authHeader) {
    const m = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (!m || !m[1].startsWith("sk-")) {
      return {
        ok: false,
        status: 401,
        message: "Invalid Authorization header. Use: Authorization: Bearer sk-YOUR_KEY",
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
    return {
      ok: false,
      status: 401,
      message: "Missing API key. Provide your key in the Authorization header: Authorization: Bearer sk-YOUR_KEY",
      code: "not_authenticated",
    };
  }
  return { ok: true, user, channel: "onsite", apiKeyId: null };
}
