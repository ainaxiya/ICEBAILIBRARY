import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { getBalance } from "@/lib/credits";
import LogoutButton from "@/components/LogoutButton";
import MemberCenter from "@/components/member/MemberCenter";
import { getServerLocale, translate as t } from "@/lib/i18n";
import { getCategoryMeta } from "@/lib/category-meta";

export const dynamic = "force-dynamic";

export const metadata = { title: "会员中心" };

// P4 用户中心：账号卡片 + 统计 + 会员中心分区
// （余额 / 充值记录 / 用量明细 / 我的资产 / 消息·工单 / 我的发布 + 发票说明条）
export default async function MemberPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const locale = await getServerLocale();
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/member");
  const sp = await searchParams;

  const [balance, grants, myPosts, postCount, viewAgg] = await Promise.all([
    getBalance(user.id),
    db.creditGrant.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    db.prompt.findMany({
      where: { userId: user.id },
      orderBy: { id: "desc" },
      take: 10,
      select: {
        id: true, title: true, status: true, viewCount: true, commentCount: true,
        createdAt: true, category: true, rejectReason: true,
      },
    }),
    db.prompt.count({ where: { userId: user.id } }),
    // 总浏览统计全部投稿（含第 10 条之后），不依赖列表截断
    db.prompt.aggregate({ where: { userId: user.id }, _sum: { viewCount: true } }),
  ]);

  const stat = (label: string, value: number | string) => (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-center sm:p-4">
      <div className="truncate text-lg font-bold text-emerald-400 sm:text-xl">{value}</div>
      <div className="mt-1 text-[11px] text-zinc-500 sm:text-xs">{label}</div>
    </div>
  );

  return (
    <div className="max-w-4xl">
      {/* 账号卡片 */}
      <div className="mb-6 flex flex-wrap items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500/30 to-royal-500/25 text-3xl text-emerald-300">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
            strokeLinecap="round" strokeLinejoin="round" className="h-9 w-9">
            <circle cx="12" cy="8" r="3.5" />
            <path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-bold text-zinc-50">{user.username}</h1>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {t(locale, "member.memberSince")}：{user.createdAt.toISOString().slice(0, 10)}
          </p>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Link href="/publish"
            className="flex-1 rounded-lg bg-emerald-500 px-4 py-2 text-center text-sm font-medium text-zinc-950 hover:bg-emerald-400 sm:flex-none">
            + {t(locale, "nav.publish")}
          </Link>
          <span className="flex-1 [&>button]:w-full sm:flex-none"><LogoutButton /></span>
        </div>
      </div>

      {/* 统计 */}
      <div className="mb-8 grid grid-cols-2 gap-3">
        {stat(t(locale, "member.myPosts"), postCount)}
        {stat(locale === "zh" ? "总浏览" : "Total views", viewAgg._sum.viewCount ?? 0)}
      </div>

      {/* 会员中心分区（余额 / 充值记录 / 用量明细 / 我的资产 / 消息·工单 / 我的发布） */}
      <MemberCenter
        balance={Number(balance)}
        grants={grants.map((g) => ({
          id: g.id,
          grantType: g.grantType,
          total: Number(g.totalCredits),
          remaining: Number(g.remainingCredits),
          expiresAt: g.expiresAt?.toISOString() ?? null,
        }))}
        posts={myPosts.map((p) => ({
          id: p.id,
          title: p.title,
          status: p.status,
          viewCount: p.viewCount,
          commentCount: p.commentCount,
          createdAt: p.createdAt.toISOString(),
          category: p.category,
          categoryName: getCategoryMeta(p.category).name[locale],
          rejectReason: p.rejectReason,
        }))}
        initialTab={sp.tab}
      />
    </div>
  );
}
