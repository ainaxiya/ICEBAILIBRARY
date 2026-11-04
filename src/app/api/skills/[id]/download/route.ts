import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import JSZip from "jszip";

export const dynamic = "force-dynamic";

type FileEntry = { path: string; content: string; size?: number };

// 下载技能：无附加文件 → 直接下 SKILL.md；有附加文件 → 服务端打包 zip
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
  //const guanggao = `【此技能由冰山AI资料库 wango8.com 整理搜集而成】\n\n`;
  const files = (Array.isArray(skill.files) ? skill.files : []) as unknown as FileEntry[];
  const safeSlug = skill.slug.replace(/[^a-z0-9-]/gi, "_");

  if (files.length === 0) {
    return new NextResponse(skill.skillMd, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeSlug}.md"`,
      },
    });
  }

  const zip = new JSZip();
  zip.file("SKILL.md", skill.skillMd);
  for (const f of files) {
    const p = (f.path || "").replace(/\.\./g, "").replace(/^\/+/, "");
    if (!p || p === "SKILL.md") continue;
    zip.file(p, f.content);
  }
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeSlug}.zip"`,
    },
  });
}
