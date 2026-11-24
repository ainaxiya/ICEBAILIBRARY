import Link from "next/link";
import Script from "next/script";
import SiteHeader from "@/components/SiteHeader";
import MobileTabBar from "@/components/MobileTabBar";
import HideOnRoutes from "@/components/HideOnRoutes";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { getPublicSite } from "@/lib/settings";
import { getServerLocale, translate as t } from "@/lib/i18n";
import { getPlaygroundEnabled } from "@/lib/playground/settings";
import { APP_VERSION } from "@/lib/version";
import { safeJsonScript } from "@/lib/rich";
import { siteUrl } from "@/lib/seo";

export const dynamic = "force-dynamic";

// 前台布局：导航 + 主内容 + 页脚（后台不走此布局）
export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  // pa1 实验场总开关：关闭时隐藏导航/页脚/底栏入口
  const [site, locale, currentUser, playgroundEnabled] = await Promise.all([
    getPublicSite(),
    getServerLocale(),
    getCurrentUser(),
    getPlaygroundEnabled(),
  ]);
  // P4 导航消息入口：登录用户查未读数（管理员发来的消息），未登录不显示
  const messageUnread = currentUser
    ? await db.userMessage.count({
        where: { userId: currentUser.id, direction: "admin_to_user", readAt: null },
      })
    : null;
  return (
    <div className="site-theme flex min-h-screen flex-col">
      <SiteHeader
        siteName={site.siteName}
        logoIcon={site.logoIcon || undefined}
        messageUnread={messageUnread}
        playgroundEnabled={playgroundEnabled}
      />
      {/* pb-24：为手机端底部 Tab 栏（52px + 安全区）预留空间，md 起 Tab 隐藏恢复常规 */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-8 md:pb-8">{children}</main>

      {/* 积分规则单页按要求不渲染站点页脚 */}
      <HideOnRoutes paths={["/credit-rules"]}>
      <footer className="site-footer border-t border-zinc-800/70 bg-zinc-950 pb-16 md:pb-0">
        <div className="mx-auto w-full max-w-6xl px-4">
          {/* 上部：品牌 + 导航 */}
          <div className="flex flex-col gap-8 py-10 md:flex-row md:items-start md:justify-between">
            <div className="max-w-sm">
              <div className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={site.logoIcon || "/logo/icon.png"}
                  alt={site.siteName}
                  className="h-8 w-8 rounded-lg object-cover"
                />
                <span className="text-base font-semibold tracking-wide text-zinc-100">
                  {site.siteName}
                </span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-zinc-400">
                {site.footerText}
              </p>
              <p className="mt-2 text-xs tracking-wider text-zinc-600">ICEBERG AI {APP_VERSION}</p>
            </div>

            <nav className="grid grid-cols-2 gap-x-10 gap-y-8 text-sm sm:grid-cols-3">
              {/* 产品目录 */}
              <div>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {t(locale, "footer.colDirectory")}
                </h3>
                <ul className="space-y-2">
                  <li>
                    <Link href="/#shenqi" className="text-zinc-400 transition hover:text-emerald-300">
                      {t(locale, "footer.lnkOptimizer")}
                    </Link>
                  </li>
                  <li>
                    <Link href="/categories" className="text-zinc-400 transition hover:text-emerald-300">
                      {t(locale, "footer.lnkPrompts")}
                    </Link>
                  </li>
                  <li>
                    <Link href="/skills" className="text-zinc-400 transition hover:text-emerald-300">
                      {t(locale, "footer.lnkSkills")}
                    </Link>
                  </li>
                  {playgroundEnabled && (
                    <li>
                      <Link href="/playground" className="text-zinc-400 transition hover:text-emerald-300">
                        {t(locale, "footer.lnkSoftware")}
                      </Link>
                    </li>
                  )}
                </ul>
              </div>

              {/* 支持 */}
              <div>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {t(locale, "footer.colSupport")}
                </h3>
                <ul className="space-y-2">
                  <li>
                    <Link href="/api-docs" className="text-zinc-400 transition hover:text-emerald-300">
                      {t(locale, "footer.lnkApiDocs")}
                    </Link>
                  </li>
                  <li>
                    <Link href="/help" className="text-zinc-400 transition hover:text-emerald-300">
                      {t(locale, "page.help.title")}
                    </Link>
                  </li>
                  <li>
                    <Link href="/about" className="text-zinc-400 transition hover:text-emerald-300">
                      {t(locale, "page.about.title")}
                    </Link>
                  </li>
                  <li>
                    <Link href="/contact" className="text-zinc-400 transition hover:text-emerald-300">
                      {t(locale, "page.contact.title")}
                    </Link>
                  </li>
                </ul>
              </div>

              {/* 法律 */}
              <div>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {t(locale, "footer.colLegal")}
                </h3>
                <ul className="space-y-2">
                  <li>
                    <Link href="/terms" className="text-zinc-400 transition hover:text-emerald-300">
                      {t(locale, "page.terms.title")}
                    </Link>
                  </li>
                  <li>
                    <Link href="/privacy" className="text-zinc-400 transition hover:text-emerald-300">
                      {t(locale, "page.privacy.title")}
                    </Link>
                  </li>
                </ul>
              </div>
            </nav>
          </div>

          {/* 友情链接（后台「网站设置 → 友情链接」配置，copyright 上方一排小字） */}
          {site.friendLinks.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 border-t border-zinc-800/70 py-3 text-xs text-zinc-500">
              <span className="text-zinc-600">友情链接：</span>
              {site.friendLinks.map((l) => (
                <a
                  key={l.url}
                  href={l.url}
                  target="_blank"
                  rel="noopener nofollow"
                  className="transition hover:text-emerald-300"
                >
                  {l.name}
                </a>
              ))}
            </div>
          )}

          {/* 下部：版权条（橙色点缀） */}
          <div className="flex flex-col items-center justify-between gap-2 border-t border-zinc-800/70 py-4 text-xs text-zinc-500 sm:flex-row">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-royal-500 shadow-[0_0_8px_rgba(45,212,232,0.9)]" />
              © {new Date().getFullYear()} {site.siteName}
            </span>
            <span>
              提示词数据来自公开社区，版权归原作者所有 · 如有需要联系站长{" "}
              <a
                href="https://t.me/QIUKUZI"
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-400 underline decoration-zinc-600 underline-offset-2 transition hover:text-royal-400 hover:decoration-royal-500"
              >
                Telegram
              </a>
            </span>
          </div>
        </div>
      </footer>
      </HideOnRoutes>

          <Script id="aizhantj" strategy="afterInteractive">
        {`var _mtj = _mtj || [];
(function () {
  var mtj = document.createElement("script");
  mtj.src = "https://node91.aizhantj.com:21233/tjjs/?k=lcwaty9lmo1";
  var s = document.getElementsByTagName("script")[0];
  s.parentNode.insertBefore(mtj, s);
})();`}
      </Script>

      {/* 结构化数据：Organization + WebSite（品牌实体 + 搜索框富摘要入口） */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonScript({
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "Organization",
                name: site.siteName,
                url: siteUrl(),
                logo: siteUrl(site.appIcon || "/icon-512.png"),
              },
              {
                "@type": "WebSite",
                name: site.siteName,
                url: siteUrl(),
                potentialAction: {
                  "@type": "SearchAction",
                  target: siteUrl("/search?q={search_term_string}"),
                  "query-input": "required name=search_term_string",
                },
              },
            ],
          }),
        }}
      />

      {/* 手机端底部标签栏（md 起自动隐藏） */}
      <MobileTabBar playgroundEnabled={playgroundEnabled} />
    </div>
  );
}
