import { describe, it, expect, vi, afterEach } from "vitest";
import { callVideoGenerations, POLL_MAX_CONSECUTIVE_FAILURES } from "@/lib/gateway/adapters/media";
import { callArkVideoTask } from "@/lib/gateway/adapters/ark-video";

// ─── g12：视频轮询单次 5xx 不得直接判失败（与站内 pollAndDeliverVideo 同口径） ───
// 5xx / 408 / 429 / 网络抖动按「连续失败」计数，达上限才收口；
// 4xx（任务不存在 / 鉴权失效）仍立即失败。

type PollStep = () => Response | Promise<Response>;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// 提交走 POST，轮询走 GET；轮询按步骤表依次返回
function stubFetch(pollSteps: PollStep[]) {
  const polls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonRes({ id: "task-1" });
      polls.push(String(url));
      const step = pollSteps.shift();
      if (!step) throw new Error("unexpected extra poll");
      return step();
    })
  );
  return polls;
}

const okStep = (url = "https://up/video.mp4"): PollStep => () =>
  jsonRes({ status: "completed", data: [{ url }] });
const httpStep = (status: number): PollStep => () => jsonRes({ error: { message: `HTTP ${status}` } }, status);
const runningStep = (): PollStep => () => jsonRes({ status: "running" });
const netErrStep = (): PollStep => () => {
  throw new TypeError("fetch failed");
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("callVideoGenerations 轮询容错（g12）", () => {
  it("连续 3 次 5xx 后恢复 → 任务照常成功，不判失败", async () => {
    stubFetch([httpStep(503), httpStep(502), httpStep(500), okStep()]);
    const r = await callVideoGenerations({
      apiBase: "http://mock",
      apiKey: "k",
      body: { model: "vid", prompt: "p" },
      pollIntervalMs: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.urls).toEqual(["https://up/video.mp4"]);
  });

  it(`连续 ${POLL_MAX_CONSECUTIVE_FAILURES} 次 5xx → 才判失败并带回连续次数`, async () => {
    const polls = stubFetch(Array.from({ length: POLL_MAX_CONSECUTIVE_FAILURES }, () => httpStep(503)));
    const r = await callVideoGenerations({
      apiBase: "http://mock",
      apiKey: "k",
      body: { model: "vid", prompt: "p" },
      pollIntervalMs: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain(`连续失败 ${POLL_MAX_CONSECUTIVE_FAILURES} 次`);
    expect(polls).toHaveLength(POLL_MAX_CONSECUTIVE_FAILURES);
  });

  it("网络抖动连续 4 次后恢复 → 仍成功（抖动不判失败）", async () => {
    stubFetch([netErrStep(), netErrStep(), netErrStep(), netErrStep(), okStep()]);
    const r = await callVideoGenerations({
      apiBase: "http://mock",
      apiKey: "k",
      body: { model: "vid", prompt: "p" },
      pollIntervalMs: 1,
    });
    expect(r.ok).toBe(true);
  });

  it("查询返回 404 → 立即失败，不进入连续容忍", async () => {
    const polls = stubFetch([httpStep(404), okStep()]);
    const r = await callVideoGenerations({
      apiBase: "http://mock",
      apiKey: "k",
      body: { model: "vid", prompt: "p" },
      pollIntervalMs: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(polls).toHaveLength(1);
  });

  it("成功轮询会重置连续失败计数（5xx 不累计到下一轮）", async () => {
    stubFetch([httpStep(503), httpStep(503), runningStep(), httpStep(503), httpStep(503), okStep()]);
    const r = await callVideoGenerations({
      apiBase: "http://mock",
      apiKey: "k",
      body: { model: "vid", prompt: "p" },
      pollIntervalMs: 1,
    });
    expect(r.ok).toBe(true);
  });
});

describe("callArkVideoTask 轮询容错（g12）", () => {
  it("单次 5xx 不判失败：恢复后拿到 content.video_url", async () => {
    stubFetch([
      () => jsonRes({ status: "running" }),
      httpStep(503),
      () => jsonRes({ status: "succeeded", content: { video_url: "https://ark/v.mp4" } }),
    ]);
    const r = await callArkVideoTask({
      apiBase: "http://mock",
      apiKey: "k",
      body: { model: "vid", prompt: "p" },
      pollIntervalMs: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.urls).toEqual(["https://ark/v.mp4"]);
  });

  it("连续 5 次 5xx → 判失败并带回连续次数", async () => {
    stubFetch(Array.from({ length: POLL_MAX_CONSECUTIVE_FAILURES }, () => httpStep(503)));
    const r = await callArkVideoTask({
      apiBase: "http://mock",
      apiKey: "k",
      body: { model: "vid", prompt: "p" },
      pollIntervalMs: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain(`连续失败 ${POLL_MAX_CONSECUTIVE_FAILURES} 次`);
  });
});
