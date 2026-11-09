// SEO 公共工具：meta description 清洗 + 结构化数据（JSON-LD）构造
import { safeJsonScript } from "./rich";

// meta description：折叠空白 → 过短用兜底文案 → 超长 150 字截断（去尾部标点）
export function metaDescription(raw: string | null | undefined, fallback = ""): string | undefined {
  const text = (raw || "").replace(/\s+/g, " ").trim();
  const base = text.length >= 20 ? text : fallback;
  if (!base) return undefined;
  return base.length <= 150
    ? base
    : base.slice(0, 150).replace(/[\s,，。、;；:：.!！?？…]+$/u, "") + "…";
}

// 绝对地址（结构化数据要求完整 URL）
export function siteUrl(path = ""): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");
  return base + path;
}

// BreadcrumbList JSON-LD（safeJsonScript 序列化，防用户内容闭合 script）
export function breadcrumbJsonLd(items: { name: string; item?: string }[]): string {
  return safeJsonScript({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      ...(it.item ? { item: it.item } : {}),
    })),
  });
}
