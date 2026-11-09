import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import JSZip from "jszip";
import { bucketToConfig, getObject } from "@/lib/s3";

export const dynamic = "force-dynamic";

type FileEntry = { path: string; content: string; size?: number };

// 下载技能：
// - files 含 __bundle__ 哨兵（整包上传）→ 回传默认桶内原始 zip，完整还原目录结构
// - 有内联附加文件 → 服务端打包 zip
// - 都没有 → 直接下 SKILL.md
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!rateLimit(`skill-dl:${clientIp(req)}`, 20, 60_000)) {
    return NextResponse.json({ error: "too frequent" }, { status: 429 });
  }

  const { id } = await params;
  const skill = await db.skill.findFirst({ where: { id: Number(id), status: "published" } });
  if (!skill) return NextResponse.json({ error: "not found" }, { status: 404 });

  // 原生 SQL 自增下载计数（不触 updatedAt）
  db.$executeRaw`UPDATE "Skill" SET "downloadCount" = "downloadCount" + 1 WHERE id = ${skill.id}`.catch(() => {});
  //const guanggao = `【此技能由冰山AI资料库整理搜集而成】\n\n`;
  const files = (Array.isArray(skill.files) ? skill.files : []) as unknown as FileEntry[];
  const safeSlug = skill.slug.replace(/[^a-z0-9-]/gi, "_");
  const zipHeaders = {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${safeSlug}.zip"`,
  };

  const bundle = files.find((f) => f.path === "__bundle__" && f.content);
  const inline = files.filter((f) => f.path !== "__bundle__" && (f.content || "").length > 0);

  // 整包上传：优先回传桶内原始 zip（对象丢失时回退内联打包）
  if (bundle) {
    try {
      const bucket = await db.storageBucket.findFirst({
        where: { isDefault: true, enabled: true },
        orderBy: { id: "asc" },
      });
      if (bucket) {
        const buf = await getObject(bucketToConfig(bucket), bundle.content);
        return new NextResponse(new Uint8Array(buf), { headers: zipHeaders });
      }
    } catch (e) {
      console.warn("[skill-dl] bundle fetch failed, fallback to inline zip:", (e as Error).message);
    }
  }

  if (inline.length === 0) {
    return new NextResponse(skill.skillMd, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeSlug}.md"`,
      },
    });
  }

  const zip = new JSZip();
  zip.file("SKILL.md", skill.skillMd);
  for (const f of inline) {
    const p = (f.path || "").replace(/\.\./g, "").replace(/^\/+/, "");
    if (!p || p === "SKILL.md") continue;
    zip.file(p, f.content);
  }
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return new NextResponse(new Uint8Array(buf), { headers: zipHeaders });
}
