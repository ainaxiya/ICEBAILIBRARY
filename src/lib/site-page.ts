import "server-only";
import { db } from "./db";

// 固定单页白名单（不做通用 CMS，仅这几页；slug 同时就是前台路由）
export const SITE_PAGE_SLUGS = ["help", "about", "contact", "terms", "privacy", "credit-rules"] as const;
export type SitePageSlug = (typeof SITE_PAGE_SLUGS)[number];

// 缺行时的默认中文标题（后台 GET 也用它做种子）
export const SITE_PAGE_DEFAULT_TITLES: Record<SitePageSlug, string> = {
  help: "使用帮助",
  about: "关于我们",
  contact: "联系我们",
  terms: "服务条款",
  privacy: "隐私政策",
  "credit-rules": "积分规则",
};

export type SitePageData = {
  slug: SitePageSlug;
  title: string;
  content: string;
};

// 查固定单页；缺行或表未就绪时返回默认中文标题 + 空内容
export async function getSitePage(slug: SitePageSlug): Promise<SitePageData> {
  const row = await db.sitePage
    .findUnique({ where: { slug } })
    .catch(() => null);
  return {
    slug,
    title: row?.title || SITE_PAGE_DEFAULT_TITLES[slug],
    content: row?.content || "",
  };
}
