import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/auth";
import { bucketToConfig, presignDownload } from "@/lib/s3";

export const dynamic = "force-dynamic";

// 下载软件条目：GET /api/software/[id]/download?dl=<downloadId>
// local → 302 到 /uploads 路径；bucket → 60 秒预签名 URL 302
// memberOnly 条目强制会员登录（API 层校验，不只靠前端隐藏）
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!rateLimit(`soft-dl:${clientIp(req)}`, 20, 60_000)) {
    return NextResponse.json({ error: "too frequent" }, { status: 429 });
  }

  const { id } = await params;
  const dlId = Number(new URL(req.url).searchParams.get("dl") || "");
  if (!dlId) return NextResponse.json({ error: "missing dl" }, { status: 400 });

  const soft = await db.software.findFirst({ where: { id: Number(id), status: "published" } });
  if (!soft) return NextResponse.json({ error: "not found" }, { status: 404 });

  const dl = await db.softwareDownload.findFirst({
    where: { id: dlId, softwareId: soft.id },
    include: { bucket: true },
  });
  if (!dl) return NextResponse.json({ error: "not found" }, { status: 404 });

  // 会员限定校验
  if (dl.memberOnly) {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "login required", memberOnly: true }, { status: 401 });
    }
  }

  // 计数自增（原生 SQL 不触 updatedAt，避免 Meili 重复推送）
  db.$executeRaw`UPDATE "Software" SET download_count = download_count + 1 WHERE id = ${soft.id}`.catch(() => {});
  db.$executeRaw`UPDATE "SoftwareDownload" SET download_count = download_count + 1 WHERE id = ${dl.id}`.catch(() => {});

  if (dl.storageType === "bucket") {
    if (!dl.bucket || !dl.objectKey || !dl.bucket.enabled) {
      return NextResponse.json({ error: "storage unavailable" }, { status: 502 });
    }
    try {
      const url = await presignDownload(bucketToConfig(dl.bucket), dl.objectKey, 60);
      return NextResponse.redirect(url, 302);
    } catch (e) {
      console.warn("[software] presign failed:", dl.id, e);
      return NextResponse.json({ error: "storage unavailable" }, { status: 502 });
    }
  }

  // local：强制站内 /uploads 相对路径，防开放重定向
  const u = dl.fileUrl || "";
  if (!u.startsWith("/uploads/")) {
    return NextResponse.json({ error: "invalid file" }, { status: 400 });
  }
  return NextResponse.redirect(new URL(u, req.url), 302);
}
