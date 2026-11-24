import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { logAdminAction, getClientIp, requirePerm, PERMISSIONS } from "@/lib/rbac";
import { sanitizeRich } from "@/lib/sanitize.server";
import { isHtmlContent, stripHtml } from "@/lib/rich";

export const dynamic = "force-dynamic";

// ─── v0.92 #4 后台：消息·工单（工单队列 / 回复 / 关闭 / 群发 / 单发通知） ───

function msgJson(m: {
  id: bigint;
  userId: number | null;
  direction: string;
  msgType: string;
  subject: string | null;
  body: string;
  ticketStatus: string | null;
  batchId: string | null;
  readAt: Date | null;
  replyBy?: string | null;
  replyByNick?: string | null;
  adminReadAt?: Date | null;
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
    replyBy: m.replyBy ?? null,
    replyByNick: m.replyByNick ?? null,
    adminReadAt: m.adminReadAt ?? null,
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
  const { user, ok } = await requirePerm(PERMISSIONS.USER_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

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

    // v0.92 #4：会员信息面板（账号/状态/权限/积分/APIKey/注册登录轨迹）
    // 会员被删除后 userId 为空：工单照常展示，会员面板为空
    const memberId = root.userId;
    const [grants, apiKeyCount] = memberId
      ? await Promise.all([
          db.creditGrant.findMany({
            where: {
              userId: memberId,
              remainingCredits: { gt: 0 },
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
            select: { remainingCredits: true },
          }),
          db.userApiKey.count({ where: { userId: memberId } }),
        ])
      : [[], 0];
    const u = memberId ? await db.user.findUnique({ where: { id: memberId } }) : null;
    const member = u
      ? {
          id: u.id,
          username: u.username,
          nickname: u.nickname,
          status: u.status,
          allowPublish: u.allowPublish,
          commentBanned: u.commentBanned,
          balanceCredits: grants.reduce((s, g) => s + Number(g.remainingCredits), 0),
          apiKeyCount,
          createdAt: u.createdAt,
          registerIp: u.registerIp,
          lastLoginAt: u.lastLoginAt,
          lastLoginIp: u.lastLoginIp,
        }
      : null;

    // 打开会话即把该会话的会员消息标记为管理员已读（红标清零）
    await db.userMessage.updateMany({
      where: { OR: [{ id: rootId }, { replyToId: rootId }], direction: "user_to_admin", adminReadAt: null },
      data: { adminReadAt: new Date() },
    });

    return NextResponse.json({
      thread: { ...msgJson(root), user: root.user },
      member,
      messages: messages.map(msgJson),
    });
  }

  const status = sp.get("status") || "open";
  const page = Math.max(1, parseInt(sp.get("page") || "1") || 1);
  // 可选按会员过滤（会员详情页工单区块）
  const userIdRaw = (sp.get("userId") || "").trim();
  const filterUserId = userIdRaw ? parseInt(userIdRaw, 10) : 0;
  if (userIdRaw && (!Number.isInteger(filterUserId) || filterUserId <= 0)) {
    return NextResponse.json({ error: "会员 userId 无效" }, { status: 400 });
  }
  const where = {
    direction: "user_to_admin",
    msgType: "ticket",
    replyToId: null,
    ...(filterUserId ? { userId: filterUserId } : {}),
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
          select: {
            body: true,
            direction: true,
            createdAt: true,
            replyBy: true,
            replyByNick: true,
            adminReadAt: true,
          },
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
      const lastAdmin = [...r.replies].reverse().find((x) => x.direction === "admin_to_user");
      // v0.92 #4：新会员消息红标数字（根消息 + 回复里未被管理员读过的会员消息）
      const newMsgCount =
        (r.adminReadAt ? 0 : 1) +
        r.replies.filter((x) => x.direction === "user_to_admin" && !x.adminReadAt).length;
      return {
        ...msgJson(r),
        user: r.user,
        replyCount: r.replies.length,
        lastBody: last?.body ?? r.body,
        lastAt: last?.createdAt ?? r.createdAt,
        replyBy: lastAdmin?.replyBy ?? null,
        newMsgCount,
      };
    }),
  });
}

// POST /api/admin/messages —— 动作分发：
// { action: "reply",   threadId, body }                       回复工单（admin_to_user）
// { action: "close",   threadId }                             关闭工单
// { action: "batch",   op: "close"|"delete", threadIds[] }    批量关闭/批量删除会话
// { action: "broadcast", subject, body, target, userIds[] }   群发通知（batchId 批次）
// { action: "notice",  userId, subject, body }                单发通知
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.USER_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const action = typeof body?.action === "string" ? body.action : "";
  const ip = await getClientIp();

  // ── 回复工单 ──
  if (action === "reply") {
    const threadId = parseId(body?.threadId);
    if (!threadId) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    const raw = typeof body?.body === "string" ? body.body.trim() : "";
    const content = isHtmlContent(raw) ? sanitizeRich(raw) : raw;
    if (!stripHtml(content)) return NextResponse.json({ error: "回复内容不能为空" }, { status: 400 });
    if (content.length > 20000) return NextResponse.json({ error: "内容过长（最多 20000 字符）" }, { status: 400 });
    // v0.92 #4：回复后关闭此工单（勾选才关，默认不关）
    const closeAfter = body?.closeAfter === true;

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
          // v0.92 #4：记录回复人（管理账号 + 昵称快照）
          replyBy: admin.username,
          replyByNick: admin.nickname || admin.username,
        },
      }),
      db.userMessage.update({
        where: { id: root.id },
        data: { ticketStatus: closeAfter ? "closed" : "replied" },
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
        .map((g) => g.userId)
        .filter((v): v is number => v !== null);
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

  // ── 批量操作（op=close 批量关闭 / op=delete 批量删除会话） ──
  if (action === "batch") {
    const op = body?.op === "close" || body?.op === "delete" ? (body.op as "close" | "delete") : "";
    if (!op) return NextResponse.json({ error: "未知批量操作" }, { status: 400 });
    const rawIds: unknown[] = Array.isArray(body?.threadIds) ? body.threadIds : [];
    if (rawIds.length === 0) return NextResponse.json({ error: "请选择要操作的工单" }, { status: 400 });
    if (rawIds.length > 200) return NextResponse.json({ error: "单次最多操作 200 条" }, { status: 400 });
    const rootIds: bigint[] = [];
    for (const v of rawIds) {
      const id = parseId(v);
      if (!id) return NextResponse.json({ error: "参数错误" }, { status: 400 });
      rootIds.push(id);
    }

    let affected = 0;
    if (op === "close") {
      // 批量把根消息 ticketStatus 置 closed（仅工单会话根消息生效）
      affected = (
        await db.userMessage.updateMany({
          where: { id: { in: rootIds }, msgType: "ticket", replyToId: null },
          data: { ticketStatus: "closed" },
        })
      ).count;
    } else {
      // 批量删除会话：根消息 + 全部回复
      affected = (
        await db.userMessage.deleteMany({
          where: { OR: [{ id: { in: rootIds } }, { replyToId: { in: rootIds } }] },
        })
      ).count;
    }

    await logAdminAction({
      adminId: admin.id,
      action: op === "delete" ? "delete" : "update",
      targetType: "message",
      detail: JSON.stringify({ section: "ticket_batch", op, threadIds: rootIds.map(String), affected }),
      ip,
    });
    return NextResponse.json({ ok: true, affected });
  }

  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}
