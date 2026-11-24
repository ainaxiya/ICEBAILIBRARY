import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { saveUserMedia, UploadError } from "@/lib/upload-core.server";
import { getBalance } from "@/lib/credits";
import { minBalanceCreditsFor } from "@/lib/gateway/credits-gate";
import { getPlaygroundSettings } from "@/lib/playground/settings";

export const dynamic = "force-dynamic";

// POST /api/upload  multipart: file
// 用户投稿媒体单文件上传；批量上传由前端并发调用本接口（见 UniversalUploader）
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    // 上传限流：每 IP 每分钟 30 次（批量并发时按文件计）
    if (!rateLimit(`upload:${clientIp(req)}`, 30, 60_000)) {
      return NextResponse.json({ error: "too many requests" }, { status: 429 });
    }

    const settings = await getSettings();
    if (!settings.publish.allowUpload) {
      return NextResponse.json({ error: "upload disabled" }, { status: 403 });
    }

    // pa25：实验场素材走后台可配的格式 / 体积上限；其它上传场景沿用投稿设置。
    const pgUpload = (await getPlaygroundSettings()).upload;

    // S0-6 前置大小校验：解析 multipart 前先拒掉超大请求体（避免先吃内存再被拒）。
    // 上限 = 图片/视频配置较大者 + 1MB multipart 编码余量；chunked 无 Content-Length 时
    // 跳过此检查，由 saveUserMedia 解析后校验兜底。
    const maxUploadMB = Math.max(
      settings.publish.maxImageMB || 0,
      settings.publish.maxVideoMB || 0,
      pgUpload.imageMaxMB,
      pgUpload.videoMaxMB
    );
    const contentLength = Number(req.headers.get("content-length") || 0);
    if (maxUploadMB > 0 && contentLength > (maxUploadMB + 1) * 1024 * 1024) {
      return NextResponse.json({ error: "file too large" }, { status: 413 });
    }

    const form = await req.formData().catch(() => null);
    // pa26：单次请求只接受一个文件；批量由前端并发调用（UniversalUploader 的 maxFiles 上限）。
    const files = form?.getAll("file") ?? [];
    if (files.length > 1) {
      return NextResponse.json(
        { error: "一次只能上传一个文件", code: "too_many_files" },
        { status: 400 }
      );
    }
    const file = files[0];
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "no file" }, { status: 400 });
    }

    // 实验场素材（首帧/参考图/参考视频）落盘前先查积分：
    // 积分不足直接 402，不写盘，避免产生永远用不上的孤儿文件。
    // 其他场景（投稿封面、头像等）不带 scope，行为不变。
    if (form?.get("scope") === "playground") {
      const model = form.get("model");
      const balance = Number(await getBalance(user.id));
      const min = typeof model === "string" && model ? minBalanceCreditsFor({ name: model }) : 0;
      const required = Math.max(min, 1);
      if (balance < required) {
        return NextResponse.json(
          { error: "积分不足，无法上传素材", code: "insufficient_credits", balance, required },
          { status: 402 }
        );
      }
    }

    const saved = await saveUserMedia(
      file,
      form?.get("scope") === "playground"
        ? {
            maxImageMB: pgUpload.imageMaxMB,
            maxVideoMB: pgUpload.videoMaxMB,
            allowedImageKinds: pgUpload.imageFormats,
            allowedVideoKinds: pgUpload.videoFormats,
          }
        : {
            maxImageMB: settings.publish.maxImageMB,
            maxVideoMB: settings.publish.maxVideoMB,
          }
    );
    return NextResponse.json(saved);
  } catch (e) {
    if (e instanceof UploadError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[upload] failed:", e);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
