import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { getPayChannels, savePayChannels, type ChannelConfig, type PayChannelsConfig } from "@/lib/payments/config";

export const dynamic = "force-dynamic";

// ─── 支付渠道配置（SiteSetting key="pay_channels"） ───
// GET：敏感字段一律脱敏（"••••" + has 标记），绝不回显明文；
// PUT：合并语义——敏感字段传空/缺省 = 保持原值不变（取旧值解密后合并再加密落库）。

// 每个通道的字段清单（plain 可回显；sensitive 绝不回显、空值保持原样）
const CHANNEL_META: { key: "wechat" | "alipay" | "custom" | "stripe" | "crypto"; plain: string[]; sensitive: string[] }[] = [
  { key: "wechat", plain: ["appId", "mchId"], sensitive: ["apiKey"] },
  { key: "alipay", plain: ["appId", "publicKey"], sensitive: ["privateKey"] },
  { key: "custom", plain: ["gatewayUrl", "appId"], sensitive: ["key"] },
  { key: "stripe", plain: [], sensitive: ["secretKey", "webhookSecret"] },
  { key: "crypto", plain: ["gatewayUrl", "address"], sensitive: ["apiKey"] },
];

// 敏感字段占位掩码（GET 返回值 / PUT 传回该值视为「保持原值」）
const MASK = "••••";

const f = () => z.string().max(500).optional();

const schema = z.object({
  wechat: z.object({ enabled: z.boolean(), appId: f(), mchId: f(), apiKey: f() }),
  alipay: z.object({ enabled: z.boolean(), appId: f(), privateKey: f(), publicKey: f() }),
  custom: z.object({ enabled: z.boolean(), gatewayUrl: f(), appId: f(), key: f() }),
  stripe: z.object({ enabled: z.boolean(), secretKey: f(), webhookSecret: f() }),
  crypto: z.object({ enabled: z.boolean(), gatewayUrl: f(), address: f(), apiKey: f() }),
});

// 通道配置 → 接口出参（敏感字段脱敏 + has 已配置标记）
function maskChannels(cfg: PayChannelsConfig): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const meta of CHANNEL_META) {
    const c: ChannelConfig = cfg[meta.key] || { enabled: false };
    const dto: Record<string, unknown> = { enabled: Boolean(c.enabled) };
    for (const k of meta.plain) dto[k] = typeof c[k] === "string" ? c[k] : "";
    const has: Record<string, boolean> = {};
    for (const k of meta.sensitive) {
      const set = typeof c[k] === "string" && c[k] !== "";
      has[k] = set;
      dto[k] = set ? MASK : "";
    }
    dto.has = has;
    out[meta.key] = dto;
  }
  return out;
}

// GET /api/admin/settings/pay-channels
export async function GET() {
  const { ok } = await requirePerm(PERMISSIONS.SETTING_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const cfg = await getPayChannels();
  return NextResponse.json({ channels: maskChannels(cfg) });
}

// PUT /api/admin/settings/pay-channels —— 合并保存
export async function PUT(req: NextRequest) {
  const { user: admin, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!admin || !ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }

  // 旧配置（敏感字段已解密），用于合并
  const old = await getPayChannels();
  const merged: PayChannelsConfig = {};
  const changedSensitive: string[] = [];
  for (const meta of CHANNEL_META) {
    const body = parsed.data[meta.key] as Record<string, unknown>;
    const oldCfg: ChannelConfig = old[meta.key] || { enabled: false };
    const next: ChannelConfig = { enabled: Boolean(body.enabled) };
    // 非敏感字段：以提交值为准，缺省回退旧值
    for (const k of meta.plain) {
      const v = body[k];
      next[k] = typeof v === "string" ? v : typeof oldCfg[k] === "string" ? oldCfg[k] : "";
    }
    // 敏感字段：空 / 缺省 / 掩码 = 保持原值不变
    for (const k of meta.sensitive) {
      const v = body[k];
      const keepOld = typeof v !== "string" || v === "" || v === MASK;
      if (keepOld) {
        next[k] = typeof oldCfg[k] === "string" ? oldCfg[k] : "";
      } else {
        next[k] = v;
        changedSensitive.push(`${meta.key}.${k}`); // 只记字段名，绝不记录明文
      }
    }
    merged[meta.key] = next;
  }

  await savePayChannels(merged);

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "setting",
    detail: JSON.stringify({
      section: "pay_channels",
      enabled: Object.fromEntries(CHANNEL_META.map((m) => [m.key, merged[m.key]?.enabled ?? false])),
      changedSensitive,
    }),
    ip: await getClientIp(),
  });

  // 返回脱敏后的最新配置
  return NextResponse.json({ ok: true, channels: maskChannels(merged) });
}
