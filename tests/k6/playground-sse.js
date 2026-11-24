// ─── 冰山实验场 M4：/api/playground/chat SSE 压测 ───
// 与 tests/k6/sse-baseline.js 同口径，目标换成站内实验场接口（Cookie 鉴权 + 计费 + 会话落库），
// 用来确认「每轮多写 session/message 两张表」之后容量是否仍在基线范围内。
// 运行：powershell -File scripts\k6\run-playground.ps1

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

// 注意：本地用 localhost 而不是 127.0.0.1——网关域名隔离会把 127.0.0.1 当网关域名，
// 非 /v1 路径统一返回文档 JSON（200），压测就会全是「假 200」。
const BASE = __ENV.K6_BASE_URL || "http://localhost:3101";
const TOKEN = __ENV.K6_TOKEN || "";

const firstTokenMs = new Trend("pg_first_token_ms", true);
const streamTotalMs = new Trend("pg_total_ms", true);
const pgCompleted = new Counter("pg_completed");
const pgClientAborts = new Counter("pg_client_aborts");
const pgErrors = new Counter("pg_errors");

const PARAMS = {
  headers: {
    "Content-Type": "application/json",
    Cookie: `token=${TOKEN}`,
  },
};

// 技能挂载路径压测：K6_SKILL_IDS=12,13 时带 skillIds，其余与稳态完全同口径
const SKILL_IDS = (__ENV.K6_SKILL_IDS || "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const PAYLOAD = JSON.stringify({
  model: "chat-k6",
  messages: [{ role: "user", content: "实验场 k6 负载测试，请输出若干文本。" }],
  max_tokens: 120,
  temperature: 0.7,
  ...(SKILL_IDS.length ? { skillIds: SKILL_IDS } : {}),
});

export function steadyRun() {
  const r = http.post(`${BASE}/api/playground/chat`, PAYLOAD, { ...PARAMS, timeout: "60s" });
  if (r.status === 200) {
    const ok = check(r, {
      "status 200": () => true,
      "stream completed ([DONE])": (res) => res.body.indexOf("[DONE]") >= 0,
    });
    if (ok) {
      pgCompleted.add(1);
      firstTokenMs.add(r.timings.waiting);
      streamTotalMs.add(r.timings.waiting + r.timings.receiving);
    } else {
      pgErrors.add(1);
    }
  } else {
    pgErrors.add(1);
    check(r, { "error body has code": (res) => res.body.indexOf('"code"') >= 0 });
  }
  sleep(0.3);
}

// 客户端 300ms 主动断连：实验场应在断连时按已发生用量结算并释放并发槽
export function disconnectRun() {
  const r = http.post(`${BASE}/api/playground/chat`, PAYLOAD, { ...PARAMS, timeout: "300ms" });
  if (r.status === 0) {
    pgClientAborts.add(1);
  } else if (r.status === 200) {
    pgCompleted.add(1);
    streamTotalMs.add(r.timings.waiting + r.timings.receiving);
  } else {
    pgErrors.add(1);
  }
}

const scenarios = {
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
};

// 断连场景与稳态串行跑会互相污染统计；默认关闭，需要时 K6_DISCONNECT=1 打开
if (__ENV.K6_DISCONNECT === "1") {
  const onlyDisconnect = __ENV.K6_ONLY_DISCONNECT === "1";
  if (onlyDisconnect) delete scenarios.steady;
  scenarios.disconnect = {
    executor: "constant-arrival-rate",
    rate: 5,
    timeUnit: "1s",
    duration: "30s",
    preAllocatedVUs: 10,
    exec: "disconnectRun",
  };
  // 只跑断连时从 0s 直接开始；与稳态串行时从 95s 开始
  // 注意：k6 v2.3.0 下 startTime 非 0 会在场景切换点卡死（本地实测），单独跑不要设
  if (!onlyDisconnect) scenarios.disconnect.startTime = "95s";
}

export const options = {
  scenarios,
  discardResponseBodies: false,
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
};
