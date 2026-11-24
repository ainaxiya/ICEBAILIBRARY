import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePerm, PERMISSIONS, logAdminAction, getClientIp } from "@/lib/rbac";
import {
  getQueueConfig,
  saveQueueConfig,
  QUEUE_CHANNEL_META,
  QUEUE_LIMIT_MIN,
  QUEUE_LIMIT_MAX,
} from "@/lib/queue/queue-config";

export const dynamic = "force-dynamic";

// ─── P6 #22 队列并发设置（SiteSetting key="queue_config"）──
// GET  /api/admin/settings/queue  读取当前并发 + 每项文案（是什么/代价/是否需重启）
// PUT  /api/admin/settings/queue  保存并发；返回本次改动中需要重启 Worker 才生效的项

export async function GET() {
  const { ok } = await requirePerm(PERMISSIONS.SETTING_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const config = await getQueueConfig();
  return NextResponse.json({
    config,
    meta: QUEUE_CHANNEL_META,
    min: QUEUE_LIMIT_MIN,
    max: QUEUE_LIMIT_MAX,
  });
}

const limit = z.coerce
  .number()
  .int()
  .min(QUEUE_LIMIT_MIN, `并发数不能小于 ${QUEUE_LIMIT_MIN}`)
  .max(QUEUE_LIMIT_MAX, `并发数不能大于 ${QUEUE_LIMIT_MAX}`);

const bodySchema = z.object({
  video: limit,
  audio: limit,
  image: limit,
  text: limit,
  download: limit,
});

export async function PUT(req: NextRequest) {
  const { user: admin, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!admin || !ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }

  const { config, restartRequired } = await saveQueueConfig(parsed.data);
  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "setting",
    detail: JSON.stringify({ section: "queue_config", config, restart: restartRequired.map((m) => m.key) }),
    ip: await getClientIp(),
  });
  return NextResponse.json({ ok: true, config, restartRequired });
}
