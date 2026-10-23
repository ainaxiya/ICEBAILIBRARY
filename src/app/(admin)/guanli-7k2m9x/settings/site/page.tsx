import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ADMIN_BASE } from "@/lib/admin-path";
import SiteSettingsForm from "@/components/admin/SiteSettingsForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "网站设置" };

const DEFAULT_SITE = {
  siteName: "冰山AI资料库",
  siteNameEn: "Iceberg AI Library",
  siteDescription: "",
  searchKeywords: "",
  footerText: "",
  logoIcon: "",
  favicon: "",
  appIcon: "",
  optimizerApiKey: "",
  optimizerModel: "deepseek-flash",
  optimizerPrompt: "",
  friendLinks: "",
  meiliSyncSeconds: 30,
};

type SitemapSubmitRecord = {
  at: string;
  sitemapUrl: string;
  sitemapCheck?: { ok: boolean; httpStatus: number; urlCount: number; message: string };
  results: {
    id: "google" | "bing";
    name: string;
    ok: boolean;
    httpStatus: number;
    message: string;
    durationMs: number;
  }[];
};

export default async function AdminSiteSettingsPage() {
  const admin = await requireAdmin();
  if (!admin) redirect(`${ADMIN_BASE}/login`);

  const row = await db.siteSetting.findUnique({ where: { key: "site" } });
  let initial = { ...DEFAULT_SITE };
  let lastSitemapSubmit: SitemapSubmitRecord | null = null;
  if (row) {
    try {
      const parsed = JSON.parse(row.value);
      initial = { ...DEFAULT_SITE, ...parsed };
      lastSitemapSubmit = parsed.sitemapLastSubmit || null;
    } catch {}
  }
  const siteBase = (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/+$/, "");

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">网站设置</h1>
      <p className="mb-5 text-sm text-zinc-500">
        管理网站基本信息、SEO 关键字、页脚文字与站点图标。
      </p>
      <SiteSettingsForm
        initial={initial}
        sitemapUrl={`${siteBase}/sitemap.xml`}
        lastSitemapSubmit={lastSitemapSubmit}
      />
    </div>
  );
}
