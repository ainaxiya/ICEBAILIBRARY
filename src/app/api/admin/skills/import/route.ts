import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import JSZip from "jszip";
import { db } from "@/lib/db";
import { requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { bucketToConfig, putObject } from "@/lib/s3";

export const dynamic = "force-dynamic";

const MAX_ZIP = 50 * 1024 * 1024; // 压缩包 50MB
const MAX_TOTAL = 200 * 1024 * 1024; // 解压总量 200MB
const MAX_FILES = 2000;

// SKILL.md frontmatter 兜底取 name/description
function frontmatter(md: string): { name?: string; summary?: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: { name?: string; summary?: string } = {};
  const name = m[1].match(/^name:\s*["']?(.+?)["']?\s*$/m);
  const desc = m[1].match(/^(?:description|summary):\s*["']?(.+?)["']?\s*$/m);
  if (name) out.name = name[1].trim();
  if (desc) out.summary = desc[1].trim();
  return out;
}

// POST /api/admin/skills/import —— 技能 zip 整包上传
// 解析校验（SKILL.md 必含、路径不越级、限量）后原始 zip 存默认桶 skills/<yyyyMM>/<uuid>.zip，
// 返回 SKILL.md 全文 + 文件树清单（内容不入库，下载时回传原 zip 完整还原目录结构）
export async function POST(req: NextRequest) {
  const { admin, ok } = await requirePerm("skill:manage");
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  try {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "缺少 zip 文件（表单字段 file）" }, { status: 400 });
    }
    if (file.size > MAX_ZIP) {
      return NextResponse.json({ error: "zip 超过 50MB 上限" }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buf);
    } catch {
      return NextResponse.json({ error: "不是有效的 zip 文件" }, { status: 400 });
    }

    // 收集条目 + 路径校验（禁止 ../ 越级、绝对路径、盘符；统一 / 分隔）
    type Item = { path: string; entry: JSZip.JSZipObject };
    const items: Item[] = [];
    for (const [raw, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const p = raw.replace(/\\/g, "/");
      const base = p.split("/").pop() || "";
      if (p.startsWith("__MACOSX/") || base === ".DS_Store") continue;
      if (p.startsWith("/") || /^[a-zA-Z]:/.test(p) || p.split("/").includes("..") || !base.trim()) {
        return NextResponse.json({ error: `非法路径：${raw}` }, { status: 400 });
      }
      items.push({ path: p, entry });
    }
    if (items.length === 0) return NextResponse.json({ error: "zip 内没有文件" }, { status: 400 });
    if (items.length > MAX_FILES) {
      return NextResponse.json({ error: `文件数 ${items.length} 超过 ${MAX_FILES} 上限` }, { status: 400 });
    }

    // 单层包装目录自动剥壳（skill-name/SKILL.md → SKILL.md）；文件只允许在 SKILL.md 平级或下级
    if (!items.some((i) => i.path === "SKILL.md")) {
      const tops = new Set(items.map((i) => i.path.split("/")[0]));
      const allNested = items.every((i) => i.path.includes("/"));
      if (tops.size === 1 && allNested) {
        const prefix = [...tops][0] + "/";
        for (const i of items) i.path = i.path.slice(prefix.length);
      }
    }
    const skillMdItem = items.find((i) => i.path === "SKILL.md");
    if (!skillMdItem) {
      return NextResponse.json({ error: "zip 根目录（或单层包装目录内）缺少 SKILL.md" }, { status: 400 });
    }

    // 解压校验总量、取 SKILL.md、生成文件树
    let total = 0;
    let skillMd = "";
    const tree: { path: string; size: number }[] = [];
    for (const i of items) {
      const data = await i.entry.async("uint8array");
      total += data.length;
      if (total > MAX_TOTAL) {
        return NextResponse.json({ error: "解压总量超过 200MB 上限" }, { status: 400 });
      }
      if (i.entry === skillMdItem.entry) {
        skillMd = new TextDecoder("utf-8").decode(data);
      } else {
        tree.push({ path: i.path, size: data.length });
      }
    }
    if (!skillMd.trim()) return NextResponse.json({ error: "SKILL.md 为空" }, { status: 400 });

    // 原始 zip 存默认桶
    const bucket = await db.storageBucket.findFirst({
      where: { isDefault: true, enabled: true },
      orderBy: { id: "asc" },
    });
    if (!bucket) {
      return NextResponse.json({ error: "未配置默认存储桶，请先在存储管理中设置" }, { status: 400 });
    }
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
    const bundleKey = `skills/${ym}/${randomUUID()}.zip`;
    await putObject(bucketToConfig(bucket), bundleKey, buf, "application/zip");

    const fm = frontmatter(skillMd);
    await logAdminAction({
      adminId: admin.id,
      action: "import",
      targetType: "skill",
      targetId: 0,
      detail: `上传技能整包 ${file.name}（${items.length} 个文件）`,
      ip: await getClientIp(),
    });

    return NextResponse.json({
      name: fm.name || file.name.replace(/\.zip$/i, ""),
      summary: fm.summary || "",
      skillMd,
      bundleKey,
      bundleSize: buf.length,
      fileCount: items.length,
      tree,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("无法解密")) {
      return NextResponse.json(
        { error: "存储桶密钥无法解密（历史密钥已变更）：请到「存储桶设置」重新保存该桶的 SecretKey 后再上传" },
        { status: 500 }
      );
    }
    console.error("[skills/import]", e);
    return NextResponse.json({ error: `上传处理失败：${msg}` }, { status: 500 });
  }
}
