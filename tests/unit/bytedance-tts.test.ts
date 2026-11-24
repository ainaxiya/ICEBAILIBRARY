import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCreateBody,
  buildSubmitBody,
  callBytedanceTtsCreate,
  callBytedanceTtsSubmit,
  illegalControlRatio,
  mapAudioFormat,
  mapSpeedToSpeechRate,
  mapUpstreamError,
  resolveBytedanceTtsConfig,
  validateReferences,
  waitBytedanceTtsTask,
} from "@/lib/gateway/adapters/bytedance-tts";
import { displayMemberCredits } from "@/lib/gateway/pricing";

// 字节跳动（bytedance）语音适配器：模式判定 / 参数映射 / 响应解析 / 错误码 / 计费单位

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BYTEDANCE_TTS_ASYNC_WAIT_MS;
  delete process.env.BYTEDANCE_TTS_POLL_MIN_MS;
  delete process.env.BYTEDANCE_TTS_POLL_MAX_MS;
});

describe("resolveBytedanceTtsConfig", () => {
  it("seed-audio-* 走同步 create", () => {
    expect(resolveBytedanceTtsConfig("seed-audio-1.0")?.mode).toBe("create");
    expect(resolveBytedanceTtsConfig("seed-audio-1.0")?.modelName).toBe("seed-audio-1.0");
  });

  it("seed-tts-* / seed-icl-* 走异步 submit，并截出主版本号作为 Resource-Id", () => {
    expect(resolveBytedanceTtsConfig("seed-tts-2.0")).toEqual({ mode: "submit", resourceId: "seed-tts-2.0" });
    expect(resolveBytedanceTtsConfig("seed-tts-2.0-standard")).toEqual({ mode: "submit", resourceId: "seed-tts-2.0" });
    expect(resolveBytedanceTtsConfig("seed-icl-2.0")).toEqual({ mode: "submit", resourceId: "seed-icl-2.0" });
  });

  it("advancedConfig 可显式覆盖（含历史 openspeech 键）", () => {
    const cfg = resolveBytedanceTtsConfig("my-tts", '{"bytedance":{"mode":"submit","resourceId":"seed-icl-2.0"}}');
    expect(cfg).toEqual({ mode: "submit", resourceId: "seed-icl-2.0" });
    const legacy = resolveBytedanceTtsConfig("my-tts", '{"openspeech":{"mode":"submit","resourceId":"seed-tts-2.0"}}');
    expect(legacy).toEqual({ mode: "submit", resourceId: "seed-tts-2.0" });
  });

  it("非法模型返回 null", () => {
    expect(resolveBytedanceTtsConfig("gpt-4o-mini-tts")).toBeNull();
  });
});

describe("格式与语速映射", () => {
  it("opus → ogg_opus；aac/flac 明确不支持", () => {
    expect(mapAudioFormat(undefined, "create")).toEqual({ format: "mp3" });
    expect(mapAudioFormat("opus", "create")).toEqual({ format: "ogg_opus" });
    expect(mapAudioFormat("wav", "create")).toEqual({ format: "wav" });
    expect("error" in mapAudioFormat("aac", "create")).toBe(true);
    expect("error" in mapAudioFormat("wav", "submit")).toBe(true);
  });

  it("OpenAI speed 0.25–4 线性映射到 [-50,100] 并截断", () => {
    expect(mapSpeedToSpeechRate(0.5)).toBe(-50);
    expect(mapSpeedToSpeechRate(1)).toBe(0);
    expect(mapSpeedToSpeechRate(2)).toBe(100);
    expect(mapSpeedToSpeechRate(0.25)).toBe(-50);
    expect(mapSpeedToSpeechRate(4)).toBe(100);
    expect(mapSpeedToSpeechRate(undefined)).toBe(0);
  });
});

describe("非法控制字符占比", () => {
  it("\\t \\n 不计入，超过 10% 才判非法", () => {
    expect(illegalControlRatio("正常文本\n换行\t制表")).toBe(0);
    expect(illegalControlRatio("abcd\u0001")).toBeCloseTo(1 / 5);
    expect(illegalControlRatio("ab\u0001\u0002cd")).toBeCloseTo(2 / 6);
  });
});

describe("validateReferences 三种形态", () => {
  it("未传 references 时用 voice 作为 speaker", () => {
    expect(validateReferences("zh_female_1", undefined)).toEqual({
      ok: true,
      references: [{ speaker: "zh_female_1" }],
    });
  });

  it("音频三条上限，speaker/audio_data/audio_url 互斥", () => {
    const ok = validateReferences(undefined, [
      { audio_url: "https://x/1.mp3" },
      { audio_data: "AAAA" },
      { speaker: "zh_male_1" },
    ]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.references).toHaveLength(3);

    const tooMany = validateReferences(undefined, [
      { audio_url: "a" },
      { audio_url: "b" },
      { audio_url: "c" },
      { audio_url: "d" },
    ]);
    expect(tooMany.ok).toBe(false);

    const conflict = validateReferences(undefined, [{ speaker: "s", audio_url: "u" }]);
    expect(conflict.ok).toBe(false);
  });

  it("图片最多 1 张且不能与音频混用", () => {
    const ok = validateReferences(undefined, [{ image_url: "https://x/1.png" }]);
    expect(ok.ok).toBe(true);

    const mixed = validateReferences(undefined, [{ image_url: "https://x/1.png" }, { speaker: "s" }]);
    expect(mixed.ok).toBe(false);
  });
});

describe("请求体构造", () => {
  it("create：model/text_prompt/references/audio_config/watermark", () => {
    const body = buildCreateBody(
      { mode: "create", modelName: "seed-audio-1.0" },
      { text: "你好", format: "mp3", speed: 1.5, references: [{ speaker: "spk" }] }
    );
    expect(body.model).toBe("seed-audio-1.0");
    expect(body.text_prompt).toBe("你好");
    expect(body.references).toEqual([{ speaker: "spk" }]);
    expect(body.watermark).toEqual({});
    expect((body.audio_config as Record<string, unknown>).speech_rate).toBe(50);
  });

  it("submit：user.uid + req_params.speaker/text/audio_params", () => {
    const body = buildSubmitBody({
      userId: 18,
      text: "长文本",
      voice: "spk",
      format: "mp3",
      speed: 1,
    });
    expect(body.user).toEqual({ uid: "18" });
    const rp = body.req_params as Record<string, unknown>;
    expect(rp.text).toBe("长文本");
    expect(rp.speaker).toBe("spk");
    expect((rp.audio_params as Record<string, unknown>).format).toBe("mp3");
  });
});

describe("错误码映射", () => {
  it("45000000 + concurrency → 429；其它 45xxxxx → 400；55xxxxx → 502", () => {
    expect(mapUpstreamError(200, 45000000, "quota exceeded for types: concurrency").status).toBe(429);
    expect(mapUpstreamError(200, 45001116, "invalid speaker").status).toBe(400);
    expect(mapUpstreamError(200, 55000000, "internal error").status).toBe(502);
    expect(mapUpstreamError(500, undefined, "boom").status).toBe(502);
    expect(mapUpstreamError(429, undefined, "too many").status).toBe(429);
  });
});

describe("响应解析", () => {
  it("create：读取 base64 + original_duration（计费依据）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            code: 0,
            audio: Buffer.from("RIFFxxxx").toString("base64"),
            duration: 10.1,
            original_duration: 10,
            url: "https://x/y.mp3",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    const r = await callBytedanceTtsCreate({ apiBase: "https://openspeech.bytedance.com", apiKey: "k", body: {} });
    expect(r.ok).toBe(true);
    expect(r.originalDurationSec).toBe(10);
    expect(Buffer.from(r.audioBase64!, "base64").toString()).toBe("RIFFxxxx");
  });

  it("create：HTTP 200 但 code 非 0 视为失败", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: 45001116, message: "bad speaker" }), { status: 200 }))
    );
    const r = await callBytedanceTtsCreate({ apiBase: "https://x", apiKey: "k", body: {} });
    expect(r.ok).toBe(false);
    expect(r.error?.status).toBe(400);
  });

  it("submit：必须 code=20000000 且带 task_id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: 20000000, message: "ok", data: { task_id: "t1", req_text_length: 1234 } }), { status: 200 }))
    );
    const r = await callBytedanceTtsSubmit({ apiBase: "https://x", apiKey: "k", resourceId: "seed-tts-2.0", body: {} });
    expect(r.ok).toBe(true);
    expect(r.taskId).toBe("t1");
    expect(r.reqTextLength).toBe(1234);
  });

  it("query 状态机：1 运行 / 2 成功拿 audio_url / 3 失败", async () => {
    process.env.BYTEDANCE_TTS_ASYNC_WAIT_MS = "2000";
    process.env.BYTEDANCE_TTS_POLL_MIN_MS = "1";
    process.env.BYTEDANCE_TTS_POLL_MAX_MS = "2";
    const seq = [
      { code: 20000000, data: { task_id: "t1", task_status: 1 } },
      { code: 20000000, data: { task_id: "t1", task_status: 2, audio_url: "https://x/a.mp3", req_text_length: 999 } },
    ];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(seq[Math.min(i++, seq.length - 1)]), { status: 200 }))
    );
    const r = await waitBytedanceTtsTask({
      apiBase: "https://x",
      apiKey: "k",
      resourceId: "seed-tts-2.0",
      taskId: "t1",
    });
    expect(r.ok).toBe(true);
    expect(r.audioUrl).toBe("https://x/a.mp3");
    expect(r.reqTextLength).toBe(999);
  });

  it("query 返回 task_status=3 时按失败收口", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: 20000000, data: { task_id: "t1", task_status: 3 } }), { status: 200 }))
    );
    const r = await waitBytedanceTtsTask({
      apiBase: "https://x",
      apiKey: "k",
      resourceId: "seed-tts-2.0",
      taskId: "t1",
    });
    expect(r.ok).toBe(false);
    expect(r.error?.status).toBe(502);
  });
});

describe("计费单位换算（成本 ×1.66 → 积分）", () => {
  const base = {
    currency: "CNY",
    fxRateE8: 100_000_000,
    multiplierBps: 16600,
  };

  it("create 按秒：预扣 120s 上限，成功后按实际秒数多退", () => {
    const p = {
      ...base,
      unit: "audio_second",
      meterBase: 1,
      inputPrice: 0.0166667, // 1 元/分钟 = 0.0166667 元/秒
      outputPrice: 0,
      memberInputPrice: null,
      memberOutputPrice: null,
    };
    // 0.0166667 元/秒 ×100 积分/元 ×1.66 = 2.7667 积分/秒
    // 120s 预扣
    const est = displayMemberCredits(p as never, 120, 0);
    expect(est).toBe(332);
    // 实际 83s
    const actual = displayMemberCredits(p as never, 83, 0);
    expect(actual).toBe(230);
    // 差额退回 102
    expect(est - actual).toBe(102);
  });

  it("submit 按千字符：meterBase=1000，measure 传字符数", () => {
    const p = {
      ...base,
      unit: "char",
      meterBase: 1000,
      inputPrice: 0.3, // 3 元/万字符 = 0.3 元/千字符
      outputPrice: 0,
      memberInputPrice: null,
      memberOutputPrice: null,
    };
    // 0.3 元/千字符 ×100 积分/元 ×1.66 = 49.8 积分/千字符
    expect(displayMemberCredits(p as never, 1000, 0)).toBe(50);
    expect(displayMemberCredits(p as never, 10000, 0)).toBe(498);
  });
});
