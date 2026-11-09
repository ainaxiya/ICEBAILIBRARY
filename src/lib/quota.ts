import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";

// ─── P2 会员层配额（复用 rate-limit 滑动窗口机制） ───
// 三项限额：文本调用日次数 / RPM / 并发数。
// 参数存 SiteSetting key="quota"（JSON，缺省用默认值；后台暂无 UI）。

export interface QuotaConfig {
  // 每会员每日文本调用次数
  dailyCalls: number;
  // 每会员每分钟调用次数
  rpm: number;
  // 每会员同时在途请求数
  concurrency: number;
}

export const DEFAULT_QUOTA: QuotaConfig = { dailyCalls: 2000, rpm: 60, concurrency: 4 };

let cache: { data: QuotaConfig; ts: number } | null = null;
const TTL = 30_000;

export async function getQuotaConfig(): Promise<QuotaConfig> {
  if (cache && Date.now() - cache.ts < TTL) return cache.data;
  let data = { ...DEFAULT_QUOTA };
  try {
    const row = await db.siteSetting.findUnique({ where: { key: "quota" } });
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<QuotaConfig>;
      data = {
        dailyCalls: Number(parsed.dailyCalls) > 0 ? Number(parsed.dailyCalls) : DEFAULT_QUOTA.dailyCalls,
        rpm: Number(parsed.rpm) > 0 ? Number(parsed.rpm) : DEFAULT_QUOTA.rpm,
        concurrency: Number(parsed.concurrency) > 0 ? Number(parsed.concurrency) : DEFAULT_QUOTA.concurrency,
      };
    }
  } catch {}
  cache = { data, ts: Date.now() };
  return data;
}

// 日次数 + RPM 滑动窗口检查（超限 false）
export async function checkQuota(userId: number): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getQuotaConfig();
  if (!rateLimit(`quota:daily:${userId}`, cfg.dailyCalls, 86_400_000)) {
    return { ok: false, error: "Daily call limit reached. Please try again tomorrow" };
  }
  if (!rateLimit(`quota:rpm:${userId}`, cfg.rpm, 60_000)) {
    return { ok: false, error: "Rate limit exceeded (per-minute). Please slow down and retry later" };
  }
  return { ok: true };
}

// ─── P5 站外 Key 层配额（从简：只做每 Key RPM） ───
const KEY_RPM = 60;

export function checkKeyRpm(keyId: number): { ok: boolean; error?: string } {
  if (!rateLimit(`apikey:rpm:${keyId}`, KEY_RPM, 60_000)) {
    return { ok: false, error: "This API key is being used too frequently (per-minute limit). Please slow down" };
  }
  return { ok: true };
}

// ─── 并发槽（内存计数，release 幂等，须在每个出口调用） ───
const inflight = new Map<number, number>();

export function acquireSlot(userId: number, limit: number): { ok: boolean; release: () => void } {
  const cur = inflight.get(userId) || 0;
  const noop = () => {};
  if (cur >= limit) return { ok: false, release: noop };
  inflight.set(userId, cur + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      const n = (inflight.get(userId) || 1) - 1;
      if (n <= 0) inflight.delete(userId);
      else inflight.set(userId, n);
    },
  };
}
