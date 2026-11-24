import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { requirePerm, PERMISSIONS, logAdminAction, getClientIp } from "@/lib/rbac";
import { EMAIL_TEMPLATES } from "@/lib/mailer";

export const dynamic = "force-dynamic";

// ─── P7 邮件模板管理（后台「站点管理→邮件模板」） ───
// GET：定义 + 库内当前值合并返回（含可用变量说明）
// PUT：按 key 更新 subject/bodyHtml/enabled（key 必须在已知模板定义内）
//      subject 与 bodyHtml 同时留空 = 恢复该模板默认内容

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const rows = await db.emailTemplate.findMany();
  const map = new Map(rows.map((r) => [r.key, r]));
  return NextResponse.json({
    templates: EMAIL_TEMPLATES.map((def) => {
      const row = map.get(def.key);
      return {
        key: def.key,
        name: def.name,
        desc: def.desc,
        vars: def.vars,
        defaultSubject: def.subject,
        defaultBodyHtml: def.bodyHtml,
        subject: row?.subject ?? def.subject,
        bodyHtml: row?.bodyHtml ?? def.bodyHtml,
        enabled: row?.enabled ?? true,
        customized: !!row && (row.subject !== def.subject || row.bodyHtml !== def.bodyHtml),
      };
    }),
  });
}

const putSchema = z.object({
  key: z.string().regex(/^[a-z_]+$/),
  subject: z.string().max(300),
  bodyHtml: z.string().max(100_000),
  enabled: z.boolean(),
});

export async function PUT(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { key, subject, bodyHtml, enabled } = parsed.data;
  const def = EMAIL_TEMPLATES.find((t) => t.key === key);
  if (!def) return NextResponse.json({ error: "未知模板" }, { status: 400 });

  // 恢复默认：subject 与 bodyHtml 均为空串时写入模板默认值
  const finalSubject = subject.trim() === "" && bodyHtml.trim() === "" ? def.subject : subject;
  const finalBody = subject.trim() === "" && bodyHtml.trim() === "" ? def.bodyHtml : bodyHtml;

  await db.emailTemplate.upsert({
    where: { key },
    update: { subject: finalSubject, bodyHtml: finalBody, enabled },
    create: { key, subject: finalSubject, bodyHtml: finalBody, enabled },
  });

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "email_template",
    detail: JSON.stringify({ key, enabled, resetToDefault: subject.trim() === "" && bodyHtml.trim() === "" }),
    ip: await getClientIp(),
  });
  return NextResponse.json({ ok: true });
}
