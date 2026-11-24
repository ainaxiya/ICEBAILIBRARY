// 诊断 k6 401：本地校验 token + 直接请求网关
import fs from "node:fs";
import { jwtVerify } from "jose";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const token = fs.readFileSync(new URL("./.k6-token", import.meta.url), "utf8").trim();
const envText = fs.readFileSync(new URL("../../.env", import.meta.url), "utf8");
const secretRaw = /^JWT_SECRET="?([^"\r\n]+)"?/m.exec(envText)?.[1] || "";
console.log("secret len:", secretRaw.length, "token head:", token.slice(0, 24) + "...");

try {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secretRaw));
  console.log("token verify OK:", JSON.stringify(payload));
} catch (e) {
  console.log("token verify FAIL:", e.message);
  process.exit(1);
}

const body = JSON.stringify({ model: "chat-k6", stream: true, messages: [{ role: "user", content: "hi" }], max_tokens: 50 });
const BASE = process.env.K6_BASE_URL || "http://127.0.0.1:3101";
const r = await fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: `token=${token}` },
  body,
});
console.log("gateway status:", r.status);
const text = await r.text();
console.log("gateway body:", text.slice(0, 400));
