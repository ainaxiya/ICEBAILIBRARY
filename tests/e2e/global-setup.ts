import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import type { GlobalSetupContext } from "vitest/node";
import { ADMIN_DB_URL, ensureTestDb, TEST_DB_URL } from "../db-setup";

// ─── E2E global setup：测试库 → fixtures → mock 多协议上游 → next start :3100 ───
// P4：mock 上游按 vendor apiBase 子路径区分协议：
//   openai    → http://127.0.0.1:19800              （/chat/completions、/embeddings）
//   anthropic → http://127.0.0.1:19800/anthropic     （/v1/messages）
//   gemini    → http://127.0.0.1:19800/gemini/v1beta （/models/{m}:generateContent / :streamGenerateContent / :batchEmbedContents）

export const APP_PORT = 3100;
export const MOCK_PORT = 19800;
export const APP_BASE = `http://127.0.0.1:${APP_PORT}`;

const ENV = {
  DATABASE_URL: TEST_DB_URL,
  STORAGE_KEY_SECRET: "test-storage-secret",
  JWT_SECRET: "test-jwt-secret",
  JWT_ADMIN_SECRET: "test-admin-jwt-secret",
  API_GATEWAY_HOSTS: "127.0.0.1,localhost",
  NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${APP_PORT}`,
  NEXT_TELEMETRY_DISABLED: "1",
};

function json(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sseHead(res: http.ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

// ── mock 多协议上游 ──
function startMockUpstream(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url || "";

    // ── GET：video 任务轮询 + 产物下载（OpenAI Videos 风格） ──
    if (req.method === "GET") {
      // 产物二进制：GET /v1/videos/{id}/content（需 Bearer，test 不校验）
      if (/\/videos\/[^/]+\/content$/.test(url)) {
        res.writeHead(200, { "Content-Type": "video/mp4" });
        res.end(Buffer.alloc(2048, 7));
        return;
      }
      // 旧路径兼容（部分渠道同步返回 URL）
      if (url.includes("/videos/generations/")) {
        json(res, {
          id: "mock-vtask-1",
          status: "succeeded",
          data: [{ video_url: `http://127.0.0.1:${MOCK_PORT}/fake-video.mp4` }],
        });
        return;
      }
      if (url.includes("/fake-video.mp4")) {
        res.writeHead(200, { "Content-Type": "video/mp4" });
        res.end(Buffer.alloc(2048, 7));
        return;
      }
      // 任务状态：GET /v1/videos/{id} → 首查即 completed
      if (/\/videos\/[^/]+$/.test(url)) {
        json(res, { id: "mock-vtask-1", object: "video", status: "completed", progress: 100, error: null });
        return;
      }
      res.writeHead(404).end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* ignore */
      }

      // ── 1. OpenAI 兼容 chat：/chat/completions ──
      if (url.includes("/chat/completions")) {
        if (body.stream !== true) {
          json(res, {
            id: "mock-chat-1",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "gpt-test",
            choices: [{ index: 0, message: { role: "assistant", content: "mock-ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
          return;
        }
        sseHead(res);
        const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
        res.write(chunk({ id: "mock-chat-s", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] }));
        res.write(chunk({ id: "mock-chat-s", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "mock-ok" } }] }));
        res.write(chunk({ id: "mock-chat-s", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      // ── 2. Anthropic Messages：/v1/messages ──
      if (url.includes("/v1/messages")) {
        if (body.stream !== true) {
          json(res, {
            id: "msg_mock_1",
            type: "message",
            role: "assistant",
            model: "claude-test",
            content: [{ type: "text", text: "mock-ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          });
          return;
        }
        sseHead(res);
        const data = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
        res.write(`event: message_start\n${data({ type: "message_start", message: { id: "msg_mock_s", usage: { input_tokens: 10 } } })}`);
        res.write(data({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        res.write(data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "mock-ok" } }));
        res.write(data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "-sse" } }));
        res.write(data({ type: "content_block_stop", index: 0 }));
        res.write(data({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }));
        res.write(data({ type: "message_stop" }));
        res.end();
        return;
      }

      // ── 3. Gemini：:generateContent / :streamGenerateContent ──
      if (url.includes(":streamGenerateContent")) {
        sseHead(res);
        const data = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
        res.write(data({ candidates: [{ content: { parts: [{ text: "mock-ok" }], role: "model" } }], usageMetadata: { promptTokenCount: 10 } }));
        res.write(data({ candidates: [{ content: { parts: [{ text: "-sse" }], role: "model" } }] }));
        res.write(data({ candidates: [{ content: { parts: [], role: "model" }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }));
        res.end();
        return;
      }
      if (url.includes(":generateContent")) {
        json(res, {
          candidates: [{ content: { parts: [{ text: "mock-ok" }], role: "model" }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        });
        return;
      }

      // ── 4. Gemini 批量向量化：:batchEmbedContents ──
      if (url.includes(":batchEmbedContents")) {
        const requests = Array.isArray(body.requests) ? body.requests : [];
        json(res, { embeddings: requests.map(() => ({ values: [0.1, 0.2, 0.3] })) });
        return;
      }

      // ── 5. OpenAI 兼容 embeddings：/embeddings ──
      if (url.includes("/embeddings")) {
        const input = typeof body.input === "string" ? [body.input] : Array.isArray(body.input) ? body.input : [];
        json(res, {
          object: "list",
          data: input.map((_, i) => ({ object: "embedding", index: i, embedding: [0.1, 0.2, 0.3] })),
          model: body.model ?? "embed-test",
          usage: { prompt_tokens: 8, total_tokens: 8 },
        });
        return;
      }

      // ── 6. OpenAI 兼容 audio：STT（multipart，按 response_format 返回）+ TTS（二进制） ──
      if (url.includes("/audio/transcriptions") || url.includes("/audio/translations")) {
        // multipart body 里直接搜 response_format 标记（mock 不解析 multipart）
        const verbose = raw.includes("verbose_json");
        json(res, verbose ? { task: "transcribe", text: "mock transcript", duration: 120, segments: [] } : { text: "mock transcript" });
        return;
      }
      if (url.includes("/audio/speech")) {
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        res.end(Buffer.from("MOCKAUDIO"));
        return;
      }

      // ── 7. 视频任务提交（OpenAI Videos：POST /v1/videos → id/status） ──
      if (/\/videos$/.test(url) || url.includes("/videos/generations")) {
        json(res, { id: "mock-vtask-1", object: "video", status: "queued", progress: 0 });
        return;
      }

      res.writeHead(404).end();
    });
  });
  server.unref(); // keep-alive 连接不阻塞 teardown 退出
  return new Promise((resolve) => server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server)));
}

function waitFor(url: string, timeoutMs: number, expectStatus?: number[]): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (!expectStatus || expectStatus.includes(r.status)) return resolve();
        if (Date.now() > deadline) return reject(new Error(`unexpected status ${r.status}`));
      } catch {
        if (Date.now() > deadline) return reject(new Error(`timeout waiting ${url}`));
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

// chat 模型 fixture（endpoint + per-1k token 定价，与 gpt-test 同价）
async function chatModelFixture(
  db: import("@prisma/client").PrismaClient,
  vendorId: number,
  name: string,
  opts?: { capabilities?: Record<string, unknown> }
) {
  const model = await db.aiModel.upsert({
    where: { vendorId_name: { vendorId, name } },
    update: { status: "online", endpointType: "chat", capabilities: (opts?.capabilities ?? null) as never },
    create: {
      vendorId,
      name,
      displayName: name,
      endpointType: "chat",
      status: "online",
      capabilities: (opts?.capabilities ?? null) as never,
    },
  });
  await db.modelEndpoint.upsert({
    where: { modelId_path: { modelId: model.id, path: "chat_completions" } },
    update: { enabled: true },
    create: { modelId: model.id, path: "chat_completions", enabled: true },
  });
  const pricingExists = await db.modelPricing.findFirst({ where: { modelId: model.id } });
  if (!pricingExists) {
    await db.modelPricing.create({
      data: {
        modelId: model.id,
        meterBase: 1000,
        unit: "token",
        inputPrice: 0.5,
        outputPrice: 1,
        currency: "CNY",
        memberInputPrice: 1,
        memberOutputPrice: 2,
        effectiveAt: new Date(Date.now() - 60000),
      },
    });
  }
  return model;
}

// embedding 模型 fixture（按 input tokens 计费）
async function embedModelFixture(db: import("@prisma/client").PrismaClient, vendorId: number, name: string) {
  const model = await db.aiModel.upsert({
    where: { vendorId_name: { vendorId, name } },
    update: { status: "online", endpointType: "embedding" },
    create: { vendorId, name, displayName: name, endpointType: "embedding", status: "online" },
  });
  await db.modelEndpoint.upsert({
    where: { modelId_path: { modelId: model.id, path: "embeddings" } },
    update: { enabled: true },
    create: { modelId: model.id, path: "embeddings", enabled: true },
  });
  const pricingExists = await db.modelPricing.findFirst({ where: { modelId: model.id } });
  if (!pricingExists) {
    await db.modelPricing.create({
      data: {
        modelId: model.id,
        meterBase: 1000,
        unit: "token",
        inputPrice: 0.2,
        outputPrice: 0,
        currency: "CNY",
        memberInputPrice: 1,
        memberOutputPrice: 0,
        effectiveAt: new Date(Date.now() - 60000),
      },
    });
  }
  return model;
}

// audio 模型 fixture（STT 按分钟 / TTS 按千字符，pricing 由调用方给定）
async function audioModelFixture(
  db: import("@prisma/client").PrismaClient,
  vendorId: number,
  name: string,
  endpointPaths: string[],
  pricing: { unit: string; meterBase: number; memberInputPrice: number }
) {
  const model = await db.aiModel.upsert({
    where: { vendorId_name: { vendorId, name } },
    update: { status: "online", endpointType: "audio" },
    create: { vendorId, name, displayName: name, endpointType: "audio", status: "online" },
  });
  for (const path of endpointPaths) {
    await db.modelEndpoint.upsert({
      where: { modelId_path: { modelId: model.id, path } },
      update: { enabled: true },
      create: { modelId: model.id, path, enabled: true },
    });
  }
  const pricingExists = await db.modelPricing.findFirst({ where: { modelId: model.id } });
  if (!pricingExists) {
    await db.modelPricing.create({
      data: {
        modelId: model.id,
        meterBase: pricing.meterBase,
        unit: pricing.unit,
        inputPrice: 0.5,
        outputPrice: 0,
        currency: "CNY",
        memberInputPrice: pricing.memberInputPrice,
        memberOutputPrice: 0,
        effectiveAt: new Date(Date.now() - 60000),
      },
    });
  }
  return model;
}

async function vendorFixture(db: import("@prisma/client").PrismaClient, slug: string, name: string, apiBase: string, protocol: string) {
  const vendor = await db.aiVendor.upsert({
    where: { slug },
    update: { apiBase, status: "online", protocol },
    create: { name, slug, apiBase, protocol, status: "online" },
  });
  const existingKey = await db.vendorApiKey.findFirst({ where: { vendorId: vendor.id, name: "test-key" } });
  if (!existingKey) {
    await db.vendorApiKey.create({
      data: {
        vendorId: vendor.id,
        name: "test-key",
        keyPrefix: "sk-mock",
        keyCipher: encryptSecretFix(`mock-${slug}-key`),
        status: "active",
      },
    });
  }
  return vendor;
}

// encryptSecret 惰性引用（顶层 import 会拖慢 db-setup 之前的模块加载顺序）
let _encryptSecret: ((s: string) => string) | null = null;
function encryptSecretFix(s: string): string {
  if (!_encryptSecret) throw new Error("encryptSecret not initialized");
  return _encryptSecret(s);
}

export default async function setup(ctx: GlobalSetupContext) {
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.STORAGE_KEY_SECRET = ENV.STORAGE_KEY_SECRET;
  process.env.JWT_SECRET = ENV.JWT_SECRET;
  process.env.JWT_ADMIN_SECRET = ENV.JWT_ADMIN_SECRET;
  process.env.API_GATEWAY_HOSTS = ENV.API_GATEWAY_HOSTS;
  process.env.NEXT_PUBLIC_SITE_URL = ENV.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_TELEMETRY_DISABLED = "1";

  // 1. 建测试库 + schema 同步（幂等）
  await ensureTestDb();

  // 2. fixtures（@/ 别名在 vitest 下可用）
  const { db } = await import("@/lib/db");
  const { grant, getBalance } = await import("@/lib/credits");
  const { createApiKey } = await import("@/lib/apikey");
  const { encryptSecret } = await import("@/lib/crypto");
  _encryptSecret = encryptSecret;

  const user = await db.user.upsert({
    where: { username: "e2e-user" },
    update: { status: "active" },
    create: { username: "e2e-user", passwordHash: "x", status: "active" },
  });
  // 余额固定 10000（grant 幂等：userId+grantType+sourceRef 唯一）
  await grant(user.id, "trial", 10000n, "e2e-fixture-10000").catch(() => {});

  const poor = await db.user.upsert({
    where: { username: "e2e-poor" },
    update: { status: "active" },
    create: { username: "e2e-poor", passwordHash: "x", status: "active" },
  });

  // 三协议厂商
  const vendor = await vendorFixture(db, "test-mock", "test-mock-vendor", `http://127.0.0.1:${MOCK_PORT}`, "openai");
  const anthVendor = await vendorFixture(db, "test-mock-anthropic", "test-mock-anthropic", `http://127.0.0.1:${MOCK_PORT}/anthropic`, "anthropic");
  const gemVendor = await vendorFixture(db, "test-mock-gemini", "test-mock-gemini", `http://127.0.0.1:${MOCK_PORT}/gemini/v1beta`, "gemini");

  // 网关白名单走运行时数据（SiteSetting）：NEXT_PUBLIC_* 构建期内联，环境变量覆盖无效
  await db.siteSetting.upsert({
    where: { key: "api_gateway_routes" },
    update: { value: JSON.stringify([{ name: "test-local", url: `http://127.0.0.1:${APP_PORT}/v1` }]) },
    create: {
      key: "api_gateway_routes",
      value: JSON.stringify([{ name: "test-local", url: `http://127.0.0.1:${APP_PORT}/v1` }]),
    },
  });

  const model = await chatModelFixture(db, vendor.id, "gpt-test");
  const claude = await chatModelFixture(db, anthVendor.id, "claude-test");
  // 能力协商 fixture：白名单只放 temperature → 请求 max_tokens 应 400 指名
  const claudeStrict = await chatModelFixture(db, anthVendor.id, "claude-strict", { capabilities: { params: ["temperature"] } });
  const gemini = await chatModelFixture(db, gemVendor.id, "gemini-test");
  // embedding 模型（openai / gemini 协议各一）
  const embed = await embedModelFixture(db, vendor.id, "embed-test");
  const embedG = await embedModelFixture(db, gemVendor.id, "embed-gtest");
  // audio 模型：whisper（STT，按分钟 10 积分/分钟）+ tts（按千字符 2 积分）
  const whisper = await audioModelFixture(db, vendor.id, "whisper-test", ["audio_transcriptions", "audio_translations"], { unit: "audio_minute", meterBase: 1, memberInputPrice: 10 });
  const tts = await audioModelFixture(db, vendor.id, "tts-test", ["audio_speech"], { unit: "char", meterBase: 1000, memberInputPrice: 2 });
  // video 模型（P6 #19 异步任务）：按秒计费 10 积分/秒
  const video = await db.aiModel.upsert({
    where: { vendorId_name: { vendorId: vendor.id, name: "video-test" } },
    update: { status: "online", endpointType: "video" },
    create: { vendorId: vendor.id, name: "video-test", displayName: "video-test", endpointType: "video", status: "online" },
  });
  await db.modelEndpoint.upsert({
    where: { modelId_path: { modelId: video.id, path: "video_generations" } },
    update: { enabled: true },
    create: { modelId: video.id, path: "video_generations", enabled: true },
  });
  // 清理历史脏数据（早期 fixture 曾误建 embeddings 端点）
  await db.modelEndpoint.deleteMany({ where: { modelId: video.id, path: "embeddings" } });
  const videoPricingExists = await db.modelPricing.findFirst({ where: { modelId: video.id } });
  if (!videoPricingExists) {
    await db.modelPricing.create({
      data: {
        modelId: video.id,
        meterBase: 1,
        unit: "video_second",
        inputPrice: 0.5,
        outputPrice: 0,
        currency: "CNY",
        memberInputPrice: 10,
        memberOutputPrice: 0,
        effectiveAt: new Date(Date.now() - 60000),
      },
    });
  }

  const key = await createApiKey(user.id, null, "e2e-key");
  const poorKey = await createApiKey(poor.id, null, "e2e-key");

  const balance = await getBalance(user.id);

  // 3. mock 上游
  const mockServer = await startMockUpstream();

  // 4. next start（生产模式，:3100，指向测试库）
  const proj = process.cwd();
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", String(APP_PORT)],
    {
      cwd: proj,
      env: { ...process.env, ...ENV, NODE_ENV: "production" },
      stdio: "ignore",
      // Trae shell 无控制台，不隐藏会为 next 子进程分配可见控制台
      windowsHide: true,
    }
  );
  await waitFor(`${APP_BASE}/api/settings`, 90_000, [200]);

  // provide：globalSetup 与测试 worker 不共享 globalThis，必须走 vitest 注入
  ctx.provide("e2e", {
    token: key.plaintext,
    poorToken: poorKey.plaintext,
    userId: user.id,
    poorUserId: poor.id,
    vendorId: vendor.id,
    modelId: model.id,
    claudeModelId: claude.id,
    geminiModelId: gemini.id,
    strictModelId: claudeStrict.id,
    embedModelId: embed.id,
    embedGModelId: embedG.id,
    whisperModelId: whisper.id,
    ttsModelId: tts.id,
    videoModelId: video.id,
    balance: balance.toString(),
  });

  // teardown：杀服务树 + 关 mock + 断开 db
  return async () => {
    try {
      const pid = String(child.pid ?? "");
      if (pid && process.platform === "win32") {
        // 不经 shell 调 taskkill：避免 cmd.exe 弹窗；taskkill.exe 本身即可完成树杀
        spawnSync("taskkill.exe", ["/PID", pid, "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
    mockServer.close();
    await db.$disconnect();
  };
}
