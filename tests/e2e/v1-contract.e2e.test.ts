import { describe, it, expect, inject } from "vitest";
import request from "supertest";

// ─── /v1 契约测试：真实 next 服务 + mock OpenAI 上游 + prompthub_test 库 ───
// 覆盖：鉴权 / 错误体形状 / 全链路计费（预扣→结算→退差）/ Idempotency-Key 重放 / SSE

const BASE = "http://127.0.0.1:3100";
const g = () => inject<any>("e2e");

const req = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function balanceOf(userId: number): Promise<bigint> {
  // 通过 vitest 进程直连测试库读余额（ DATABASE_URL 在 global-setup 已注入 vitest 进程）
  const { getBalance } = await import("@/lib/credits");
  return getBalance(userId);
}
async function ledgerRows(requestId: string) {
  const { db } = await import("@/lib/db");
  return db.creditLedger.findMany({ where: { OR: [{ requestId }, { requestId: { startsWith: `${requestId}:` } }] }, orderBy: { id: "asc" } });
}

describe("GET /v1/models", () => {
  it("无 Authorization → 401 invalid_request 错误体", async () => {
    const r = await req().get("/v1/models").send();
    expect(r.status).toBe(401);
    const e = r.body.error;
    expect(e.message).toBeTruthy();
    expect(e.type).toBe("authentication_error");
    expect(e.code).toBeTruthy();
    expect(e.param).toBe(null);
  });

  it("无效 Key → 401", async () => {
    const r = await req().get("/v1/models").set(auth("sk-does-not-exist")).send();
    expect(r.status).toBe(401);
    expect(r.body.error.type).toBe("authentication_error");
  });

  it("有效 Key → 200，包含 gpt-test（健康渠道+已定价）", async () => {
    const r = await req().get("/v1/models").set(auth(g().token)).send();
    expect(r.status).toBe(200);
    expect(r.body.object).toBe("list");
    const ids = r.body.data.map((m: any) => m.id);
    expect(ids).toContain("gpt-test");
    const m = r.body.data.find((x: any) => x.id === "gpt-test");
    expect(m.owned_by).toBe("test-mock-vendor");
    expect(m.endpoint_type).toBe("chat");
  });
});

describe("POST /v1/chat/completions（mock 上游全链路）", () => {
  const goodBody = {
    model: "gpt-test",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 16,
  };

  it("无效 Key → 401", async () => {
    const r = await req().post("/v1/chat/completions").set(auth("sk-bad")).send(goodBody);
    expect(r.status).toBe(401);
    expect(r.body.error.type).toBe("authentication_error");
  });

  it("非法请求体 → 400 invalid_request_error", async () => {
    const r = await req().post("/v1/chat/completions").set(auth(g().token)).send({ model: "gpt-test" });
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe("invalid_request_error");
  });

  it("不存在模型 → 404 model_not_found", async () => {
    const r = await req()
      .post("/v1/chat/completions")
      .set(auth(g().token))
      .send({ model: "no-such-model", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("model_not_found");
    expect(r.body.error.type).toBe("invalid_request_error");
  });

  it("零余额用户 → 402 insufficient_credits", async () => {
    const r = await req().post("/v1/chat/completions").set(auth(g().poorToken)).send(goodBody);
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe("insufficient_credits");
    expect(r.body.error.type).toBe("insufficient_quota");
  });

  it("成功（非流式）：OpenAI 响应透传 + usage 入账 + 净扣 1 积分", async () => {
    const before = await balanceOf(g().userId);
    const r = await req().post("/v1/chat/completions").set(auth(g().token)).send(goodBody);
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content).toBe("mock-ok");
    expect(r.body.usage.prompt_tokens).toBe(10);
    expect(r.body.usage.completion_tokens).toBe(5);

    const after = await balanceOf(g().userId);
    // 计费：usage 10/5 → member(1/2 积分每 1k) = 10+10 milli = 20 → ceil/1000 = 1 积分
    expect(before - after).toBe(1n);

    const usage = await (await import("@/lib/db")).db.usageRecord.findFirst({
      where: { userId: g().userId, modelSnapshot: "gpt-test", status: "success" },
      orderBy: { id: "desc" },
    });
    expect(usage).toBeTruthy();
    expect(Number(usage!.paidCredits)).toBe(1);
    expect(usage!.promptTokens).toBe(10);
    expect(usage!.outputTokens).toBe(5);
    // P3 价格版本快照（调价不回写历史）
    expect(usage!.priceVersionId).toBeTruthy();
    const snap = JSON.parse(usage!.priceSnapshot || "{}");
    expect(snap.meterBase).toBe(1000);
    expect(snap.memberInputPrice).toBe("1");
  });

  it("Idempotency-Key 重放：两次请求只扣一次费（账本单条预扣）", async () => {
    const key = `e2e-replay-${Date.now()}`;
    const before = await balanceOf(g().userId);

    const r1 = await req()
      .post("/v1/chat/completions")
      .set({ ...auth(g().token), "Idempotency-Key": key })
      .send(goodBody);
    expect(r1.status).toBe(200);

    const r2 = await req()
      .post("/v1/chat/completions")
      .set({ ...auth(g().token), "Idempotency-Key": key })
      .send(goodBody);
    expect(r2.status).toBe(200);
    // 响应级幂等：第二次直接回放上次的成功响应，不再打上游
    expect(r2.headers["idempotent-replayed"]).toBe("true");
    expect(r2.body).toEqual(r1.body);

    const after = await balanceOf(g().userId);
    // 两次调用但账本幂等：净扣仍为 1 积分（一次预扣一次结算）
    expect(before - after).toBe(1n);

    // requestId 自 L1 起绑定「端点 + 模型 + body 指纹」，按前缀匹配负数预扣流水
    // （排除 changeAmount=0 的 :decision 决策行与 :settle 差额行）
    const { db: tdb } = await import("@/lib/db");
    const consumes = await tdb.creditLedger.findMany({
      where: {
        userId: g().userId,
        reason: "consume",
        changeAmount: { lt: 0n },
        requestId: { startsWith: `idem-${g().userId}-${key}-` },
      },
    });
    expect(consumes.length).toBe(1); // 预扣只发生一次
  });

  it("流式：text/event-stream + X-Accel-Buffering 头 + mock-ok + [DONE]，计费一致", async () => {
    const before = await balanceOf(g().userId);
    const r = await req()
      .post("/v1/chat/completions")
      .set(auth(g().token))
      .send({ ...goodBody, stream: true });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/event-stream");
    // P2：禁用 Nginx 代理缓冲（应用层声明，无需依赖 nginx 配置）
    expect(r.headers["x-accel-buffering"]).toBe("no");
    expect(r.text).toContain("mock-ok");
    expect(r.text).toContain("[DONE]");

    const after = await balanceOf(g().userId);
    expect(before - after).toBe(1n);
  });

  it("错误体不泄漏上游密钥/内部 URL", async () => {
    const r = await req().post("/v1/chat/completions").set(auth(g().token)).send(goodBody);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("mock-upstream-key");
    expect(text).not.toContain("127.0.0.1:19800");
  });
});

// ─── P4 多协议：Anthropic / Gemini 上游经协议转换后统一 OpenAI 形状 ───

describe("P4 POST /v1/chat/completions（Anthropic 协议）", () => {
  const body = { model: "claude-test", messages: [{ role: "user", content: "hi" }], max_tokens: 16 };

  it("非流式：Anthropic 响应转 OpenAI 形状 + usage 10/5 + 净扣 1 积分", async () => {
    const before = await balanceOf(g().userId);
    const r = await req().post("/v1/chat/completions").set(auth(g().token)).send(body);
    expect(r.status).toBe(200);
    expect(r.body.object).toBe("chat.completion");
    expect(r.body.choices[0].message.content).toBe("mock-ok");
    expect(r.body.choices[0].finish_reason).toBe("stop");
    expect(r.body.usage.prompt_tokens).toBe(10);
    expect(r.body.usage.completion_tokens).toBe(5);

    const after = await balanceOf(g().userId);
    expect(before - after).toBe(1n); // 10/5 tokens，member 1/2 每 1k → ceil(20milli/1000)=1

    const usage = await (await import("@/lib/db")).db.usageRecord.findFirst({
      where: { userId: g().userId, modelSnapshot: "claude-test", status: "success" },
      orderBy: { id: "desc" },
    });
    expect(usage).toBeTruthy();
    expect(usage!.promptTokens).toBe(10);
    expect(usage!.outputTokens).toBe(5);
    expect(Number(usage!.paidCredits)).toBe(1);
  });

  it("流式：Anthropic SSE 转 OpenAI chunk（role→content→finish→usage→[DONE]）+ 计费一致", async () => {
    const before = await balanceOf(g().userId);
    const r = await req().post("/v1/chat/completions").set(auth(g().token)).send({ ...body, stream: true });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/event-stream");
    expect(r.headers["x-accel-buffering"]).toBe("no");
    // 转换后的内容块
    expect(r.text).toContain('"content":"mock-ok"');
    expect(r.text).toContain('"content":"-sse"');
    // finish_reason 帧 + 最终 usage 帧（OpenAI include_usage 惯例）+ [DONE]
    expect(r.text).toContain('"finish_reason":"stop"');
    expect(r.text).toContain('"prompt_tokens":10');
    expect(r.text).toContain('"completion_tokens":5');
    expect(r.text).toContain("[DONE]");

    const after = await balanceOf(g().userId);
    expect(before - after).toBe(1n);
  });
});

describe("P4 POST /v1/chat/completions（Gemini 协议）", () => {
  const body = { model: "gemini-test", messages: [{ role: "user", content: "hi" }], max_tokens: 16 };

  it("非流式：Gemini 响应转 OpenAI 形状 + usage 10/5 + 净扣 1 积分", async () => {
    const before = await balanceOf(g().userId);
    const r = await req().post("/v1/chat/completions").set(auth(g().token)).send(body);
    expect(r.status).toBe(200);
    expect(r.body.object).toBe("chat.completion");
    expect(r.body.choices[0].message.content).toBe("mock-ok");
    expect(r.body.usage.prompt_tokens).toBe(10);
    expect(r.body.usage.completion_tokens).toBe(5);

    const after = await balanceOf(g().userId);
    expect(before - after).toBe(1n);
  });

  it("流式：Gemini alt=sse 转 OpenAI chunk + usage + [DONE]，计费一致", async () => {
    const before = await balanceOf(g().userId);
    const r = await req().post("/v1/chat/completions").set(auth(g().token)).send({ ...body, stream: true });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/event-stream");
    expect(r.text).toContain('"content":"mock-ok"');
    expect(r.text).toContain('"content":"-sse"');
    expect(r.text).toContain('"finish_reason":"stop"');
    expect(r.text).toContain('"prompt_tokens":10');
    expect(r.text).toContain('"completion_tokens":5');
    expect(r.text).toContain("[DONE]");

    const after = await balanceOf(g().userId);
    expect(before - after).toBe(1n);
  });
});

describe("P4 #17 能力协商", () => {
  it("白名单外参数 → 400 unsupported_parameter，指名参数且不进计费", async () => {
    const before = await balanceOf(g().userId);
    // claude-strict 白名单只有 temperature：max_tokens 不在白名单
    const r = await req()
      .post("/v1/chat/completions")
      .set(auth(g().token))
      .send({ model: "claude-strict", messages: [{ role: "user", content: "hi" }], temperature: 0.5, max_tokens: 16 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("unsupported_parameter");
    expect(r.body.error.type).toBe("invalid_request_error");
    expect(r.body.error.message).toContain("max_tokens");

    const after = await balanceOf(g().userId);
    expect(after).toBe(before); // 能力拒绝发生在预扣之前，余额不变
  });

  it("白名单内参数 + 未配置 capabilities 的模型全透传（向后兼容）", async () => {
    // claude-strict 只带 temperature（白名单内）→ 正常走通
    const r = await req()
      .post("/v1/chat/completions")
      .set(auth(g().token))
      .send({ model: "claude-strict", messages: [{ role: "user", content: "hi" }], temperature: 0.5 });
    expect(r.status).toBe(200);
    // gpt-test 未配置 capabilities → 任意参数透传
    const r2 = await req()
      .post("/v1/chat/completions")
      .set(auth(g().token))
      .send({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], logit_bias: { x: 1 } });
    expect(r2.status).toBe(200);
  });
});

describe("P4 POST /v1/embeddings", () => {
  it("openai 协议：list 形状 + usage 8 tokens → 净扣 1 积分", async () => {
    const before = await balanceOf(g().userId);
    const r = await req().post("/v1/embeddings").set(auth(g().token)).send({ model: "embed-test", input: "hello world" });
    expect(r.status).toBe(200);
    expect(r.body.object).toBe("list");
    expect(r.body.data[0].embedding).toEqual([0.1, 0.2, 0.3]);

    const after = await balanceOf(g().userId);
    expect(before - after).toBe(1n); // usage.prompt_tokens=8 → memberSideMilli=8 → ceil(8/1000)=1

    const usage = await (await import("@/lib/db")).db.usageRecord.findFirst({
      where: { userId: g().userId, modelSnapshot: "embed-test", status: "success" },
      orderBy: { id: "desc" },
    });
    expect(usage).toBeTruthy();
    expect(usage!.promptTokens).toBe(8);
    expect(usage!.outputTokens).toBe(0);
    expect(usage!.endpointType).toBe("embedding");
    expect(Number(usage!.paidCredits)).toBe(1);
  });

  it("openai 协议：多段输入 → data 长度与输入一致", async () => {
    const r = await req().post("/v1/embeddings").set(auth(g().token)).send({ model: "embed-test", input: ["a", "bb", "ccc"] });
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBe(3);
    expect(r.body.data[2].index).toBe(2);
  });

  it("gemini 协议：batchEmbedContents 转换为 list 形状 + 计费按输入 tokens", async () => {
    const before = await balanceOf(g().userId);
    const r = await req().post("/v1/embeddings").set(auth(g().token)).send({ model: "embed-gtest", input: ["hello", "world"] });
    expect(r.status).toBe(200);
    expect(r.body.object).toBe("list");
    expect(r.body.data.length).toBe(2);
    expect(r.body.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(r.body.model).toBe("embed-gtest");

    const after = await balanceOf(g().userId);
    expect(before - after).toBe(1n); // gemini 无 usage，字符粗估 → ceil 分级后最低 1 积分
  });

  it("chat 模型不支持 embeddings 端点 → 404 endpoint_disabled", async () => {
    const r = await req().post("/v1/embeddings").set(auth(g().token)).send({ model: "gpt-test", input: "hi" });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("endpoint_disabled");
  });

  it("无效请求体（缺 input）→ 400", async () => {
    const r = await req().post("/v1/embeddings").set(auth(g().token)).send({ model: "embed-test" });
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe("invalid_request_error");
  });
});

// ─── P4 #21 /v1/audio：转写/翻译（multipart，按分钟计费）+ TTS（按千字符计费） ───

describe("P4 POST /v1/audio/transcriptions", () => {
  it("非流式 json：text 透传 + 按文件大小粗估 1 分钟净扣 10 积分", async () => {
    const before = await balanceOf(g().userId);
    const r = await req()
      .post("/v1/audio/transcriptions")
      .set(auth(g().token))
      .field("model", "whisper-test")
      .attach("file", Buffer.from("fake-mp3-bytes"), "a.mp3");
    expect(r.status).toBe(200);
    expect(r.body.text).toBe("mock transcript");

    const after = await balanceOf(g().userId);
    expect(before - after).toBe(10n); // 小文件无 duration → 1 分钟 × 10 积分/分钟

    const usage = await (await import("@/lib/db")).db.usageRecord.findFirst({
      where: { userId: g().userId, modelSnapshot: "whisper-test", status: "success", endpointType: "audio" },
      orderBy: { id: "desc" },
    });
    expect(usage).toBeTruthy();
    expect(Number(usage!.unitCount)).toBe(1);
    expect(Number(usage!.paidCredits)).toBe(10);
  });

  it("verbose_json：duration=120s → 2 分钟 20 积分，预扣 10 补扣结算净扣 20", async () => {
    const before = await balanceOf(g().userId);
    const r = await req()
      .post("/v1/audio/transcriptions")
      .set(auth(g().token))
      .field("model", "whisper-test")
      .field("response_format", "verbose_json")
      .attach("file", Buffer.from("fake-mp3-bytes"), "a.mp3");
    expect(r.status).toBe(200);
    expect(r.body.duration).toBe(120);

    const after = await balanceOf(g().userId);
    expect(before - after).toBe(20n); // 2 分钟 × 10；预扣按文件粗估 10，结算补扣至 20（≤ est×3 封顶）

    const usage = await (await import("@/lib/db")).db.usageRecord.findFirst({
      where: { userId: g().userId, modelSnapshot: "whisper-test", status: "success" },
      orderBy: { id: "desc" },
    });
    expect(Number(usage!.unitCount)).toBe(2);
    expect(Number(usage!.paidCredits)).toBe(20);
  });

  it("chat 模型不支持 audio 端点 → 404 endpoint_disabled；缺 file → 400", async () => {
    const r = await req().post("/v1/audio/transcriptions").set(auth(g().token)).field("model", "gpt-test").attach("file", Buffer.from("x"), "a.mp3");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("endpoint_disabled");

    const r2 = await req().post("/v1/audio/transcriptions").set(auth(g().token)).field("model", "whisper-test");
    expect(r2.status).toBe(400);
    expect(r2.body.error.type).toBe("invalid_request_error");
  });
});

describe("P4 POST /v1/audio/translations", () => {
  it("成功：mock transcript + 净扣 10 积分", async () => {
    const before = await balanceOf(g().userId);
    const r = await req()
      .post("/v1/audio/translations")
      .set(auth(g().token))
      .field("model", "whisper-test")
      .attach("file", Buffer.from("fake-mp3-bytes"), "a.mp3");
    expect(r.status).toBe(200);
    expect(r.body.text).toBe("mock transcript");

    const after = await balanceOf(g().userId);
    expect(before - after).toBe(10n);
  });
});

describe("P4 POST /v1/audio/speech", () => {
  it("TTS：二进制音频透传 + 按输入字符数计费（11 字符 → 1 积分）", async () => {
    const before = await balanceOf(g().userId);
    const r = await req()
      .post("/v1/audio/speech")
      .set(auth(g().token))
      .send({ model: "tts-test", input: "hello world", voice: "alloy" });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("audio/mpeg");
    const out = r.body && r.body.length ? (r.body as Buffer).toString("utf8") : r.text;
    expect(out).toBe("MOCKAUDIO");

    const after = await balanceOf(g().userId);
    expect(before - after).toBe(1n); // 11 字符 × 2/千字符 = 22 milli → ceil = 1

    const usage = await (await import("@/lib/db")).db.usageRecord.findFirst({
      where: { userId: g().userId, modelSnapshot: "tts-test", status: "success", endpointType: "audio" },
      orderBy: { id: "desc" },
    });
    expect(usage).toBeTruthy();
    expect(Number(usage!.unitCount)).toBe(11);
    expect(Number(usage!.paidCredits)).toBe(1);
  });

  it("缺 voice → 400；whisper 模型不支持 speech → 404", async () => {
    const r = await req().post("/v1/audio/speech").set(auth(g().token)).send({ model: "tts-test", input: "hi" });
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe("invalid_request_error");

    const r2 = await req().post("/v1/audio/speech").set(auth(g().token)).send({ model: "whisper-test", input: "hi", voice: "alloy" });
    expect(r2.status).toBe(404);
    expect(r2.body.error.code).toBe("endpoint_disabled");
  });
});

// ─── P6 #19 /v1/videos 异步任务：创建即返 task_id → 轮询终态 → 计费闭环 ───

describe("P6 POST /v1/videos（异步任务状态机）", () => {
  const body = { model: "video-test", prompt: "a cat", duration: 5 };

  // 轮询到终态（内部任务轮询 500ms，mock 首查即 succeeded）
  async function pollFinal(taskId: string, token: string): Promise<Record<string, unknown>> {
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      const q = await req().get(`/v1/videos/${taskId}`).set(auth(token)).send();
      last = q.body;
      if (["succeeded", "failed"].includes(String(last.status))) break;
      await new Promise((res) => setTimeout(res, 400));
    }
    return last;
  }

  it("创建 202 → 轮询 succeeded → 兑底产物 URL + 净扣 50 积分（5 秒 × 10）", async () => {
    const before = await balanceOf(g().userId);
    const r = await req().post("/v1/videos").set(auth(g().token)).send(body);
    expect(r.status).toBe(202);
    expect(r.body.task_id).toMatch(/^vt-/);
    expect(["queued", "processing", "succeeded"]).toContain(r.body.status);

    const final = await pollFinal(r.body.task_id, g().token);
    expect(final.status).toBe("succeeded");
    // 产物为转存资产签名 URL（mock 地址在本环境可下载 → 转存成功；SSRF 兜底路径由线上语义保证）
    expect(String(final.video.url)).toContain("/api/member/assets/");
    expect(final.video.asset_id).toBeTruthy();
    expect(final.progress).toBe(100);

    const after = await balanceOf(g().userId);
    expect(before - after).toBe(50n); // duration 5s × 10 积分/秒

    const usage = await (await import("@/lib/db")).db.usageRecord.findFirst({
      where: { userId: g().userId, modelSnapshot: "video-test", status: "success", endpointType: "video" },
      orderBy: { id: "desc" },
    });
    expect(usage).toBeTruthy();
    expect(Number(usage!.unitCount)).toBe(5);
    expect(Number(usage!.paidCredits)).toBe(50);
    // P3 价格快照
    expect(usage!.priceVersionId).toBeTruthy();

    const task = await (await import("@/lib/db")).db.videoTask.findUnique({ where: { taskId: r.body.task_id } });
    expect(task?.status).toBe("succeeded");
    expect(task?.vendorKeyId).toBeTruthy();
  });

  it("Idempotency-Key 重放：同一 task_id、净扣一次", async () => {
    const key = `e2e-video-${Date.now()}`;
    const before = await balanceOf(g().userId);

    const r1 = await req().post("/v1/videos").set({ ...auth(g().token), "Idempotency-Key": key }).send(body);
    expect(r1.status).toBe(202);
    await pollFinal(r1.body.task_id, g().token);

    const r2 = await req().post("/v1/videos").set({ ...auth(g().token), "Idempotency-Key": key }).send(body);
    expect(r2.status).toBe(200); // 幂等命中返回已有任务
    expect(r2.body.task_id).toBe(r1.body.task_id);

    const after = await balanceOf(g().userId);
    expect(before - after).toBe(50n);
  });

  it("零余额 → 402；chat 模型 → 404 endpoint_disabled", async () => {
    const r = await req().post("/v1/videos").set(auth(g().poorToken)).send(body);
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe("insufficient_credits");

    const r2 = await req().post("/v1/videos").set(auth(g().token)).send({ model: "gpt-test", prompt: "x" });
    expect(r2.status).toBe(404);
    expect(r2.body.error.code).toBe("endpoint_disabled");
  });

  it("他人任务 / 不存在任务 → 404 task_not_found", async () => {
    const created = await req().post("/v1/videos").set(auth(g().token)).send(body);
    const taskId = created.body.task_id as string;
    await pollFinal(taskId, g().token);

    const r1 = await req().get(`/v1/videos/${taskId}`).set(auth(g().poorToken)).send();
    expect(r1.status).toBe(404);
    expect(r1.body.error.code).toBe("task_not_found");

    const r2 = await req().get("/v1/videos/vt-not-exist").set(auth(g().token)).send();
    expect(r2.status).toBe(404);
  });
});
