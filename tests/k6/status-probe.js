// 状态码分布探针（10 VU × 15s）
import http from "k6/http";
import { sleep } from "k6";
import { Counter } from "k6/metrics";

const BASE = __ENV.K6_BASE_URL || "http://127.0.0.1:3101";
const TOKEN = __ENV.K6_TOKEN || "";
const byStatus = new Counter("status_codes");

const PAYLOAD = JSON.stringify({
  model: "chat-k6",
  stream: true,
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 50,
});

export default function () {
  const r = http.post(`${BASE}/v1/chat/completions`, PAYLOAD, {
    headers: { "Content-Type": "application/json", Cookie: `token=${TOKEN}` },
    timeout: "30s",
  });
  byStatus.add(1, { code: String(r.status) });
  if (r.status !== 200 && __ENV.PRINT_ERR) {
    console.log(`NON200 status=${r.status} body=${String(r.body).slice(0, 200)}`);
  }
  sleep(0.2);
}

export const options = { vus: 10, duration: "15s" };
