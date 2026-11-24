import { describe, it, expect, vi, afterEach } from "vitest";
import { GATEWAY_ERRORS, errorMeta, gatewayError } from "@/lib/gateway/errors";

// ─── b11 结构化错误码目录 ───
// 四类归属固定；gatewayError 只收敛 status/type/message，响应字段保持历史契约不变。

afterEach(() => vi.restoreAllMocks());

describe("结构化错误码目录", () => {
  it("四类均有条目：local / quota / channel / upstream", () => {
    const cats = new Set(Object.values(GATEWAY_ERRORS).map((e) => e.category));
    expect([...cats].sort()).toEqual(["channel", "local", "quota", "upstream"]);
  });

  it("errorMeta 返回 errorCode + status + type + category + retryable", () => {
    expect(errorMeta("insufficient_credits")).toEqual({
      errorCode: "insufficient_credits",
      category: "quota",
      status: 402,
      type: "insufficient_quota",
      retryable: false,
    });
    expect(errorMeta("no_upstream_key").category).toBe("channel");
    expect(errorMeta("upstream_timeout")).toMatchObject({ category: "upstream", retryable: true });
    expect(errorMeta("model_not_found")).toMatchObject({ category: "local", status: 404 });
  });

  it("目录外 code 按前缀归类，不丢统计", () => {
    expect(errorMeta("upstream_unknown_thing")).toMatchObject({ category: "upstream" });
    expect(errorMeta("weird_quota_case")).toMatchObject({ category: "quota" });
  });

  it("gatewayError 响应体字段不变（message/type/code/param/request_id）", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = gatewayError("no_upstream_key", { requestId: "req-1" });
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: {
        message: "No upstream channel available for this model",
        type: "api_error",
        code: "no_upstream_key",
        param: null,
        request_id: "req-1",
      },
    });
  });

  it("动态场景可覆盖 message/status/type，附加字段展开进 error", async () => {
    const res = gatewayError("pricing_not_configured", {
      status: 400,
      message: "unit mismatch",
      extra: { required_credits: 12 },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "pricing_not_configured", message: "unit mismatch", required_credits: 12 },
    });
  });

  it("5xx / 上游 / 渠道错误写一条结构化日志", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    gatewayError("upstream_error", { message: "boom", requestId: "req-log" });
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(spy.mock.calls[0][0]));
    expect(payload).toMatchObject({
      scope: "gateway_error",
      error_code: "upstream_error",
      category: "upstream",
      status: 502,
      request_id: "req-log",
    });
  });

  it("4xx 本地错误不打日志", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    gatewayError("invalid_body", { message: "bad" });
    expect(spy).not.toHaveBeenCalled();
  });
});
