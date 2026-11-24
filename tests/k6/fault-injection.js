// ─── P6 #20 k6 故障注入基线（上游 30% 502）───
// 前置：mock 以 FAIL_RATE=0.3 启动（run-baseline.ps1 编排）
// 验证点：上游故障时网关必须返回规范错误体（502 + {"error":{...}}），不出现裸 500 / 崩溃；
//        熔断打开后延迟显著下降（fail-fast）。
// 运行：k6 run -e K6_BASE_URL=... -e K6_TOKEN=... tests/k6/fault-injection.js

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend, Rate } from "k6/metrics";

const BASE = __ENV.K6_BASE_URL || "http://127.0.0.1:3101";
const TOKEN = __ENV.K6_TOKEN || "";

const gatewayErrors = new Counter("upstream_gateway_errors");
const bare500 = new Counter("bare_500_errors");
const successRate = new Rate("chat_success_rate");
const errDuration = new Trend("error_path_duration_ms", true);

const PARAMS = { headers: { "Content-Type": "application/json", Cookie: `token=${TOKEN}` } };
const PAYLOAD = JSON.stringify({
  model: "chat-k6",
  stream: true,
  messages: [{ role: "user", content: "故障注入测试" }],
  max_tokens: 60,
});

export default function () {
  const r = http.post(`${BASE}/v1/chat/completions`, PAYLOAD, { ...PARAMS, timeout: "60s" });
  if (r.status === 200) {
    successRate.add(1);
    check(r, { "stream completed": (res) => res.body.indexOf("[DONE]") >= 0 });
  } else if (r.status === 502) {
    // 规范网关错误体（upstream_error / no_upstream_key）
    const valid = check(r, {
      "502 with gateway error body": (res) =>
        res.body.indexOf('"error"') >= 0 && (res.body.indexOf("upstream") >= 0 || res.body.indexOf("channel") >= 0),
    });
    gatewayErrors.add(1);
    successRate.add(0);
    errDuration.add(r.timings.duration);
    if (!valid) bare500.add(1);
  } else if (r.status >= 500) {
    // 裸 500 = 网关自身异常（不允许出现）
    bare500.add(1);
    successRate.add(0);
    check(r, { "no bare 500": () => false });
  } else {
    successRate.add(0);
    check(r, { "unexpected status": () => false });
  }
  sleep(0.2);
}

export const options = {
  vus: 20,
  duration: "60s",
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
};
