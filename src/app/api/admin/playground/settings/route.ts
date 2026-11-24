import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import {
  HARD_MAX_IMAGE_MB,
  HARD_MAX_REFERENCE_IMAGES,
  HARD_MAX_REFERENCE_VIDEOS,
  HARD_MAX_VIDEO_MB,
  IMAGE_FORMAT_OPTIONS,
  MAX_GUEST_TRIALS,
  PERSONA_MAX_LEN,
  VIDEO_FORMAT_OPTIONS,
  getPlaygroundSettings,
  setDefaultModels,
  setGuestTrialConfig,
  setParamPolicy,
  setPersona,
  setPlaygroundEnabled,
  setRateLimitNotice,
  setReferenceLimits,
  setTaskCopy,
  setUploadLimits,
} from "@/lib/playground/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const { ok } = await requirePerm(PERMISSIONS.SETTING_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const s = await getPlaygroundSettings();
  // 与后台表单同构：lockDefaults 平铺，避免后台把未读取到的值覆盖为 false
  return NextResponse.json({
    guest: s.guest,
    defaultModels: s.defaultModels,
    lockDefaults: s.paramPolicy.lockDefaults,
    limits: s.limits,
    upload: s.upload,
    copy: s.copy,
    rateLimitNotice: s.rateLimitNotice,
    persona: s.persona,
    enabled: s.enabled,
    // 表单可选项与硬上限，避免前后端各写一套
    options: {
      imageFormats: IMAGE_FORMAT_OPTIONS,
      videoFormats: VIDEO_FORMAT_OPTIONS,
      hardMaxImageMB: HARD_MAX_IMAGE_MB,
      hardMaxVideoMB: HARD_MAX_VIDEO_MB,
      personaMaxLen: PERSONA_MAX_LEN,
    },
  });
}

const bodySchema = z.object({
  guest: z.object({
    enabled: z.boolean(),
    maxTrials: z.number().int().min(0).max(MAX_GUEST_TRIALS),
  }),
  defaultModels: z.object({
    image: z.string().trim().min(1).max(120),
    video: z.string().trim().min(1).max(120),
  }),
  lockDefaults: z.boolean(),
  limits: z.object({
    // 允许提交任意非负整数，保存时按模型硬上限截断并回传提示
    maxReferenceImages: z.number().int().min(0).max(999).nullable(),
    maxReferenceVideos: z.number().int().min(0).max(999).nullable(),
  }),
  upload: z.object({
    imageMaxMB: z.number().int().min(1).max(999),
    videoMaxMB: z.number().int().min(1).max(999),
    imageFormats: z.array(z.string()).max(10),
    videoFormats: z.array(z.string()).max(10),
  }),
  copy: z.object({
    queued: z.string().max(60),
    running: z.string().max(60),
    failed: z.string().max(60),
    timeout: z.string().max(60),
  }),
  rateLimitNotice: z.string().max(60),
  // pa8 平台级人设提示词：空 = 不额外注入系统提示
  persona: z.string().max(PERSONA_MAX_LEN),
  // pa1 实验场总开关
  enabled: z.boolean(),
});

// pa 组口径：游客试玩 / 默认模型 / 锁定默认参数 / 参考素材上限
export async function PUT(req: NextRequest) {
  const { user: admin, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!admin || !ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const input = parsed.data;

  // 默认模型必须存在于模型库且类型匹配，避免后台写入一个前台永远选不到的名字
  const wanted: { kind: "image" | "video"; name: string }[] = [
    { kind: "image", name: input.defaultModels.image },
    { kind: "video", name: input.defaultModels.video },
  ];
  for (const item of wanted) {
    const row = await db.aiModel.findFirst({
      where: { name: item.name, endpointType: item.kind },
      select: { id: true, status: true },
    });
    if (!row) {
      return NextResponse.json(
        { error: `默认${item.kind === "image" ? "图片" : "视频"}模型「${item.name}」在模型库里不存在或类型不匹配` },
        { status: 400 }
      );
    }
    if (row.status !== "online") {
      return NextResponse.json(
        { error: `默认${item.kind === "image" ? "图片" : "视频"}模型「${item.name}」当前不是「已上线」状态` },
        { status: 400 }
      );
    }
  }

  const guest = await setGuestTrialConfig(input.guest);
  const defaultModels = await setDefaultModels(input.defaultModels);
  const paramPolicy = await setParamPolicy({ lockDefaults: input.lockDefaults });
  const limitsResult = await setReferenceLimits(input.limits);
  const uploadResult = await setUploadLimits(input.upload);
  const copy = await setTaskCopy(input.copy);
  const rateLimitNotice = await setRateLimitNotice(input.rateLimitNotice);
  const persona = await setPersona(input.persona);
  const enabled = await setPlaygroundEnabled(input.enabled);

  const notes: string[] = [];
  if (limitsResult.clampedImages) {
    notes.push(`参考图上限已按模型能力截断为 ${HARD_MAX_REFERENCE_IMAGES}`);
  }
  if (limitsResult.clampedVideos) {
    notes.push(`参考视频上限已按模型能力截断为 ${HARD_MAX_REFERENCE_VIDEOS}`);
  }
  if (uploadResult.clampedImage) {
    notes.push(`图片体积上限已按程序硬上限截断为 ${HARD_MAX_IMAGE_MB}MB`);
  }
  if (uploadResult.clampedVideo) {
    notes.push(`视频体积上限已按程序硬上限截断为 ${HARD_MAX_VIDEO_MB}MB`);
  }
  if (uploadResult.limits.imageFormats.length === 0) {
    notes.push("图片格式一项都没有勾选：前台将不允许上传图片素材");
  }
  if (uploadResult.limits.videoFormats.length === 0) {
    notes.push("视频格式一项都没有勾选：前台将不允许上传视频素材");
  }

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "setting",
    detail: JSON.stringify({ guest, defaultModels, paramPolicy, limits: limitsResult.limits, upload: uploadResult.limits, copy, rateLimitNotice, persona, enabled }),
    ip: await getClientIp(),
  });

  return NextResponse.json({
    ok: true,
    guest,
    defaultModels,
    lockDefaults: paramPolicy.lockDefaults,
    limits: limitsResult.limits,
    upload: uploadResult.limits,
    copy,
    rateLimitNotice,
    persona,
    enabled,
    notes,
  });
}
