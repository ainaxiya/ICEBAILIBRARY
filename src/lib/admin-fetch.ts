import { requestReauth } from "@/components/admin/ReauthHost";

// b13：敏感接口返回 403 + code=REAUTH_REQUIRED 时，弹窗重输密码并自动重试一次。
// 仅在客户端组件中使用。
export async function adminFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status !== 403) return res;

  const data = await res.clone().json().catch(() => null);
  if ((data as { code?: string } | null)?.code !== "REAUTH_REQUIRED") return res;

  const ok = await requestReauth();
  if (!ok) return res;
  return fetch(input, init);
}
