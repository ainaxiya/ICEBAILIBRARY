import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// ─── P4 后台：消息·工单（工单队列 / 回复 / 关闭 / 群发 / 单发通知） ───

function msgJson(m: {
  id: bigint;
  userId: number;
  direction: string;
  msgType: string;
  subject: string | null;
  body: string;
  ticketStatus: string | null;
  batchId: string | null;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: String(m.id),
    userId: m.userId,
    direction: m.direction,
    msgType: m.msgType,
    subject: m.subject,
    body: m.body,
    ticketStatus: m.ticketStatus,
    batchId: m.batchId,
    readAt: m.readAt,
    createdAt: m.createdAt,
  };
}

const PAGE_SIZE = 20;

function parseId(v: unknown): bigint | null {
  try {
    const n = BigInt(String(v ?? ""));
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

// GET /api/admin/messages —— 工单队列（?status=open|replied|closed|all&page=）
// GET /api/admin/messages?threadId=xx —— 会话完整对话
export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = req.nextUrl.searchParams;

  const threadIdRaw = sp.get("threadId");
  if (threadIdRaw) {
    const rootId = parseId(threadIdRaw);
    if (!rootId) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    const root = await db.userMessage.findFirst({
      where: { id: rootId, msgType: "ticket", replyToId: null },
      include: { user: { select: { id: true, username: true, nickname: true } } },
    });
    if (!root) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    const messages = await db.userMessage.findMany({
      where: { OR: [{ id: rootId }, { replyToId: rootId }] },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({
      thread: { ...msgJson(root), user: root.user },
      messages: messages.map(msgJson),
    });
  }

  const status = sp.get("status") || "open";
  const page = Math.max(1, parseInt(sp.get("page") || "1") || 1);
  const where = {
    direction: "user_to_admin",
    msgType: "ticket",
    replyToId: null,
    ...(status !== "all" ? { ticketStatus: status } : {}),
  };

  const [total, roots] = await Promise.all([
    db.userMessage.count({ where }),
    db.userMessage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        user: { select: { id: true, username: true, nickname: true } },
        replies: {
          orderBy: { createdAt: "asc" },
          select: { body: true, direction: true, createdAt: true },
        },
      },
    }),
  ]);

  return NextResponse.json({
    page,
    pageSize: PAGE_SIZE,
    total,
    tickets: roots.map((r) => {
      const last = r.replies[r.replies.length - 1];
      return {
        ...msgJson(r),
        user: r.user,
        replyCount: r.replies.length,
        lastBody: last?.body ?? r.body,
        lastAt: last?.createdAt ?? r.createdAt,
      };
    }),
  });
}

// POST /api/admin/messages —— 动作分发：
// { action: "reply",   threadId, body }                       回复工单（admin_to_user）
// { action: "close",   threadId }                             关闭工单
// { action: "broadcast", subject, body, target, userIds[] }   群发通知（batchId 批次）
// { action: "notice",  userId, subject, body }                单发通知
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const action = typeof body?.action === "string" ? body.action : "";
  const ip = await getClientIp();

  // ── 回复工单 ──
  if (action === "reply") {
    const threadId = parseId(body?.threadId);
    if (!threadId) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    const content = typeof body?.body === "string" ? body.body.trim() : "";
    if (!content) return NextResponse.json({ error: "回复内容不能为空" }, { status: 400 });
    if (content.length > 5000) return NextResponse.json({ error: "内容过长（最多 5000 字符）" }, { status: 400 });

    const root = await db.userMessage.findFirst({
      where: { id: threadId, msgType: "ticket", replyToId: null },
    });
    if (!root) return NextResponse.json({ error: "工单不存在" }, { status: 404 });

    const [created] = await db.$transaction([
      db.userMessage.create({
        data: {
          userId: root.userId,
          direction: "admin_to_user",
          msgType: "ticket",
          subject: root.subject,
          body: content,
          replyToId: root.id,
        },
      }),
      db.userMessage.update({
        where: { id: root.id },
        data: { ticketStatus: "replied" },
      }),
    ]);

    await logAdminAction({
      adminId: admin.id,
      action: "update",
      targetType: "message",
      targetId: Number(root.id),
      detail: JSON.stringify({ section: "ticket_reply", threadId: String(root.id), userId: root.userId }),
      ip,
    });
    return NextResponse.json({ ok: true, message: msgJson(created) });
  }

  // ── 关闭工单 ──
  if (action === "close") {
    const threadId = parseId(body?.threadId);
    if (!threadId) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    const root = await db.userMessage.findFirst({
      where: { id: threadId, msgType: "ticket", replyToId: null },
    });
    if (!root) return NextResponse.json({ error: "工单不存在" }, { status: 404 });
    await db.userMessage.update({
      where: { id: root.id },
      data: { ticketStatus: "closed" },
    });
    await logAdminAction({
      adminId: admin.id,
      action: "update",
      targetType: "message",
      targetId: Number(root.id),
      detail: JSON.stringify({ section: "ticket_close", threadId: String(root.id), userId: root.userId }),
      ip,
    });
    return NextResponse.json({ ok: true });
  }

  // ── 群发通知（msgType=notice，batchId 批次，逐用户投递一条） ──
  // P6 人群筛选：all=全部 / users=指定 ID / registered=按注册时间 / balance=按余额区间（有 CreditGrant 的用户）
  if (action === "broadcast") {
    const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
    const content = typeof body?.body === "string" ? body.body.trim() : "";
    const target = ["users", "registered", "balance"].includes(body?.target) ? body.target : "all";
    const userIds: number[] = Array.isArray(body?.userIds)
      ? body.userIds.map((n: unknown) => parseInt(String(n))).filter((n: number) => Number.isInteger(n) && n > 0)
      : [];
    // 按注册时间（YYYY-MM-DD，含起止日）
    const registeredFrom = typeof body?.registeredFrom === "string" ? body.registeredFrom.trim() : "";
    const registeredTo = typeof body?.registeredTo === "string" ? body.registeredTo.trim() : "";
    // 按余额区间（整数积分，空 = 不限该侧）
    const balanceMinRaw = body?.balanceMin === "" || body?.balanceMin == null ? null : Number(body.balanceMin);
    const balanceMaxRaw = body?.balanceMax === "" || body?.balanceMax == null ? null : Number(body.balanceMax);
    const balanceMin = balanceMinRaw === null ? null : Math.floor(balanceMinRaw);
    const balanceMax = balanceMaxRaw === null ? null : Math.floor(balanceMaxRaw);
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!content) return NextResponse.json({ error: "通知内容不能为空" }, { status: 400 });
    if (subject.length > 200) return NextResponse.json({ error: "标题过长（最多 200 字符）" }, { status: 400 });
    if (content.length > 5000) return NextResponse.json({ error: "内容过长（最多 5000 字符）" }, { status: 400 });
    if (target === "users" && userIds.length === 0) {
      return NextResponse.json({ error: "请填写目标用户 ID 列表" }, { status: 400 });
    }
    if (target === "registered") {
      if ((registeredFrom && !DATE_RE.test(registeredFrom)) || (registeredTo && !DATE_RE.test(registeredTo))) {
        return NextResponse.json({ error: "注册时间格式应为 YYYY-MM-DD" }, { status: 400 });
      }
      if (!registeredFrom && !registeredTo) {
        return NextResponse.json({ error: "请至少填写一侧注册时间" }, { status: 400 });
      }
    }
    if (target === "balance") {
      if (balanceMin !== null && (!Number.isFinite(balanceMin) || balanceMin < 0)) {
        return NextResponse.json({ error: "余额下限应为非负整数" }, { status: 400 });
      }
      if (balanceMax !== null && (!Number.isFinite(balanceMax) || balanceMax < 0)) {
        return NextResponse.json({ error: "余额上限应为非负整数" }, { status: 400 });
      }
      if (balanceMin !== null && balanceMax !== null && balanceMin > balanceMax) {
        return NextResponse.json({ error: "余额区间下限不能大于上限" }, { status: 400 });
      }
      if (balanceMin === null && balanceMax === null) {
        return NextResponse.json({ error: "请至少填写一侧余额阈值" }, { status: 400 });
      }
    }

    let targets: { id: number }[] = [];
    if (target === "all") {
      targets = await db.user.findMany({ where: { status: { not: "banned" } }, select: { id: true } });
    } else if (target === "users") {
      targets = await db.user.findMany({ where: { id: { in: userIds }, status: { not: "banned" } }, select: { id: true } });
    } else if (target === "registered") {
      const range: { gte?: Date; lt?: Date } = {};
      if (registeredFrom) range.gte = new Date(`${registeredFrom}T00:00:00.000Z`);
      if (registeredTo) range.lt = new Date(new Date(`${registeredTo}T00:00:00.000Z`).getTime() + 24 * 3600 * 1000);
      targets = await db.user.findMany({
        where: { status: { not: "banned" }, createdAt: range },
        select: { id: true },
      });
    } else {
      // 按余额区间：有效 CreditGrant（剩余 > 0 且未过期）的余额求和落在 [min, max]
      const groups = await db.creditGrant.groupBy({
        by: ["userId"],
        where: {
          remainingCredits: { gt: 0 },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        _sum: { remainingCredits: true },
      });
      const ids = groups
        .filter((g) => {
          const bal = Number(g._sum.remainingCredits ?? 0n);
          return (balanceMin === null || bal >= balanceMin) && (balanceMax === null || bal <= balanceMax);
        })
        .map((g) => g.userId);
      targets = ids.length
        ? await db.user.findMany({ where: { id: { in: ids }, status: { not: "banned" } }, select: { id: true } })
        : [];
    }
    if (targets.length === 0) {
      return NextResponse.json({ error: "没有匹配的目标用户" }, { status: 400 });
    }

    const batchId = randomUUID();
    await db.userMessage.createMany({
      data: targets.map((u) => ({
        userId: u.id,
        direction: "admin_to_user",
        msgType: "notice",
        subject: subject || null,
        body: content,
        batchId,
      })),
    });

    await logAdminAction({
      adminId: admin.id,
      action: "create",
      targetType: "message",
      detail: JSON.stringify({
        section: "notice_broadcast",
        batchId,
        target,
        count: targets.length,
        filters: {
          userIds: target === "users" ? userIds.length : undefined,
          registeredFrom: registeredFrom || undefined,
          registeredTo: registeredTo || undefined,
          balanceMin: balanceMin ?? undefined,
          balanceMax: balanceMax ?? undefined,
        },
      }),
      ip,
    });
    return NextResponse.json({ ok: true, batchId, count: targets.length });
  }

  // ── 单发通知 ──
  if (action === "notice") {
    const userId = parseInt(String(body?.userId ?? 0));
    const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
    const content = typeof body?.body === "string" ? body.body.trim() : "";
    if (!Number.isInteger(userId) || userId <= 0) {
      return NextResponse.json({ error: "目标用户 ID 无效" }, { status: 400 });
    }
    if (!content) return NextResponse.json({ error: "通知内容不能为空" }, { status: 400 });
    if (subject.length > 200) return NextResponse.json({ error: "标题过长（最多 200 字符）" }, { status: 400 });
    if (content.length > 5000) return NextResponse.json({ error: "内容过长（最多 5000 字符）" }, { status: 400 });

    const target = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!target) return NextResponse.json({ error: "用户不存在" }, { status: 404 });

    const created = await db.userMessage.create({
      data: {
        userId: target.id,
        direction: "admin_to_user",
        msgType: "notice",
        subject: subject || null,
        body: content,
      },
    });

    await logAdminAction({
      adminId: admin.id,
      action: "create",
      targetType: "message",
      targetId: target.id,
      detail: JSON.stringify({ section: "notice_single", messageId: String(created.id) }),
      ip,
    });
    return NextResponse.json({ ok: true, message: msgJson(created) });
  }

  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}
