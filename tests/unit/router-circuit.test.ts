import { describe, it, expect, afterEach, vi } from "vitest";
import { recordKeyCancelled, recordKeyOutcome, keyIsAvailable, keyHealthSnapshot, resetKeyHealth, weightedOrder, tryAcquireKeyCall, releaseKeyProbe } from "@/lib/gateway/router";
import { isClientAbort } from "@/lib/gateway/adapters/openai";

// ─── P2 渠道健康单测：滑动窗口熔断 + 半开恢复 + 加权排序（纯内存态） ───

let seq = 0;
const kid = () => 900000 + ++seq; // 不与真实 vendor key id 冲突

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("熔断状态机", () => {
  it("正常 Key：可用", () => {
    const id = kid();
    expect(keyIsAvailable(id)).toBe(true);
    recordKeyOutcome(id, true, 200);
    expect(keyIsAvailable(id)).toBe(true);
    resetKeyHealth(id);
  });

  it("失败率 ≥50%（≥5 样本）→ open → 不可选", () => {
    const id = kid();
    // 5 成功 + 5 失败 = 50% → 触发
    for (let i = 0; i < 5; i++) recordKeyOutcome(id, true, 200);
    for (let i = 0; i < 5; i++) recordKeyOutcome(id, false, 500);
    // open 后不可选
    expect(keyIsAvailable(id)).toBe(false);
    resetKeyHealth(id);
  });

  it("样本不足（<5）不触发熔断", () => {
    const id = kid();
    for (let i = 0; i < 4; i++) recordKeyOutcome(id, false, 500);
    expect(keyIsAvailable(id)).toBe(true);
    resetKeyHealth(id);
  });

  it("上游 401/403 → 立即熔断（Key 失效不对同渠道重试）", () => {
    const id = kid();
    recordKeyOutcome(id, true, 200);
    recordKeyOutcome(id, false, 401);
    expect(keyIsAvailable(id)).toBe(false);
    resetKeyHealth(id);
  });

  it("冷却到期 → half-open 放行 1 个探测 → 成功恢复 closed", () => {
    vi.useFakeTimers();
    const id = kid();
    for (let i = 0; i < 5; i++) recordKeyOutcome(id, false, 500);
    expect(keyIsAvailable(id)).toBe(false);

    // 冷却 60s 到期
    vi.setSystemTime(Date.now() + 61_000);
    // 选路可读：冷却到即可参与
    expect(keyIsAvailable(id)).toBe(true);
    // 真正发起调用时占用 half-open 探测名额
    expect(tryAcquireKeyCall(id)).toBe(true);
    // 半开期第二个并发探测被拒
    expect(tryAcquireKeyCall(id)).toBe(false);
    // 探测成功 → closed → 恢复可用
    recordKeyOutcome(id, true, 200);
    expect(keyIsAvailable(id)).toBe(true);
    resetKeyHealth(id);
  });

  it("半开探测失败 → 重新 open", () => {
    vi.useFakeTimers();
    const id = kid();
    for (let i = 0; i < 5; i++) recordKeyOutcome(id, false, 502);
    vi.setSystemTime(Date.now() + 61_000);
    expect(tryAcquireKeyCall(id)).toBe(true); // half-open 探测
    recordKeyOutcome(id, false, 502);
    expect(keyIsAvailable(id)).toBe(false); // 重新 open
    resetKeyHealth(id);
  });

  it("resetKeyHealth 清除状态", () => {
    const id = kid();
    for (let i = 0; i < 5; i++) recordKeyOutcome(id, false, 500);
    expect(keyIsAvailable(id)).toBe(false);
    resetKeyHealth(id);
    expect(keyIsAvailable(id)).toBe(true);
  });
});

// ─── 客户端取消（关页面 / 点停止）不得污染熔断统计 ───

describe("客户端取消与熔断隔离", () => {
  it("连续取消不记录样本、不触发熔断", () => {
    const id = kid();
    for (let i = 0; i < 20; i++) recordKeyCancelled(id);
    expect(keyIsAvailable(id)).toBe(true);
    // 仍可正常记录：4 次真实失败不足以熔断（MIN_SAMPLES=5）
    for (let i = 0; i < 4; i++) recordKeyOutcome(id, false, 500);
    expect(keyIsAvailable(id)).toBe(true);
    resetKeyHealth(id);
  });

  it("取消既不计失败也不稀释失败率：真实失败凑满 5 样本仍熔断", () => {
    const id = kid();
    // 4 失败 + 大量取消：取消不占样本，故样本数仍为 4 → 不熔断
    for (let i = 0; i < 4; i++) recordKeyOutcome(id, false, 500);
    for (let i = 0; i < 10; i++) recordKeyCancelled(id);
    expect(keyIsAvailable(id)).toBe(true);
    // 第 5 次真实失败 → 样本 5、失败率 100% → 熔断
    recordKeyOutcome(id, false, 500);
    expect(keyIsAvailable(id)).toBe(false);
    resetKeyHealth(id);
  });

  it("half-open 期取消只归还探测名额，不改变状态、不误判成功", () => {
    vi.useFakeTimers();
    const id = kid();
    for (let i = 0; i < 5; i++) recordKeyOutcome(id, false, 502);
    vi.setSystemTime(Date.now() + 61_000);
    expect(tryAcquireKeyCall(id)).toBe(true); // 占用 half-open 探测名额
    expect(tryAcquireKeyCall(id)).toBe(false); // 名额用尽
    recordKeyCancelled(id); // 取消 → 归还名额
    expect(keyIsAvailable(id)).toBe(true); // 名额已归还，仍处于 half-open
    expect(tryAcquireKeyCall(id)).toBe(true);
    // 之后真实成功才真正恢复 closed
    recordKeyOutcome(id, true, 200);
    expect(keyIsAvailable(id)).toBe(true);
    resetKeyHealth(id);
  });
});

// ─── U1：客户端错误（4xx）不得计入 Key 健康分，Key 侧错误仍必须熔断 ───

describe("4xx 健康分口径（U1）", () => {
  it("连续 20 次 400/422 → 不占样本、不熔断（乱发坏请求打不穿 Key 池）", () => {
    const id = kid();
    for (let i = 0; i < 20; i++) recordKeyOutcome(id, false, i % 2 ? 400 : 422);
    expect(keyIsAvailable(id)).toBe(true);
    expect(keyHealthSnapshot(id).samples).toBe(0);
    resetKeyHealth(id);
  });

  it("404/413/415 等其余客户端 4xx 同样不计样本", () => {
    const id = kid();
    for (const status of [404, 413, 415, 405, 409]) {
      for (let i = 0; i < 5; i++) recordKeyOutcome(id, false, status);
    }
    expect(keyIsAvailable(id)).toBe(true);
    resetKeyHealth(id);
  });

  it("429 限流仍计入并熔断（Key 容量问题，不是客户端错误）", () => {
    const id = kid();
    for (let i = 0; i < 5; i++) recordKeyOutcome(id, false, 429);
    expect(keyIsAvailable(id)).toBe(false);
    resetKeyHealth(id);
  });

  it("403 仍立即熔断（Key 失效/无权限）", () => {
    const id = kid();
    recordKeyOutcome(id, true, 200);
    recordKeyOutcome(id, false, 403);
    expect(keyIsAvailable(id)).toBe(false);
    resetKeyHealth(id);
  });

  it("408 上游超时计入健康分", () => {
    const id = kid();
    for (let i = 0; i < 5; i++) recordKeyOutcome(id, false, 408);
    expect(keyIsAvailable(id)).toBe(false);
    resetKeyHealth(id);
  });

  it("网络异常（status=0）仍计入并熔断（真实故障能力未被削弱）", () => {
    const id = kid();
    for (let i = 0; i < 5; i++) recordKeyOutcome(id, false, 0);
    expect(keyIsAvailable(id)).toBe(false);
    resetKeyHealth(id);
  });

  it("真实失败中混入大量 400：样本只算真实失败，第 5 次真实失败才熔断", () => {
    const id = kid();
    for (let i = 0; i < 4; i++) recordKeyOutcome(id, false, 502);
    for (let i = 0; i < 20; i++) recordKeyOutcome(id, false, 400);
    expect(keyIsAvailable(id)).toBe(true); // 样本数仍为 4
    recordKeyOutcome(id, false, 502); // 第 5 个真实失败 → 100% → 熔断
    expect(keyIsAvailable(id)).toBe(false);
    resetKeyHealth(id);
  });

  it("half-open 期收到 400：归还探测名额，不误判成功也不卡死", () => {
    vi.useFakeTimers();
    const id = kid();
    for (let i = 0; i < 5; i++) recordKeyOutcome(id, false, 502);
    vi.setSystemTime(Date.now() + 61_000);
    expect(tryAcquireKeyCall(id)).toBe(true); // 占用 half-open 探测名额
    expect(tryAcquireKeyCall(id)).toBe(false);
    recordKeyOutcome(id, false, 400); // 客户端错误：中性，不关也不开
    expect(keyHealthSnapshot(id).state).toBe("half-open");
    expect(tryAcquireKeyCall(id)).toBe(true); // 名额已归还，可再次探测
    recordKeyOutcome(id, true, 200);
    expect(keyIsAvailable(id)).toBe(true);
    expect(keyHealthSnapshot(id).state).toBe("closed");
    resetKeyHealth(id);
  });
});

// ─── U2：半开探测名额只被「真正发起的调用」占用，选路只读 ───

describe("半开探测名额归属（U2）", () => {
  it("只选路不调用（resolveRoute / /v1/models 反复读）不消耗探测名额", () => {
    vi.useFakeTimers();
    const id = kid();
    for (let i = 0; i < 5; i++) recordKeyOutcome(id, false, 502);
    expect(keyIsAvailable(id)).toBe(false); // 冷却未到
    vi.setSystemTime(Date.now() + 61_000);
    // 模拟大量只读选路：不应把名额吃掉
    for (let i = 0; i < 50; i++) expect(keyIsAvailable(id)).toBe(true);
    // 真正调用仍能拿到探测名额
    expect(tryAcquireKeyCall(id)).toBe(true);
    expect(tryAcquireKeyCall(id)).toBe(false);
    recordKeyOutcome(id, true, 200);
    resetKeyHealth(id);
  });

  it("调用取消 / 抛异常（releaseKeyProbe）后名额归还，Key 不会永久退池", () => {
    vi.useFakeTimers();
    const id = kid();
    for (let i = 0; i < 5; i++) recordKeyOutcome(id, false, 500);
    vi.setSystemTime(Date.now() + 61_000);
    expect(tryAcquireKeyCall(id)).toBe(true);
    releaseKeyProbe(id); // 异常/取消兜底
    expect(keyIsAvailable(id)).toBe(true);
    expect(tryAcquireKeyCall(id)).toBe(true); // 可再次真实探测
    recordKeyOutcome(id, true, 200);
    resetKeyHealth(id);
  });

  it("冷却未到：选路与真实调用都不可用", () => {
    const id = kid();
    recordKeyOutcome(id, false, 401);
    expect(keyIsAvailable(id)).toBe(false);
    expect(tryAcquireKeyCall(id)).toBe(false);
    resetKeyHealth(id);
  });
});

// ─── 取消判定：AbortError + 调用方已 abort + 自身超时未触发 ───

describe("isClientAbort", () => {
  const abortErr = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

  it("三条件成立 → 判定为客户端取消", () => {
    const client = new AbortController();
    client.abort();
    const timeout = new AbortController().signal;
    expect(isClientAbort(abortErr(), client.signal, timeout)).toBe(true);
  });

  it("调用方 signal 未 abort（超时/网络错误导致）→ 不算取消", () => {
    const client = new AbortController();
    const timeout = new AbortController().signal;
    expect(isClientAbort(abortErr(), client.signal, timeout)).toBe(false);
  });

  it("自身超时同时触发 → 不算取消（超时是真实失败）", () => {
    const client = new AbortController();
    client.abort();
    expect(isClientAbort(abortErr(), client.signal, AbortSignal.abort())).toBe(false);
  });

  it("非 AbortError（TimeoutError / 网络错误 / 普通异常）→ 不算取消", () => {
    const client = new AbortController();
    client.abort();
    const timeout = new AbortController().signal;
    expect(isClientAbort(Object.assign(new Error("timeout"), { name: "TimeoutError" }), client.signal, timeout)).toBe(false);
    expect(isClientAbort(new TypeError("fetch failed"), client.signal, timeout)).toBe(false);
    expect(isClientAbort(null, client.signal, timeout)).toBe(false);
  });

  it("调用方无 signal（未传）→ 不算取消，并打 warn 指出调用路径", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const timeout = new AbortController().signal;
    expect(isClientAbort(abortErr(), undefined, timeout, "adapters/gemini.callGeminiChat")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("[isClientAbort][missing-signal]");
    expect(line).toContain("adapters/gemini.callGeminiChat");
  });

  it("调用方传了不可用的 signal（非 AbortSignal）→ 不算取消，同样告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const timeout = new AbortController().signal;
    const bogus = {} as unknown as AbortSignal;
    expect(isClientAbort(abortErr(), bogus, timeout)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("path=unknown");
  });

  it("正常传 signal 时不产生 missing-signal 告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new AbortController();
    client.abort();
    expect(isClientAbort(abortErr(), client.signal, new AbortController().signal)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("加权随机排序", () => {
  it("不丢候选：排序前后集合一致", () => {
    const items = [
      { id: 1, weight: 5 },
      { id: 2, weight: 1 },
      { id: 3, weight: 0 }, // weight 0 视为 1
    ];
    const ordered = weightedOrder(items);
    expect(ordered.map((x) => x.id).sort()).toEqual([1, 2, 3]);
  });

  it("高权重项大概率排前（100 次抽样中 w=9 的项首位次数远多于 w=1）", () => {
    const a = { id: "a", weight: 9 };
    const b = { id: "b", weight: 1 };
    let aFirst = 0;
    for (let i = 0; i < 100; i++) {
      if (weightedOrder([a, b])[0].id === "a") aFirst++;
    }
    // 权重 9:1 → a 排首位概率 0.9；宽松断言 > 0.7 防随机抖动
    expect(aFirst).toBeGreaterThan(70);
  });
});
