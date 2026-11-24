import { describe, expect, it } from "vitest";
import {
  creditsFromQuoteUsd,
  costMilliFromQuoteUsd,
  parseParams,
  recoveryDecisionFor,
  toTaskView,
  IMAGE_WORKER_TIMEOUT_MS,
} from "@/lib/playground/media-task-runner";
import type { ModelPricing, PlaygroundMediaTask } from "@prisma/client";

// M5：统一媒体任务的纯函数测试（不连库、不起服务）
// 覆盖：报价换算（预扣/成本）、params 解析、任务视图、重启恢复决策

const pricing = {
  id: 1,
  modelId: 1,
  currency: "USD",
  unit: "token",
  inputPrice: 0.000001,
  fxRateE8: 668000000n, // 6.68
  multiplierBps: 15000n, // 1.5x
  meterBase: 1000000n,
  memberInputPrice: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as ModelPricing;

describe("视频报价换算", () => {
  it("按定价行汇率与加价换算预扣积分（0.6912 USD → 693）", () => {
    expect(creditsFromQuoteUsd(0.6912, pricing)).toBe(693);
  });

  it("定价行缺失时用兜底汇率（6.68 × 1.5），结果一致", () => {
    expect(creditsFromQuoteUsd(0.6912, null)).toBe(693);
  });

  it("极小报价向上取整且不低于 1 积分", () => {
    expect(creditsFromQuoteUsd(0.000001, pricing)).toBe(1);
  });

  it("内部成本毫积分：0.6912 USD → 461722（0.6912×6.68×100×1000）", () => {
    expect(costMilliFromQuoteUsd(0.6912, pricing)).toBe(461722);
    expect(costMilliFromQuoteUsd(0.6912, null)).toBe(461722);
  });
});

describe("params 解析", () => {
  it("正常 JSON 解析出 prompt 与时长", () => {
    const p = parseParams(JSON.stringify({ prompt: "海边日落", duration: 4, resolution: "720p" }));
    expect(p.prompt).toBe("海边日落");
    expect(p.duration).toBe(4);
  });

  it("坏 JSON 返回空 prompt 不抛错", () => {
    expect(parseParams("not-json{").prompt).toBe("");
  });
});

describe("重启恢复决策", () => {
  const BOOT = "boot-cur";

  it("queued → 重新排队（无论 bootId）", () => {
    expect(recoveryDecisionFor({ kind: "image", status: "queued", params: "{}" }, BOOT)).toBe("rerun");
  });

  it("running + 视频有上游任务号 → 恢复轮询（不重复提交/扣费）", () => {
    expect(
      recoveryDecisionFor(
        { kind: "video", status: "running", params: JSON.stringify({ prompt: "x", upstreamJobId: "job-1" }) },
        BOOT
      )
    ).toBe("resume");
  });

  it("running + 视频无上游任务号 → 失败退分", () => {
    expect(recoveryDecisionFor({ kind: "video", status: "running", params: JSON.stringify({ prompt: "x" }) }, BOOT)).toBe("fail");
  });

  it("running + 图片 → 失败退分（同步调用无法续传）", () => {
    expect(recoveryDecisionFor({ kind: "image", status: "running", params: "{}" }, BOOT)).toBe("fail");
  });

  it("本进程在跑的任务（bootId 相同）→ 不许碰", () => {
    expect(
      recoveryDecisionFor({ kind: "image", status: "running", params: JSON.stringify({ prompt: "x", bootId: BOOT }) }, BOOT)
    ).toBe("none");
    expect(
      recoveryDecisionFor(
        { kind: "video", status: "running", params: JSON.stringify({ prompt: "x", bootId: BOOT, upstreamJobId: "j" }) },
        BOOT
      )
    ).toBe("none");
  });

  it("终态任务不处理", () => {
    expect(recoveryDecisionFor({ kind: "image", status: "succeeded", params: "{}" }, BOOT)).toBe("none");
    expect(recoveryDecisionFor({ kind: "image", status: "failed", params: "{}" }, BOOT)).toBe("none");
  });
});

describe("toTaskView", () => {
  const base = {
    id: 1n,
    taskId: "mt-abc",
    requestId: "req-1",
    userId: 50,
    kind: "video",
    modelId: 1,
    modelSnapshot: "seedance-2-5-text-to-video-flex",
    vendorKeyId: 7,
    status: "succeeded",
    progress: 100,
    stage: "已完成",
    params: JSON.stringify({ prompt: "海边日落" }),
    requestSize: "1280x720",
    quoteUsd: 0.6912,
    quoteId: "q-1",
    estCredits: 693n,
    paidCredits: 693n,
    costMilli: 461722n,
    resultUrls: JSON.stringify(["/uploads/playground/50/x.mp4"]),
    errorMessage: null,
    latencyMs: 241000,
    createdAt: new Date("2026-11-15T11:40:00Z"),
    updatedAt: new Date("2026-11-15T11:44:00Z"),
    startedAt: new Date("2026-11-15T11:40:01Z"),
    finishedAt: new Date("2026-11-15T11:44:01Z"),
  } as unknown as PlaygroundMediaTask;

  it("输出前端视图：urls / 扣费 / 错误 / 耗时", () => {
    const v = toTaskView(base);
    expect(v.taskId).toBe("mt-abc");
    expect(v.urls).toEqual(["/uploads/playground/50/x.mp4"]);
    expect(v.charged).toBe(693);
    expect(v.prompt).toBe("海边日落");
    expect(v.error).toBeNull();
  });

  it("resultUrls 坏 JSON 时 urls 为空数组", () => {
    const v = toTaskView({ ...base, resultUrls: "not-json" } as PlaygroundMediaTask);
    expect(v.urls).toEqual([]);
  });
});

describe("worker 超时配置一致性", () => {
  it("图片 worker 上限不得低于共享默认 10 分钟（否则内层先断）", () => {
    expect(IMAGE_WORKER_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000);
  });
});
