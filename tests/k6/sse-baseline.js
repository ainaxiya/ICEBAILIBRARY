// ─── P6 #20 k6 SSE 流式基线压测 ───
// 场景：steady（阶梯 10→30→50 VU 全流式请求）+ discard（客户端 300ms 主动断连）
// 指标：sse_first_token_ms（TTFB≈首 token）、sse_total_ms（整流时长）、断连计数、完成率
// 运行（由 scripts/k6/run-baseline.ps1 编排）：
//   k6 run -e K6_BASE_URL=http://127.0.0.1:3101 -e K6_TOKEN=<cookie jwt> tests/k6/sse-baseline.js

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.K6_BASE_URL || "http://127.0.0.1:3101";
const TOKEN = __ENV.K6_TOKEN || "";

const firstTokenMs = new Trend("sse_first_token_ms", true);
const streamTotalMs = new Trend("sse_total_ms", true);
const sseCompleted = new Counter("sse_completed");
const sseClientAborts = new Counter("sse_client_aborts");
const sseErrors = new Counter("sse_errors");

const PARAMS = {
  headers: {
    "Content-Type": "application/json",
    Cookie: `token=${TOKEN}`,
  },
};

const PAYLOAD = JSON.stringify({
  model: "chat-k6",
  stream: true,
  messages: [{ role: "user", content: "k6 负载测试，请输出若干文本。" }],
  max_tokens: 120,
});

// 场景一：阶梯并发全流式请求
export function steadyRun() {
  const r = http.post(`${BASE}/v1/chat/completions`, PAYLOAD, { ...PARAMS, timeout: "60s" });
  if (r.status === 200) {
    const done = check(r, {
      "status 200": () => true,
      "stream completed ([DONE])": (res) => res.body.indexOf("[DONE]") >= 0,
    });
    if (done) {
      sseCompleted.add(1);
      // http_req_waiting = TTFB ≈ 首 token 延迟；receiving ≈ 流式传输时长
      firstTokenMs.add(r.timings.waiting);
      streamTotalMs.add(r.timings.waiting + r.timings.receiving);
    } else {
      sseErrors.add(1);
    }
  } else {
    sseErrors.add(1);
    check(r, { "error body is gateway format": (res) => res.body.indexOf('"error"') >= 0 });
  }
  sleep(0.3);
}

// 场景二：客户端主动断连（300ms 超时 = 客户端中途关闭连接）
export function disconnectRun() {
  const r = http.post(`${BASE}/v1/chat/completions`, PAYLOAD, { ...PARAMS, timeout: "300ms" });
  if (r.status === 0) {
    // 超时/断连（预期行为）：连接被客户端终止
    sseClientAborts.add(1);
  } else if (r.status === 200) {
    // 300ms 内已完整返回（本 mock 流约 320ms，可能出现少量完整响应）
    sseCompleted.add(1);
    streamTotalMs.add(r.timings.waiting + r.timings.receiving);
  } else {
    sseErrors.add(1);
  }
}

export const options = {
  scenarios: {
    steady: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "20s", target: 10 },
        { duration: "20s", target: 30 },
        { duration: "25s", target: 50 },
        { duration: "15s", target: 50 },
      ],
      exec: "steadyRun",
      gracefulStop: "10s",
    },
    // 断连场景与稳态串行（startTime 在 steady 结束后）：客户端中止会触发上游取消，
    // 与稳态并发跑会干扰熔断统计（P6 finding：中止不应计入熔断失败窗口）
    disconnect: {
      executor: "constant-arrival-rate",
      rate: 5,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 10,
      exec: "disconnectRun",
      startTime: "95s",
    },
  },
  // 基线采集不做严格门禁（阈值另立），失败请求计入自定义指标
  discardResponseBodies: false,
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
};
