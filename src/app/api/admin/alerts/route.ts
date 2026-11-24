import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { checkOperationalAlerts, getAlertsConfig, saveAlertsConfig } from "@/lib/alerts";
import {
  normalizeAdminEmail,
  parseAlertSubscriptions,
  serializeAlertSubscriptions,
} from "@/lib/admin/alert-subscription";

export const dynamic = "force-dynamic";

// ─── P6 运营告警 API ───
// GET  /api/admin/alerts              告警列表 + 未确认数 + 阈值配置
// POST /api/admin/alerts              action: "check" 手动巡检 / "saveConfig" 保存阈值 / "saveSubscription" 保存我的告警订阅

// GET /api/admin/alerts?page=&ack=unacked|all
export async function GET(req: NextRequest) {
  const { user: admin, ok } = await requirePerm(PERMISSIONS.REPORT_READ);
  if (!admin || !ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") || "1") || 1);
  const pageSize = 20;
  const ackFilter = sp.get("ack") === "unacked" ? { ackAt: null } : {};

  const [total, unackCount, items, config, me] = await Promise.all([
    db.operationalAlert.count({ where: ackFilter }),
    db.operationalAlert.count({ where: { ackAt: null } }),
    db.operationalAlert.findMany({
      where: ackFilter,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    getAlertsConfig(),
    // b16：当前管理员的订阅设置（自己看自己，不暴露其他管理员邮箱）
    db.adminAccount.findUnique({
      where: { id: admin.id },
      select: { email: true, alertSubscriptions: true },
    }),
  ]);

  // 历史告警 payload 只有 userId / requestId，这里补一次关联查询，
  // 让运营在列表上直接看到账号名、模型与功能，不用再去别的页面拼。
  const parsedPayloads = items.map((a) => {
    try {
      return JSON.parse(a.payload || "{}") as { userId?: number; requestId?: string };
    } catch {
      return {} as { userId?: number; requestId?: string };
    }
  });
  const userIds = [...new Set(parsedPayloads.map((p) => p.userId).filter((n): n is number => typeof n === "number"))];
  const requestIds = [
    ...new Set(parsedPayloads.map((p) => p.requestId).filter((s): s is string => typeof s === "string" && s.length > 0)),
  ];
  const [members, usages] = await Promise.all([
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, nickname: true } }),
    db.usageRecord.findMany({
      where: { requestId: { in: requestIds } },
      select: { requestId: true, modelSnapshot: true, endpointType: true, status: true, paidCredits: true, createdAt: true },
    }),
  ]);
  const memberMap = new Map(members.map((m) => [m.id, m]));
  const usageMap = new Map(usages.map((u) => [u.requestId, u]));

  return NextResponse.json({
    page,
    pageSize,
    total,
    unackCount,
    config,
    mySubscription: {
      email: me?.email ?? "",
      types: parseAlertSubscriptions(me?.alertSubscriptions),
    },
    items: items.map((a, i) => {
      const p = parsedPayloads[i];
      const member = p.userId ? memberMap.get(p.userId) ?? null : null;
      const usage = p.requestId ? usageMap.get(p.requestId) ?? null : null;
      return {
        id: a.id,
        alertType: a.alertType,
        level: a.level,
        message: a.message,
        payload: a.payload,
        ackAt: a.ackAt,
        createdAt: a.createdAt,
        // 服务端关联出的可读信息（不改表结构）
        member,
        usage: usage ? { ...usage, paidCredits: usage.paidCredits.toString() } : null,
      };
    }),
  });
}

const configSchema = z.object({
  enabled: z.boolean().optional(),
  // 所有数值阈值统一口径：0 = 不限 / 不启用
  creditPoolThreshold: z.coerce.number().min(0).max(1e12),
  marginRateThreshold: z.coerce.number().min(0).max(1),
  payFail24hCount: z.coerce.number().min(0).max(1e9),
  registerBurstPerIp: z.coerce.number().min(0).max(1e6),
});

// POST /api/admin/alerts
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const action = typeof body?.action === "string" ? body.action : "";
  const ip = await getClientIp();

  // ── b16：保存「我的告警订阅」（每个管理员只能改自己的邮箱与订阅类型） ──
  if (action === "saveSubscription") {
    const { user: admin, ok } = await requirePerm(PERMISSIONS.REPORT_READ);
    if (!admin || !ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const rawEmail = typeof body?.email === "string" ? body.email.trim() : "";
    const email = normalizeAdminEmail(rawEmail);
    if (rawEmail && !email) return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });

    const alertSubscriptions = serializeAlertSubscriptions(body?.alertTypes);
    const updated = await db.adminAccount.update({
      where: { id: admin.id },
      data: { email, alertSubscriptions },
      select: { email: true, alertSubscriptions: true },
    });
    await logAdminAction({
      adminId: admin.id,
      action: "update",
      targetType: "admin",
      targetId: admin.id,
      detail: JSON.stringify({
        section: "alert_subscription",
        email: updated.email,
        types: parseAlertSubscriptions(updated.alertSubscriptions),
      }),
      ip,
    });
    return NextResponse.json({
      ok: true,
      mySubscription: {
        email: updated.email ?? "",
        types: parseAlertSubscriptions(updated.alertSubscriptions),
      },
    });
  }

  // ── 手动巡检（本地开发无 cron，后台「运营告警」页按钮触发） ──
  if (action === "check") {
    const { user: admin, ok } = await requirePerm(PERMISSIONS.REPORT_READ);
    if (!admin || !ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    // 手动巡检不受自动巡检总开关限制（开关只管自动路径）
    const result = await checkOperationalAlerts({ manual: true });
    await logAdminAction({
      adminId: admin.id,
      action: "create",
      targetType: "operational_alert",
      detail: JSON.stringify({ section: "alerts_check", created: result.created.length }),
      ip,
    });
    return NextResponse.json({ ok: true, ...result });
  }

  // ── 保存告警阈值配置（SiteSetting key="alerts_config"） ──
  if (action === "saveConfig") {
    const { user: admin, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
    if (!admin || !ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const parsed = configSchema.safeParse(body?.config ?? null);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
    }
    const config = await saveAlertsConfig(parsed.data);
    await logAdminAction({
      adminId: admin.id,
      action: "update",
      targetType: "setting",
      detail: JSON.stringify({ section: "alerts_config", config }),
      ip,
    });
    return NextResponse.json({ ok: true, config });
  }

  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}
