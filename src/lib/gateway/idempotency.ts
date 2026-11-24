import { createHash, randomUUID } from "crypto";

// ─── S0-4 客户端幂等键 → 计费幂等 requestId ───
// 客户端可传 Idempotency-Key 请求头（OpenAI 风格，方案 5.4）；未传则保持随机 UUID。
// 同一用户重复携带同一 Key 重试时复用同一 requestId，账本层（CreditLedger.requestId
// 唯一约束 + settle/refund 幂等键）保证不重复扣费/退款。
// 作用域强制绑定 userId 前缀，防止跨用户碰撞与伪造。
//
// L1 修复：requestId 还必须绑定「端点 + 模型 + 请求体指纹」。只按 userId+Key 派生时，
// 同一把 Key 先打廉价 chat、再打生图会命中旧扣费流水 → 不扣费仍放行。
// 现在：同一次请求的网络重试（同端点/同模型/同 body）→ 同一 requestId，仍然幂等；
// 换了端点、模型或任一参数 → 新的 requestId，走正常预扣。

const KEY_MAX = 128;
const ENDPOINT_MAX = 40;
// 指纹长度：sha256 前 32 个 hex 字符（128 bit），幂等键碰撞概率可忽略
const DIGEST_LEN = 32;
// 超过该长度的字符串（图片 base64、超长 prompt 等）只把自身摘要放进指纹输入，
// 不把整段内容搬进幂等键/哈希输入，避免大字段放大内存与日志
const LARGE_STRING = 4096;

export interface IdempotencyScope {
  /** 计费端点标识，例如 "chat.completions" / "image_generations" / "playground.tasks.image" */
  endpoint: string;
  /** 实际调用的模型名（同端点不同模型价格不同，必须区分） */
  model?: string | null;
  /** 已解析的请求体（用于内容指纹）；不要传原始字符串或 Blob/File */
  body?: unknown;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// 稳定序列化：对象键递归排序，保证同一请求体的不同键序得到同一指纹；
// 大字符串折叠成自身摘要，既保留内容区分度，又不让 base64 原文进入键或哈希输入。
function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "string") {
    const s = value as string;
    return s.length > LARGE_STRING ? `"sha256:${sha256(s)}"` : JSON.stringify(s);
  }
  if (t === "number" || t === "boolean") return String(value);
  if (t === "bigint") return `${value as bigint}n`;
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v)).join(",")}]`;
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  }
  return "null";
}

// 端点 + 模型 + 请求体指纹（导出便于单测与排障日志）
export function requestFingerprint(scope: Pick<IdempotencyScope, "endpoint" | "model" | "body">): string {
  return sha256(`${scope.endpoint}\n${scope.model ?? ""}\n${canonical(scope.body ?? null)}`).slice(0, DIGEST_LEN);
}

export function resolveRequestId(userId: number, req: Request, scope: IdempotencyScope): string {
  const raw = (req.headers.get("idempotency-key") || "").trim();
  if (!raw) return randomUUID();
  // 只保留可见安全字符，防日志注入与超长键滥用；清洗后为空则视为未传
  const safe = raw.replace(/[^A-Za-z0-9._:@-]/g, "").slice(0, KEY_MAX);
  if (!safe) return randomUUID();
  const ep = scope.endpoint.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, ENDPOINT_MAX) || "unknown";
  return `idem-${userId}-${safe}-${ep}-${requestFingerprint(scope)}`;
}
