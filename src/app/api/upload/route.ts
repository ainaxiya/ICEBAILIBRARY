import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { saveUserMedia, UploadError } from "@/lib/upload-core.server";

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

    // S0-6 前置大小校验：解析 multipart 前先拒掉超大请求体（避免先吃内存再被拒）。
    // 上限 = 图片/视频配置较大者 + 1MB multipart 编码余量；chunked 无 Content-Length 时
    // 跳过此检查，由 saveUserMedia 解析后校验兜底。
    const maxUploadMB = Math.max(settings.publish.maxImageMB || 0, settings.publish.maxVideoMB || 0);
    const contentLength = Number(req.headers.get("content-length") || 0);
    if (maxUploadMB > 0 && contentLength > (maxUploadMB + 1) * 1024 * 1024) {
      return NextResponse.json({ error: "file too large" }, { status: 413 });
    }

    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "no file" }, { status: 400 });
    }

    const saved = await saveUserMedia(file, {
      maxImageMB: settings.publish.maxImageMB,
      maxVideoMB: settings.publish.maxVideoMB,
    });
    return NextResponse.json(saved);
  } catch (e) {
    if (e instanceof UploadError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[upload] failed:", e);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
