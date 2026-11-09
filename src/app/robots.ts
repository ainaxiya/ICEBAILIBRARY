import type { MetadataRoute } from "next";

export const revalidate = 3600;

export default function robots(): MetadataRoute.Robots {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // 内部搜索/登录后页面/接口：屏蔽抓取（防止 ?q= 等参数 URL 无限增殖）
        // /login /register 不屏蔽——改用 meta noindex（被 robots 屏蔽时搜索引擎读不到 noindex，无法干净除名）
        disallow: ["/api/", "/search", "/member", "/recharge", "/user/", "/publish"],
      },
    ],
    // sitemap index（按类型/ID 段分片，见 app/sitemap.xml/route.ts）
    sitemap: `${base}/sitemap.xml`,
  };
}
