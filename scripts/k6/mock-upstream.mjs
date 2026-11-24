// ─── k6 压测用 Mock 上游（独立可运行，勿接生产）───
// OpenAI 兼容：POST /v1/chat/completions（SSE 流式，20 chunk × 15ms + [DONE]）
// 故障注入：环境变量 FAIL_RATE（0~1）按比例返回 502
// 端口：MOCK_PORT（默认 19810）
// 用法: node scripts/k6/mock-upstream.mjs

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT) || 19810;
const FAIL_RATE = Math.min(1, Math.max(0, Number(process.env.FAIL_RATE) || 0));
const CHUNKS = 20;
const CHUNK_DELAY_MS = 15;

let stats = { total: 0, fail: 0, stream: 0, aborts: 0 };

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...stats }));
    return;
  }

  if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      stats.total++;
      // 故障注入：按 FAIL_RATE 比例返回 502（模拟上游故障）
      if (Math.random() < FAIL_RATE) {
        stats.fail++;
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock upstream failure (fault injection)", type: "upstream_error" } }));
        return;
      }
      stats.stream++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      let i = 0;
      const writeChunk = () => {
        if (res.writableEnded) return;
        if (i >= CHUNKS) {
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        const chunk = {
          id: `chatcmpl-k6-${Date.now()}`,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: i === 0 ? "你好，" : "负载测试数据块" }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        i++;
        setTimeout(writeChunk, CHUNK_DELAY_MS);
      };
      // 客户端断连：响应连接被终止时停止写流
      // （注意：req 的 close 在 body 读完即触发，不能用它判断断连）
      res.on("close", () => {
        if (!res.writableEnded) {
          stats.aborts++;
          res.end();
        }
      });
      writeChunk();
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "mock: not found" } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[k6-mock] listening http://127.0.0.1:${PORT} FAIL_RATE=${FAIL_RATE}`);
});
