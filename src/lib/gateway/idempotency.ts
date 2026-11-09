import { randomUUID } from "crypto";

// ─── S0-4 客户端幂等键 → 计费幂等 requestId ───
// 客户端可传 Idempotency-Key 请求头（OpenAI 风格，方案 5.4）；未传则保持随机 UUID。
// 同一用户重复携带同一 Key 重试时复用同一 requestId，账本层（CreditLedger.requestId
// 唯一约束 + settle/refund 幂等键）保证不重复扣费/退款。
// 作用域强制绑定 userId 前缀，防止跨用户碰撞与伪造。

const KEY_MAX = 128;

export function resolveRequestId(userId: number, req: Request): string {
  const raw = (req.headers.get("idempotency-key") || "").trim();
  if (!raw) return randomUUID();
  // 只保留可见安全字符，防日志注入与超长键滥用；清洗后为空则视为未传
  const safe = raw.replace(/[^A-Za-z0-9._:@-]/g, "").slice(0, KEY_MAX);
  if (!safe) return randomUUID();
  return `idem-${userId}-${safe}`;
}
