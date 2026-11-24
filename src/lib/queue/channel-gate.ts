// ─── P6 #22 进程内并发闸门（音频 / 文本）──
// 音频合成与文本对话都是「HTTP 请求内直接出结果」的形态，无法搬到独立进程里消费，
// 因此用进程内 FIFO 闸门限制同时在途数：超出上限的请求排队等待，等不到才 429。
// 并发上限来自后台设置（queue_config），5 秒缓存，保存后自动生效，无需重启。
// 说明：本闸门按进程生效；当前 web 以 pm2 fork 单实例运行，全站口径一致。

import { getQueueConfig, type QueueConfig } from "./queue-config";

export type GateChannel = "audio" | "text";

export interface GateHandle {
  ok: true;
  // 等了多少毫秒才拿到名额（0 = 无需排队）
  waitedMs: number;
  release: () => void;
}

export interface GateRejected {
  ok: false;
  waitedMs: number;
}

interface Waiter {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

const gates = new Map<GateChannel, { active: number; waiters: Waiter[] }>();

function stateOf(channel: GateChannel) {
  let s = gates.get(channel);
  if (!s) {
    s = { active: 0, waiters: [] };
    gates.set(channel, s);
  }
  return s;
}

// 配置缓存：避免每个请求都读库；5 秒后自动刷新，保存设置后无需重启
const CONFIG_TTL_MS = 5_000;
let cfgCache: { value: QueueConfig; ts: number } | null = null;

async function limitOf(channel: GateChannel): Promise<number> {
  const now = Date.now();
  if (!cfgCache || now - cfgCache.ts > CONFIG_TTL_MS) {
    cfgCache = { value: await getQueueConfig(), ts: now };
  }
  return cfgCache.value[channel];
}

function pump(channel: GateChannel, limit: number) {
  const s = stateOf(channel);
  while (s.active < limit && s.waiters.length > 0) {
    const w = s.waiters.shift()!;
    clearTimeout(w.timer);
    s.active++;
    w.resolve();
  }
}

function releaseOf(channel: GateChannel): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const s = stateOf(channel);
    s.active = Math.max(0, s.active - 1);
    // 优先用缓存上限立即放行；缓存缺失时异步补齐
    if (cfgCache) pump(channel, cfgCache.value[channel]);
    else void limitOf(channel).then((l) => pump(channel, l));
  };
}

// 等待上限：超过后放弃排队（调用方退款并返回 429），避免请求无限挂住
function waitTimeoutMs(): number {
  const n = Number(process.env.CHANNEL_WAIT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

export async function acquireChannel(
  channel: GateChannel,
  opts?: { timeoutMs?: number }
): Promise<GateHandle | GateRejected> {
  const limit = await limitOf(channel);
  const s = stateOf(channel);
  const started = Date.now();
  if (s.active < limit) {
    s.active++;
    return { ok: true, waitedMs: 0, release: releaseOf(channel) };
  }

  return new Promise<GateHandle | GateRejected>((resolve) => {
    let waiter!: Waiter;
    const timer = setTimeout(() => {
      const idx = s.waiters.indexOf(waiter);
      if (idx >= 0) s.waiters.splice(idx, 1);
      resolve({ ok: false, waitedMs: Date.now() - started });
    }, opts?.timeoutMs ?? waitTimeoutMs());
    waiter = {
      resolve: () => resolve({ ok: true, waitedMs: Date.now() - started, release: releaseOf(channel) }),
      timer,
    };
    s.waiters.push(waiter);
  });
}

// 运维页读取：当前在跑 / 排队数（web 进程内口径）
export function channelActive(channel: GateChannel): number {
  return stateOf(channel).active;
}

export function channelWaiting(channel: GateChannel): number {
  return stateOf(channel).waiters.length;
}

// 单测用：清空进程内状态与配置缓存（生产代码不调用）
export function __resetChannelGateForTests() {
  gates.clear();
  cfgCache = null;
}
