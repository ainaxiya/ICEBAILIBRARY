import { NextResponse } from "next/server";

// ─── P1 契约：/v1 统一错误体（OpenAI 兼容 + 方案 5.3 request_id 预留） ───
// 全部 /v1 端点的错误响应唯一入口；禁止在路由内各自拼 error 对象。
// 形状：{ "error": { "message", "type", "code", "param": null, "request_id"? } }
//
// b11 结构化错误码：每个 code 在目录里固定归属四类
//   local    = 本地拒绝（鉴权 / 参数 / 模型端点 / 定价 / 幂等 / 落库失败），重试通常无意义
//   quota    = 平台配额与余额（限流 / 并发 / 余额不足 / 准入门槛），重试需等待或充值
//   channel  = 渠道侧（无可用 Key / 渠道全部熔断），可稍后重试
//   upstream = 上游服务（超时 / 报错 / 限流 / 任务失败），可稍后重试
// 分类只用于服务端统计与告警，响应字段保持原契约不变（不新增对外字段）。

// 所有 /v1 响应（含错误）一律 no-store：响应与鉴权结果绑定，任何中间层缓存都会串号。
const NO_STORE = { "Cache-Control": "no-store" } as const;

export type GatewayErrorCategory = "local" | "quota" | "channel" | "upstream";

export interface GatewayErrorSpec {
  status: number;
  type: string;
  category: GatewayErrorCategory;
  message: string;
  retryable: boolean;
}

// 目录：status / type / message 与改造前逐条一致（只增加分类元数据，不改响应契约）
export const GATEWAY_ERRORS = {
  // ── local ──
  invalid_body: { status: 400, type: "invalid_request_error", category: "local", message: "Invalid request body", retryable: false },
  unsupported_parameter: { status: 400, type: "invalid_request_error", category: "local", message: "Model does not support this parameter", retryable: false },
  file_too_large: { status: 400, type: "invalid_request_error", category: "local", message: "Uploaded file is too large", retryable: false },
  model_not_found: { status: 404, type: "invalid_request_error", category: "local", message: "Model not found or offline", retryable: false },
  endpoint_disabled: { status: 404, type: "invalid_request_error", category: "local", message: "This model does not support this endpoint", retryable: false },
  pricing_not_configured: { status: 404, type: "invalid_request_error", category: "local", message: "Model pricing is not configured", retryable: false },
  endpoint_unsupported: { status: 400, type: "invalid_request_error", category: "local", message: "Upstream protocol does not support this endpoint", retryable: false },
  task_not_found: { status: 404, type: "invalid_request_error", category: "local", message: "Task not found", retryable: false },
  not_found: { status: 404, type: "invalid_request_error", category: "local", message: "Not Found", retryable: false },
  invalid_api_key: { status: 401, type: "authentication_error", category: "local", message: "Invalid API key", retryable: false },
  // b1：Key 模型白名单外的请求
  model_not_allowed: { status: 403, type: "permission_error", category: "local", message: "This API key is not allowed to use this model", retryable: false },
  not_authenticated: { status: 401, type: "authentication_error", category: "local", message: "Not authenticated", retryable: false },
  request_in_progress: { status: 409, type: "idempotency_error", category: "local", message: "A request with this Idempotency-Key is still in progress", retryable: true },
  idempotency_key_refunded: { status: 409, type: "idempotency_error", category: "local", message: "This Idempotency-Key was already refunded after a failed attempt", retryable: false },
  task_create_failed: { status: 500, type: "api_error", category: "local", message: "Failed to create the task", retryable: true },
  internal_error: { status: 500, type: "api_error", category: "local", message: "Internal server error", retryable: true },
  client_cancelled: { status: 499, type: "cancelled_error", category: "local", message: "Client closed request", retryable: true },

  // ── quota ──
  quota_exceeded: { status: 429, type: "rate_limit_error", category: "quota", message: "Rate limit exceeded. Please slow down and retry later", retryable: true },
  concurrency_exceeded: { status: 429, type: "rate_limit_error", category: "quota", message: "Too many concurrent requests. Please retry later", retryable: true },
  insufficient_credits: { status: 402, type: "insufficient_quota", category: "quota", message: "Insufficient credits", retryable: false },
  min_balance_required: { status: 402, type: "insufficient_quota", category: "quota", message: "Account balance is below the model's minimum requirement", retryable: false },
  // b2：API Key 自身额度用尽（不影响站内余额）
  key_quota_exceeded: { status: 402, type: "insufficient_quota", category: "quota", message: "API key quota exceeded", retryable: false },

  // ── channel ──
  no_upstream_key: { status: 502, type: "api_error", category: "channel", message: "No upstream channel available for this model", retryable: true },

  // ── upstream ──
  upstream_error: { status: 502, type: "api_error", category: "upstream", message: "Upstream model service error", retryable: true },
  upstream_timeout: { status: 502, type: "api_error", category: "upstream", message: "Upstream request timed out", retryable: true },
  upstream_rate_limited: { status: 429, type: "rate_limit_error", category: "upstream", message: "Upstream rate limit exceeded", retryable: true },
  upstream_concurrency: { status: 429, type: "rate_limit_error", category: "upstream", message: "Upstream concurrency limit exceeded", retryable: true },
  upstream_invalid_request: { status: 400, type: "invalid_request_error", category: "upstream", message: "Upstream rejected the request", retryable: false },
  upstream_task_failed: { status: 502, type: "api_error", category: "upstream", message: "Upstream task failed", retryable: true },
} as const satisfies Record<string, GatewayErrorSpec>;

export type GatewayErrorCode = keyof typeof GATEWAY_ERRORS;

export interface GatewayErrorOptions {
  // 覆盖默认 message / status / type（上游透传等动态场景）；未给则用目录值
  message?: string;
  status?: number;
  type?: string;
  requestId?: string;
  headers?: Record<string, string>;
  // 附加字段（如 required_credits / balance / recharge_url），展开进 error 对象
  extra?: Record<string, unknown>;
}

// 目录外的 code（适配器动态抛出的）按前缀归类，保证统计不缺项
function fallbackSpec(code: string, status: number, type: string): GatewayErrorSpec {
  const category: GatewayErrorCategory = code.startsWith("upstream_")
    ? "upstream"
    : code.includes("quota") || code.includes("credits") || code.includes("concurrency")
      ? "quota"
      : code === "no_upstream_key"
        ? "channel"
        : "local";
  return {
    status,
    type,
    category,
    message: "Request failed",
    retryable: status === 429 || status >= 500,
  };
}

export interface GatewayErrorMeta {
  errorCode: string;
  category: GatewayErrorCategory;
  status: number;
  type: string;
  retryable: boolean;
}

// 结构化元数据（供路由日志 / 告警统计消费；不进入响应体）
export function errorMeta(
  code: string,
  overrides: Pick<GatewayErrorOptions, "status" | "type"> = {}
): GatewayErrorMeta {
  const inCatalog = Object.prototype.hasOwnProperty.call(GATEWAY_ERRORS, code);
  const known = inCatalog ? GATEWAY_ERRORS[code as GatewayErrorCode] : null;
  const status = overrides.status ?? known?.status ?? 500;
  const type = overrides.type ?? known?.type ?? "api_error";
  const spec = known ?? fallbackSpec(code, status, type);
  return { errorCode: code, category: spec.category, status, type, retryable: spec.retryable };
}

// 结构化错误响应唯一入口：状态码 / type / 文案默认取目录，动态场景可覆盖。
// 响应体字段与历史契约完全一致；分类元数据只写服务端日志（5xx / 上游 / 渠道）。
export function gatewayError(code: string, opts: GatewayErrorOptions = {}): NextResponse {
  const meta = errorMeta(code, { status: opts.status, type: opts.type });
  const spec = Object.prototype.hasOwnProperty.call(GATEWAY_ERRORS, code)
    ? GATEWAY_ERRORS[code as GatewayErrorCode]
    : null;
  const message = opts.message ?? spec?.message ?? "Request failed";

  if (meta.status >= 500 || meta.category === "upstream" || meta.category === "channel") {
    try {
      console.warn(
        JSON.stringify({
          scope: "gateway_error",
          error_code: meta.errorCode,
          category: meta.category,
          status: meta.status,
          type: meta.type,
          retryable: meta.retryable,
          ...(opts.requestId ? { request_id: opts.requestId } : {}),
        })
      );
    } catch {
      // 日志失败不影响响应
    }
  }

  return apiError(meta.status, message, meta.type, meta.errorCode, opts.requestId, opts.headers, opts.extra);
}

export function apiError(
  status: number,
  message: string,
  type: string,
  code: string,
  requestId?: string,
  extraHeaders?: Record<string, string>,
  // 附加字段（如 required_credits / balance / recharge_url），展开进 error 对象
  extra?: Record<string, unknown>
): NextResponse {
  return NextResponse.json(
    {
      error: {
        message,
        type,
        code,
        param: null,
        ...(requestId ? { request_id: requestId } : {}),
        ...(extra ?? {}),
      },
    },
    { status, headers: { ...NO_STORE, ...(extraHeaders ?? {}) } }
  );
}
