import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { recordKeyOutcome, resetKeyHealth } from "@/lib/gateway/router";
import { applyTagOp, normalizeTags, planKeyRepairs, isProbeSuccess } from "@/lib/admin/key-batch";

export const dynamic = "force-dynamic";

// ─── 渠道批量运营 ───
// POST /api/admin/models/keys/batch
// { action: "test"|"enable"|"disable"|"tag"|"delete-disabled"|"repair",
//   ids?: number[], vendorId?: number, tagOp?: "add"|"remove"|"replace", tags?: string[]|string }
// 单条失败不影响整体，返回逐条结果。

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_CONCURRENCY = 3;

const schema = z.object({
  action: z.enum(["test", "enable", "disable", "tag", "delete-disabled", "repair"]),
  ids: z.array(z.number().int().positive()).max(200).optional(),
  vendorId: z.number().int().positive().optional(),
  tagOp: z.enum(["add", "remove", "replace"]).optional(),
  tags: z.union([z.array(z.string()), z.string()]).optional(),
});

// 上游模型清单地址：base 不带 /v1 时两种挂法都试（与 fetch-models 同口径）
function modelsUrls(apiBase: string): string[] {
  const b = apiBase.replace(/\/+$/, "");
  return b.endsWith("/v1") ? [`${b}/models`] : [`${b}/models`, `${b}/v1/models`];
}

type ProbeResult = {
  id: number;
  name: string;
  vendorName: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  error: string | null;
};

// 单 Key 测活：GET {apiBase}/models，2xx/3xx 视为可用；结果写入健康状态机
async function probeKey(key: {
  id: number;
  name: string;
  keyCipher: string;
  vendor: { name: string; apiBase: string };
}): Promise<ProbeResult> {
  const started = Date.now();
  const base = {
    id: key.id,
    name: key.name,
    vendorName: key.vendor.name,
    latencyMs: 0,
  };
  let apiKey: string;
  try {
    apiKey = decryptSecret(key.keyCipher);
  } catch {
    return { ...base, ok: false, status: 0, latencyMs: Date.now() - started, error: "Key 解密失败" };
  }

  const urls = modelsUrls(key.vendor.apiBase);
  for (let i = 0; i < urls.length; i += 1) {
    try {
      const res = await fetch(urls[i], {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      // 第一个地址 404 且还有候选地址 → 换下一个（不算失败）
      if (res.status === 404 && i < urls.length - 1) continue;
      const ok = isProbeSuccess(res.status);
      recordKeyOutcome(key.id, ok, res.status);
      return {
        ...base,
        ok,
        status: res.status,
        latencyMs: Date.now() - started,
        error: ok ? null : `HTTP ${res.status}`,
      };
    } catch (e) {
      const latencyMs = Date.now() - started;
      // 网络层失败（超时 / DNS / 连接拒绝）同样计入渠道健康
      recordKeyOutcome(key.id, false, 0);
      return { ...base, ok: false, status: 0, latencyMs, error: (e as Error).message || "请求失败" };
    }
  }
  return { ...base, ok: false, status: 404, latencyMs: Date.now() - started, error: "HTTP 404" };
}

// 小批并发（固定分片，最多 3 条并行），不重试、不轮询
async function probeMany(
  keys: {
    id: number;
    name: string;
    keyCipher: string;
    vendor: { name: string; apiBase: string };
  }[]
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (let i = 0; i < keys.length; i += PROBE_CONCURRENCY) {
    const chunk = keys.slice(i, i + PROBE_CONCURRENCY);
    results.push(...(await Promise.all(chunk.map(probeKey))));
  }
  return results;
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { action, ids = [], vendorId, tagOp, tags } = parsed.data;

  const needIds = action === "test" || action === "enable" || action === "disable" || action === "tag";
  if (needIds && ids.length === 0) {
    return NextResponse.json({ error: "请选择要操作的 Key" }, { status: 400 });
  }
  if (action === "tag" && (!tagOp || tags === undefined)) {
    return NextResponse.json({ error: "打标需要 tagOp 与 tags" }, { status: 400 });
  }

  let result: Record<string, unknown>;

  if (action === "test") {
    const keys = await db.vendorApiKey.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        keyCipher: true,
        vendor: { select: { name: true, apiBase: true } },
      },
    });
    const items = await probeMany(keys);
    result = {
      ok: true,
      total: items.length,
      passed: items.filter((r) => r.ok).length,
      failed: items.filter((r) => !r.ok).length,
      items,
    };
  } else if (action === "enable" || action === "disable") {
    const affected = (
      await db.vendorApiKey.updateMany({
        where: { id: { in: ids } },
        data: { status: action === "enable" ? "active" : "disabled" },
      })
    ).count;
    if (action === "enable") {
      for (const id of ids) resetKeyHealth(id);
    }
    result = { ok: true, affected };
  } else if (action === "tag") {
    const op = tagOp as "add" | "remove" | "replace";
    const incoming = normalizeTags(tags);
    const rows = await db.vendorApiKey.findMany({
      where: { id: { in: ids } },
      select: { id: true, tags: true },
    });
    let affected = 0;
    for (let i = 0; i < rows.length; i += 20) {
      const chunk = rows.slice(i, i + 20);
      const counts = await Promise.all(
        chunk.map((row) =>
          db.vendorApiKey
            .update({ where: { id: row.id }, data: { tags: applyTagOp(row.tags, op, incoming) } })
            .then(() => 1)
            .catch(() => 0)
        )
      );
      affected += counts.reduce((a: number, b: number) => a + b, 0);
    }
    result = { ok: true, affected, tags: incoming };
  } else if (action === "delete-disabled") {
    const where = { status: "disabled", ...(vendorId ? { vendorId } : {}) };
    const rows = await db.vendorApiKey.findMany({
      where,
      select: { id: true, name: true, keyPrefix: true },
    });
    const deleted = rows.length
      ? (await db.vendorApiKey.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } })).count
      : 0;
    for (const row of rows) resetKeyHealth(row.id);
    result = { ok: true, deleted, items: rows };
  } else {
    // repair：状态 / 权重 / 过期维护窗口
    const keys = await db.vendorApiKey.findMany({
      where: vendorId ? { vendorId } : {},
      select: { id: true, status: true, weight: true, maintainUntil: true },
    });
    const fixes = planKeyRepairs(keys);
    const byId = new Map<number, { status?: string; weight?: number; maintainUntil?: Date | null }>();
    for (const fix of fixes) {
      const cur = byId.get(fix.id) ?? {};
      if (fix.field === "status") cur.status = String(fix.to);
      else if (fix.field === "weight") cur.weight = Number(fix.to);
      else cur.maintainUntil = null;
      byId.set(fix.id, cur);
    }
    let changed = 0;
    for (const [id, data] of byId) {
      await db.vendorApiKey.update({ where: { id }, data });
      if (data.status !== undefined) resetKeyHealth(id);
      changed += 1;
    }
    const counts = {
      status: fixes.filter((f) => f.field === "status").length,
      weight: fixes.filter((f) => f.field === "weight").length,
      maintainUntil: fixes.filter((f) => f.field === "maintainUntil").length,
    };
    result = { ok: true, changed, counts, fixes };
  }

  await logAdminAction({
    adminId: admin.id,
    action: action === "delete-disabled" ? "delete" : "update",
    targetType: "vendor_api_key",
    detail: JSON.stringify({
      batch: true,
      op: action,
      ids: action === "delete-disabled" || action === "repair" ? undefined : ids,
      vendorId,
      tagOp,
      ...result,
    }),
    ip: await getClientIp(),
  });

  return NextResponse.json(result);
}
