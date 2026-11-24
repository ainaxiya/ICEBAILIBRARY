import { describe, it, expect } from "vitest";

// ─── 视频队列 Redis 不可用：必须秒级失败，让路由回退 inline，不能挂住请求 ───
// 超时阈值在模块加载时读取，先设环境变量再动态导入。
process.env.VIDEO_QUEUE_CONNECT_TIMEOUT_MS = "600";
process.env.VIDEO_QUEUE_TIMEOUT_MS = "600";

const { enqueueVideoTask } = await import("@/lib/queue/video-queue");
const { normalizeQueueConfig, DEFAULT_QUEUE_CONFIG, QUEUE_LIMIT_MIN, QUEUE_LIMIT_MAX } = await import(
  "@/lib/queue/queue-config"
);

const JOB = {
  taskId: "vt-unit-queue-1",
  // 队列载荷只传 Key id，不传明文 apiKey
  vendorKeyIds: [1],
  body: { model: "vid", prompt: "a cat" },
  baseUsage: {
    requestId: "req-unit-queue-1",
    userId: 1,
    channel: "onsite" as const,
    apiKeyId: null,
    modelId: 1,
    endpointType: "video" as const,
    modelSnapshot: "vid",
    promptTokens: 0,
    outputTokens: 0,
  },
  pricing: {},
  durationSec: 5,
  started: Date.now(),
};

describe("enqueueVideoTask 超时回退", () => {
  it("Redis 端口不可达 → 快速返回 ok:false（调用方据此回退 inline）", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6390";
    const started = Date.now();

    const r = await enqueueVideoTask(JOB as never);

    const cost = Date.now() - started;
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    // 连接超时 600ms + 命令超时 600ms 两道上限，必须远小于请求级超时
    expect(cost).toBeLessThan(6_000);
  }, 20_000);
});

describe("队列载荷安全护栏（不把上游明文密钥写进 Redis）", () => {
  it("载荷含 apiKey 字段 → 拒绝入队，不落 Redis", async () => {
    const bad = {
      ...JOB,
      candidates: [{ vendorKeyId: 1, apiKey: "sk-unit-test", apiBase: "https://example.test" }],
    };
    const r = await enqueueVideoTask(bad as never);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("敏感字段");
  });

  it("只传 vendorKeyIds 的载荷 → 通过护栏（走到真实连接，端口不可达返回 ok:false）", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6390";
    const r = await enqueueVideoTask(JOB as never);
    expect(r.error ?? "").not.toContain("敏感字段");
  }, 20_000);
});

describe("并发配置来源改为后台设置（queue_config）", () => {
  it("缺省 → 使用默认基数 1/4/8/30/2", () => {
    expect(normalizeQueueConfig(null)).toEqual(DEFAULT_QUEUE_CONFIG);
  });
  it("正常值按原样保留", () => {
    expect(normalizeQueueConfig({ video: 4, audio: 20, image: 50, text: 100, download: 3 })).toEqual({
      video: 4,
      audio: 20,
      image: 50,
      text: 100,
      download: 3,
    });
  });
  it("越界值夹到 1–200，非法值回退默认", () => {
    const c = normalizeQueueConfig({ video: 0, audio: -5, image: 9999, text: "abc", download: 1.9 });
    expect(c.video).toBe(QUEUE_LIMIT_MIN);
    expect(c.audio).toBe(QUEUE_LIMIT_MIN);
    expect(c.image).toBe(QUEUE_LIMIT_MAX);
    expect(c.text).toBe(DEFAULT_QUEUE_CONFIG.text);
    expect(c.download).toBe(1);
  });
});
