import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { ensureCreditPacks, getBalance } from "@/lib/credits";
import { getEnabledChannels } from "@/lib/payments/config";
import MemberCenter, { type Post, type RechargePack } from "@/components/member/MemberCenter";
import type { OverviewData } from "@/components/member/MemberOverview";

export const dynamic = "force-dynamic";

// v0.95：/member 服务端聚合概览数据（统计卡 / 最近资产 / 网站通知）+ 充值中心面板的积分包/支付通道，
// 页面主体（Hero 含账户信息 / 统计卡 / 网站通知 / 最近资产 / 快捷入口）由 MemberOverview 渲染。
export default async function MemberPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { tab: initialTab } = await searchParams;

  const [
    postCount,
    favCount,
    userFavCount,
    assetCount,
    apiCalls,
    spentAgg,
    recentAssets,
    pwdRow,
    postRows,
    notices,
  ] = await Promise.all([
    db.prompt.count({ where: { userId: user.id } }),
    db.favorite.count({ where: { userId: user.id } }),
    db.userFavorite.count({ where: { userId: user.id } }),
    db.generatedAsset.count({ where: { userId: user.id, status: "temp" } }),
    db.usageRecord.count({ where: { userId: user.id } }),
    db.usageRecord.aggregate({ where: { userId: user.id }, _sum: { paidCredits: true } }),
    db.generatedAsset.findMany({
      where: { userId: user.id, status: "temp" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, assetType: true, storageKey: true, sizeBytes: true, createdAt: true },
    }),
    db.user.findUnique({ where: { id: user.id }, select: { passwordHash: true, emailVerified: true } }),
    db.prompt.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    // 网站通知 = 工单模块的通知消息（管理员单发/群发，msgType=notice）
    db.userMessage.findMany({
      where: { userId: user.id, replyToId: null, msgType: "notice" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, subject: true, body: true, createdAt: true, direction: true, readAt: true },
    }),
  ]);

  // 余额（Hero 积分余额）
  const balance = Number(await getBalance(user.id));

  // 充值中心面板：积分包 + 启用中的支付通道（与 /recharge 同源）
  await ensureCreditPacks();
  const [packs, payChannels] = await Promise.all([
    db.creditPack.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
    getEnabledChannels(),
  ]);

  const overview: OverviewData = {
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      avatar: user.avatar,
      bio: user.bio,
      membershipLevel: user.membershipLevel ?? "free",
      membershipUntil: user.membershipUntil ? user.membershipUntil.toISOString() : null,
      email: user.email,
      emailVerified: !!pwdRow?.emailVerified,
      phone: user.phone,
      hasPassword: !!pwdRow?.passwordHash,
    },
    balance,
    // b4：钱包三指标同屏 —— 当前积分 / 累计消耗 / 累计请求
    wallet: {
      spentCredits: Number(spentAgg._sum.paidCredits ?? 0),
      requests: apiCalls,
    },
    stats: {
      favCount: favCount + userFavCount,
      assetCount,
      postCount,
      apiCalls,
    },
    recentAssets: recentAssets.map((a) => ({
      id: String(a.id),
      assetType: a.assetType,
      name: a.storageKey.split("/").pop() || a.storageKey,
      sizeBytes: Number(a.sizeBytes),
      createdAt: a.createdAt.toISOString(),
    })),
    notices: notices.map((n) => ({
      id: String(n.id),
      subject: n.subject,
      body: n.body,
      createdAt: n.createdAt.toISOString(),
      unread: n.direction === "admin_to_user" && !n.readAt,
    })),
  };

  const posts: Post[] = postRows.map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    viewCount: p.viewCount,
    commentCount: p.commentCount,
    createdAt: p.createdAt.toISOString(),
    category: p.category,
    categoryName: p.category,
    rejectReason: p.rejectReason,
  }));

  const rechargePacks: RechargePack[] = packs.map((p) => ({
    packCode: p.packCode,
    priceCents: Number(p.priceCents),
    credits: Number(p.credits),
    bonusCredits: Number(p.bonusCredits),
  }));

  return (
    <main className="mc-page min-h-screen">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <MemberCenter
          overview={overview}
          posts={posts}
          rechargePacks={rechargePacks}
          payChannels={payChannels}
          initialTab={initialTab}
        />
      </div>
    </main>
  );
}
