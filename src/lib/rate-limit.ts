// 轻量内存速率限制（进程内兜底）
// 滑动窗口：同一 key 在 windowMs 内最多 hit 次。

import { getSharedRedis } from "@/lib/redis";

const buckets = new Map<string, number[]>();
let lastSweep = 0;

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  // 每 5 分钟清理一次过期桶
  if (now - lastSweep > 300_000) {
    for (const [k, arr] of buckets) {
      const fresh = arr.filter((t) => now - t < windowMs);
      if (fresh.length === 0) buckets.delete(k);
      else buckets.set(k, fresh);
    }
    lastSweep = now;
  }

  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return false; // 已超限
  }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

// ─── g15 / o13：多实例共享限流（Redis 固定窗口 + 进程内滑动窗口兜底） ───
// 仅配额/Key 限流等业务限流走这里；防刷类（登录、验证码、上传）仍用进程内 rateLimit，
// 避免每次热路径都依赖 Redis。Redis 不可用时秒级回退，不影响请求。
// 语义差异：Redis 侧是「固定窗口」（首次 INCR 时设过期），边界瞬时值可能高于滑动窗口，
// 用于配额限流足够，且跨实例计数不会因负载均衡被放大 N 倍。
export async function rateLimitAsync(key: string, limit: number, windowMs: number): Promise<boolean> {
  const r = getSharedRedis();
  if (!r) return rateLimit(key, limit, windowMs);
  try {
    const k = `rl:${key}`;
    const n = await r.incr(k);
    if (n === 1) await r.pexpire(k, windowMs);
    return n <= limit;
  } catch {
    return rateLimit(key, limit, windowMs);
  }
}

// 从请求中取客户端 IP（S0-6：取 XFF 最后一跳 = 本站 Nginx 追加的真实来源，
// 防客户端伪造 XFF 首段绕过 IP 限流；需保证应用端口不直接暴露公网，仅 Nginx 可达）
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.headers.get("x-real-ip") || "unknown";
}

// 仅允许站内相对路径（防开放重定向）
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}
