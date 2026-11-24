import { describe, it, expect } from "vitest";
import { rateLimitAsync } from "@/lib/rate-limit";
import { acquireSlot } from "@/lib/quota";
import { redisEnabled, getSharedRedis } from "@/lib/redis";

// ─── g15 / o13：共享状态层（无 REDIS_URL 时必须完全回退进程内） ───
// 测试环境不配置 REDIS_URL，验证降级路径与异步签名契约不被破坏。

describe("共享状态降级", () => {
  it("未配置 REDIS_URL：不创建客户端，redisEnabled=false", () => {
    expect(redisEnabled()).toBe(false);
    expect(getSharedRedis()).toBeNull();
  });

  it("rateLimitAsync：无 Redis 时按进程内滑动窗口计数", async () => {
    const key = `test:rl:${Date.now()}`;
    expect(await rateLimitAsync(key, 2, 60_000)).toBe(true);
    expect(await rateLimitAsync(key, 2, 60_000)).toBe(true);
    expect(await rateLimitAsync(key, 2, 60_000)).toBe(false);
  });

  it("acquireSlot：并发槽上限与幂等 release", async () => {
    const uid = Math.floor(Math.random() * 1_000_000);
    const s1 = await acquireSlot(uid, 2);
    const s2 = await acquireSlot(uid, 2);
    const s3 = await acquireSlot(uid, 2);
    expect(s1.ok).toBe(true);
    expect(s2.ok).toBe(true);
    expect(s3.ok).toBe(false);
    s1.release();
    s1.release(); // 幂等：重复归还不多减
    const s4 = await acquireSlot(uid, 2);
    expect(s4.ok).toBe(true);
    s2.release();
    s4.release();
  });
});
