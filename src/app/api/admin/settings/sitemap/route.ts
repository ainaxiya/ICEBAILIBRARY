import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { saveSetting } from "@/lib/settings";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

type EngineId = "google" | "bing";

const ENGINES: { id: EngineId; name: string; build: (sitemapUrl: string) => string }[] = [
  {
    id: "google",
    name: "Google",
    build: (u) => `https://www.google.com/ping?sitemap=${encodeURIComponent(u)}`,
  },
  {
    id: "bing",
    name: "Bing",
    build: (u) => `https://www.bing.com/ping?sitemap=${encodeURIComponent(u)}`,
  },
];

function siteBase(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
}

async function readSiteSetting(): Promise<Record<string, any>> {
  const row = await db.siteSetting.findUnique({ where: { key: "site" } });
  if (!row) return {};
  try {
    return JSON.parse(row.value) || {};
  } catch {
    return {};
  }
}

// GET /api/admin/settings/sitemap —— 返回 sitemap 地址与上次提交记录
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const current = await readSiteSetting();
  return NextResponse.json({
    sitemapUrl: `${siteBase()}/sitemap.xml`,
    robotsUrl: `${siteBase()}/robots.txt`,
    engines: ENGINES.map((e) => ({ id: e.id, name: e.name })),
    lastSubmit: current.sitemapLastSubmit || null,
  });
}

const submitSchema = z.object({
  engine: z.enum(["google", "bing", "all"]).optional(),
});

/** 提交前先自检 sitemap 是否可访问、是否包含 URL */
async function checkSitemap(sitemapUrl: string) {
  try {
    const r = await fetch(sitemapUrl, {
      headers: { "User-Agent": "CompletePrompt-SitemapSubmitter/1.0" },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    const text = r.ok ? await r.text() : "";
    const urlCount = (text.match(/<loc>/g) || []).length;
    return {
      ok: r.ok && urlCount > 0,
      httpStatus: r.status,
      urlCount,
      message: r.ok
        ? urlCount > 0
          ? `sitemap 可访问，共 ${urlCount} 条 URL`
          : "sitemap 可访问但没有 URL（内容为空）"
        : `sitemap 访问失败（HTTP ${r.status}）`,
    };
  } catch (e) {
    return {
      ok: false,
      httpStatus: 0,
      urlCount: 0,
      message: `sitemap 无法访问：${(e as Error).message}`,
    };
  }
}

function describeResult(engine: EngineId, httpStatus: number, bodyHint: string) {
  if (engine === "google") {
    if (httpStatus === 404) {
      return "Google 已于 2023 年停止 sitemap ping 接口，请到 Search Console 的 Sitemaps 页面手动提交";
    }
    if (httpStatus === 200) {
      return "已推送到 Google（该接口已被官方弃用，Google 可能不再处理；建议在 Search Console 中确认收录状态）";
    }
    return `Google 返回 HTTP ${httpStatus}${bodyHint ? "：" + bodyHint : ""}`;
  }
  if (httpStatus === 404 || httpStatus === 410) {
    return "Bing 已停止 sitemap ping 接口（410 Gone），建议改用 IndexNow 提交";
  }
  if (httpStatus === 200) {
    return "已推送到 Bing";
  }
  return `Bing 返回 HTTP ${httpStatus}${bodyHint ? "：" + bodyHint : ""}`;
}

// POST /api/admin/settings/sitemap —— 提交 sitemap 给搜索引擎
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = submitSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }
  const target = parsed.data.engine || "google";
  const selected = target === "all" ? ENGINES : ENGINES.filter((e) => e.id === target);

  const sitemapUrl = `${siteBase()}/sitemap.xml`;
  const sitemapCheck = await checkSitemap(sitemapUrl);

  const results: {
    id: EngineId;
    name: string;
    ok: boolean;
    httpStatus: number;
    message: string;
    durationMs: number;
  }[] = [];

  for (const engine of selected) {
    const startedAt = Date.now();
    let httpStatus = 0;
    let bodyHint = "";
    try {
      const r = await fetch(engine.build(sitemapUrl), {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": "CompletePrompt-SitemapSubmitter/1.0" },
        signal: AbortSignal.timeout(15000),
        cache: "no-store",
      });
      httpStatus = r.status;
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        bodyHint = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      }
    } catch (e) {
      bodyHint = (e as Error).message.slice(0, 160);
    }
    results.push({
      id: engine.id,
      name: engine.name,
      ok: httpStatus >= 200 && httpStatus < 300,
      httpStatus,
      message: describeResult(engine.id, httpStatus, bodyHint),
      durationMs: Date.now() - startedAt,
    });
  }

  const record = {
    at: new Date().toISOString(),
    sitemapUrl,
    sitemapCheck,
    results,
  };

  // 记录写入网站设置的同一 JSON，前台/后台都能读到上次提交结果
  const current = await readSiteSetting();
  await saveSetting("site", { ...current, sitemapLastSubmit: record });

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "setting",
    detail: JSON.stringify({
      section: "sitemap",
      engine: target,
      sitemapCheckOk: sitemapCheck.ok,
      codes: results.map((r) => `${r.id}:${r.httpStatus}`),
    }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, ...record });
}
