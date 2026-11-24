// 并发探针：N 个并行请求，打印各自状态码与错误体前 160 字符
import fs from "node:fs";

const token = fs.readFileSync(new URL("./.k6-token", import.meta.url), "utf8").trim();
const body = JSON.stringify({ model: "chat-k6", stream: true, messages: [{ role: "user", content: "hi" }], max_tokens: 50 });
const BASE = process.env.K6_BASE_URL || "http://127.0.0.1:3101";

const one = async (i) => {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `token=${token}` },
    body,
  });
  const text = await r.text();
  console.log(`#${i} status=${r.status} ms=${Date.now() - t0} body=${text.slice(0, 160).replace(/\n/g, " ")}`);
};

await Promise.all(Array.from({ length: 6 }, (_, i) => one(i)));
