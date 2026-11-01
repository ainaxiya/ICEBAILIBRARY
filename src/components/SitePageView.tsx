import { getServerLocale, translate as t, type DictKey } from "@/lib/i18n";
import { sanitizeRich } from "@/lib/sanitize.server";
import type { SitePageSlug } from "@/lib/site-page";

// 固定单页共用渲染：标题（zh 用库内 title，en 用词典）+ 净化后的富文本内容
export default async function SitePageView({
  slug,
  titleZh,
  html,
}: {
  slug: SitePageSlug;
  titleZh: string;
  html: string;
}) {
  const locale = await getServerLocale();
  const title = locale === "en" ? t(locale, `page.${slug}.title` as DictKey) : titleZh;
  const content = html ? sanitizeRich(html) : "";

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 text-2xl font-bold text-zinc-100">{title}</h1>
      {content ? (
        <div
          className="rich-content text-sm leading-relaxed text-zinc-300"
          dangerouslySetInnerHTML={{ __html: content }}
        />
      ) : (
        <p className="py-16 text-center text-zinc-500">{t(locale, "page.empty")}</p>
      )}
    </div>
  );
}
