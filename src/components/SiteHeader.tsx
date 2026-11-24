"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useLocale, translate as t } from "@/lib/i18n-client";
import { isNavActive } from "@/lib/nav-active";
import {
  SEARCH_BAR_BUTTON_CLASS,
  SEARCH_BAR_BUTTON_ICON_CLASS,
  SEARCH_BAR_FORM_CLASS,
  SEARCH_BAR_ICON_CLASS,
  SEARCH_BAR_INPUT_CLASS,
} from "@/lib/search-bar-style";
import LanguageSwitcher from "./LanguageSwitcher";
import UserMenu from "./UserMenu";

function Icon({ name, className = "h-4 w-4" }: { name: string; className?: string }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
  };
  switch (name) {
    case "home":
      return (
        <svg {...common}>
          <path d="M3 11l9-7 9 7" />
          <path d="M5 10v10h14V10" />
          <path d="M9 20v-6h6v6" />
        </svg>
      );
    case "flame":
      return (
        <svg {...common}>
          <path d="M12 3s4.5 4 4.5 8.5A4.5 4.5 0 0 1 12 16a4.5 4.5 0 0 1-4.5-4.5C7.5 11 9 9.5 9.5 8.5 10.5 10 12 9.5 12 3z" />
          <path d="M9.5 16.5c0 2 1.1 3.5 2.5 3.5s2.5-1.5 2.5-3.5c0-1.3-.8-2.2-1.5-3-.3.8-1 1-1.5.5-.5.8-2 1.2-2 2.5z" />
        </svg>
      );
    case "grid":
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
        </svg>
      );
    case "puzzle":
      return (
        <svg {...common}>
          <path d="M14 3v3a2 2 0 1 0 4 0h3v5h-3a2 2 0 1 0 0 4h3v5h-6v-3a2 2 0 1 0-4 0v3H5v-6H2v-5h3V3h9z" />
        </svg>
      );
    case "disk":
      return (
        <svg {...common}>
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M8 3v5h8V3" />
          <circle cx="12" cy="15" r="2.5" />
        </svg>
      );
    case "flask":
      return (
        <svg {...common}>
          <path d="M10 3h4M10 3v6l-5.5 9.2A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.8L14 9V3" />
          <path d="M7.5 15h9" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
      );
    case "bell":
      return (
        <svg {...common}>
          <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6z" />
          <path d="M10 19a2 2 0 0 0 4 0" />
        </svg>
      );
    default:
      return null;
  }
}

export default function SiteHeader({
  siteName,
  logoIcon = "/logo/icon.png",
  messageUnread = null,
  playgroundEnabled = true,
}: {
  siteName: string;
  logoIcon?: string;
  // P4 消息入口：null = 未登录（不显示）；数字 = 未读消息数
  messageUnread?: number | null;
  // pa1 实验场总开关：关闭时隐藏导航入口
  playgroundEnabled?: boolean;
}) {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [mobileSearch, setMobileSearch] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // 搜索页 hero 自带大搜索框，header 搜索框在此页隐藏避免重复
  const onSearchPage = pathname.startsWith("/search");

  useEffect(() => {
    if (mobileSearch) inputRef.current?.focus();
  }, [mobileSearch]);

  // 路由变化时收起移动端搜索
  useEffect(() => {
    setMobileSearch(false);
  }, [pathname]);

  // 同步 <html lang>
  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  const navItem = (href: string, icon: string, label: string, exact = false) => {
    const active = isNavActive(pathname, href, exact);
    return (
      <Link
        href={href}
        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm transition ${
          active ? "bg-zinc-800 font-medium text-emerald-300" : "text-zinc-300 hover:bg-zinc-800 hover:text-white"
        }`}
      >
        <Icon name={icon} />
        <span className="hidden md:inline">{label}</span>
      </Link>
    );
  };

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const kw = q.trim();
    if (!kw) return;
    router.push(`/search?q=${encodeURIComponent(kw)}`);
  };

  const searchBox = (big: boolean) => (
    <form onSubmit={submitSearch} role="search" className={SEARCH_BAR_FORM_CLASS}>
      <Icon name="search" className={SEARCH_BAR_ICON_CLASS} />
      <input
        ref={big ? undefined : inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t(locale, "search.placeholder")}
        aria-label={t(locale, "search.button")}
        className={SEARCH_BAR_INPUT_CLASS}
      />
      <button type="submit" className={SEARCH_BAR_BUTTON_CLASS}>
        {t(locale, "search.button")}
        <svg viewBox="0 0 24 24" className={SEARCH_BAR_BUTTON_ICON_CLASS} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
    </form>
  );

  return (
    <header className="site-header sticky top-0 z-50 border-b border-zinc-800/70 bg-zinc-950/95 backdrop-blur-md">
      {/* 第一行：导航栏 */}
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-3 sm:gap-3 sm:px-4">
        <Link href="/" className="mr-1 flex shrink-0 items-center gap-2" aria-label={siteName}>
          {/* 灯泡品牌图标（后台可在网站设置中替换） */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoIcon} alt={siteName} className="h-8 w-8 rounded-lg object-cover" />
          {/* 站点名：手机端也显示（短名），小屏适当缩小字号防挤压 */}
          <span className="text-sm font-semibold tracking-wide text-zinc-100 sm:text-base">
            {siteName}
          </span>
        </Link>

        {/* 手机端导航由底部 MobileTabBar 承接，<md 整块隐藏 */}
        {/* v0.117 四大栏目：首页 / 提示词 / AI技能 / 实验场（AI软件已下线，发布入口已收回会员中心） */}
        <nav className="hidden items-center gap-1 md:flex">
          {navItem("/", "home", t(locale, "nav.home"), true)}
          {navItem("/categories", "grid", t(locale, "nav.categories"))}
          {navItem("/skills", "puzzle", t(locale, "nav.skills"))}
          {playgroundEnabled && navItem("/playground", "flask", t(locale, "nav.software"))}
        </nav>

        <div className="ml-auto flex items-center gap-1">
          {/* P4 消息入口：登录才显示，带未读数角标 */}
          {messageUnread !== null && (
            <Link
              href="/member?tab=messages"
              title={t(locale, "nav.messages")}
              aria-label={t(locale, "nav.messages")}
              className="relative rounded-lg p-2 text-zinc-300 hover:bg-zinc-800 hover:text-white"
            >
              <Icon name="bell" className="h-5 w-5" />
              {messageUnread > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-xs font-semibold leading-none text-white">
                  {messageUnread > 99 ? "99+" : messageUnread}
                </span>
              )}
            </Link>
          )}
          {/* 移动端搜索切换（搜索页隐藏，hero 已有搜索框） */}
          {!onSearchPage && (
            <button
              type="button"
              onClick={() => setMobileSearch((v) => !v)}
              aria-label={t(locale, "search.button")}
              className="rounded-lg p-2 text-zinc-300 hover:bg-zinc-800 hover:text-white sm:hidden"
            >
              <Icon name="search" className="h-5 w-5" />
            </button>
          )}
          <UserMenu />
          <Suspense fallback={null}>
            <LanguageSwitcher />
          </Suspense>
        </div>
      </div>

      {/* 第二行：大搜索栏（桌面常驻；移动端展开式；搜索页隐藏避免与 hero 搜索框重复） */}
      {!onSearchPage && (
        <div className="hidden bg-zinc-950/60 px-4 py-3 sm:block">
          <div className="mx-auto max-w-6xl">{searchBox(true)}</div>
        </div>
      )}
      {mobileSearch && !onSearchPage && (
        <div className="bg-zinc-950/60 px-3 py-3 sm:hidden">{searchBox(false)}</div>
      )}
    </header>
  );
}
