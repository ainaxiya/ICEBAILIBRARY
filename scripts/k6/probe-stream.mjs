// 完整流读取：对比 mock 直连 vs 网关转发，检查 [DONE] 与 chunk 数
import fs from "node:fs";

const token = fs.readFileSync(new URL("./.k6-token", import.meta.url), "utf8").trim();
const body = JSON.stringify({ model: "chat-k6", stream: true, messages: [{ role: "user", content: "hi" }], max_tokens: 50 });

async function probe(name, url, headers) {
  const t0 = Date.now();
  const r = await fetch(url, { method: "POST", headers, body });
  const text = await r.text();
  const chunks = (text.match(/^data: /gm) || []).length;
  console.log(
    `${name}: status=${r.status} ms=${Date.now() - t0} bytes=${text.length} dataChunks=${chunks} hasDONE=${text.includes("[DONE]")}`
  );
}

const BASE = process.env.K6_BASE_URL || "http://127.0.0.1:3101";
const MOCK_PORT = Number(process.env.MOCK_PORT) || 19810;

await probe("gateway", `${BASE}/v1/chat/completions`, {
  "Content-Type": "application/json",
  Cookie: `token=${token}`,
});
await probe("mock-direct", `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`, {
  "Content-Type": "application/json",
  Authorization: "Bearer mock-k6-key",
});
