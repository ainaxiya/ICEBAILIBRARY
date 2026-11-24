import { describe, expect, it } from "vitest";
import { explainApiError } from "@/lib/error-guide";

describe("b7 失败原因弹窗口径", () => {
  it("已知错误码优先：insufficient_credits 给积分不足与充值入口", () => {
    const g = explainApiError({ code: "insufficient_credits", status: 402, message: "Insufficient credits" });
    expect(g.matched).toBe(true);
    expect(g.title).toBe("积分不足");
    expect(g.code).toBe("insufficient_credits");
    expect(g.actions.some((a) => a.href === "/recharge")).toBe(true);
  });

  it("系列准入门槛：min_balance_required 也指向充值", () => {
    const g = explainApiError({ code: "min_balance_required" });
    expect(g.matched).toBe(true);
    expect(g.title).toContain("门槛");
    expect(g.actions[0].href).toBe("/recharge");
  });

  it("未知错误码按状态码兜底，并保留原始 code 便于排查", () => {
    const g = explainApiError({ code: "some_new_code", status: 429 });
    expect(g.matched).toBe(true);
    expect(g.code).toBe("some_new_code");
    expect(g.title).toContain("频繁");
    expect(g.actions.some((a) => a.label === "稍后重试")).toBe(true);
  });

  it("无 code 时按状态码兜底为 http_<status>", () => {
    const g = explainApiError({ status: 503 });
    expect(g.matched).toBe(true);
    expect(g.code).toBe("http_503");
  });

  it("402 无 code 也给出充值建议", () => {
    const g = explainApiError({ status: 402 });
    expect(g.matched).toBe(true);
    expect(g.actions.some((a) => a.href === "/recharge")).toBe(true);
  });

  it("code 优先于 status：task_not_found 不被 500 覆盖", () => {
    const g = explainApiError({ code: "task_not_found", status: 500 });
    expect(g.title).toBe("任务不存在");
    expect(g.code).toBe("task_not_found");
  });

  it("封禁账号引导到工单，而不是让用户反复重试", () => {
    const g = explainApiError({ code: "account_suspended", status: 403 });
    expect(g.matched).toBe(true);
    expect(g.actions.some((a) => a.href === "/member?tab=messages")).toBe(true);
  });

  it("完全未知（无 code、无已知状态）不命中，但展示服务端原始提示", () => {
    const g = explainApiError({ status: 418, message: "teapot" });
    expect(g.matched).toBe(false);
    expect(g.code).toBe("http_418");
    expect(g.detail).toBe("teapot");
    expect(g.actions.length).toBeGreaterThan(0);
  });
});
