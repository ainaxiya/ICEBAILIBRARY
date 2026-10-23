import Link from "next/link";
import { db } from "@/lib/db";
import { ADMIN_BASE } from "@/lib/admin-path";
import { getCategoryMeta } from "@/lib/category-meta";

export const dynamic = "force-dynamic";

export const metadata = { title: "管理后台 · 仪表盘" };

export default async function AdminHome() {
  const [
    promptTotal, promptPub, promptPend, promptRej, promptMedia, promptToday,
    skillTotal, skillPub, skillViews, skillCopies,
    softTotal, softPub, softViews, softDowns,
    userTotal, userToday, commentTotal, commentPend, pendingList,
  ] = await Promise.all([
    db.prompt.count(),
    db.prompt.count({ where: { status: "published" } }),
    db.prompt.count({ where: { status: "pending" } }),
    db.prompt.count({ where: { status: "rejected" } }),
    db.prompt.count({ where: { NOT: [{ media: { equals: [] } }] } }),
    db.prompt.count({ where: { createdAt: { gte: new Date(Date.now() - 86400_000) } } }),
    db.skill.count(),
    db.skill.count({ where: { status: "published" } }),
    db.skill.aggregate({ _sum: { viewCount: true } }).then((r) => r._sum.viewCount || 0),
    db.skill.aggregate({ _sum: { copyCount: true } }).then((r) => r._sum.copyCount || 0),
    db.software.count(),
    db.software.count({ where: { status: "published" } }),
    db.software.aggregate({ _sum: { viewCount: true } }).then((r) => r._sum.viewCount || 0),
    db.software.aggregate({ _sum: { downloadCount: true } }).then((r) => r._sum.downloadCount || 0),
    db.user.count({ where: { role: "user" } }),
    db.user.count({ where: { role: "user", createdAt: { gte: new Date(Date.now() - 86400_000) } } }),
    db.comment.count({ where: { status: { not: "deleted" } } }),
    db.comment.count({ where: { status: "pending" } }),
    db.prompt.findMany({
      where: { status: "pending" },
      orderBy: { id: "desc" },
      take: 8,
      include: {
        user: { select: { username: true, nickname: true } },
        adminAuthor: { select: { username: true, nickname: true } },
      },
    }),
  ]);

  const groups = [
    {
      title: "📝 提示词", href: `${ADMIN_BASE}/prompts`,
      cards: [
        { label: "总数", value: promptTotal, href: `${ADMIN_BASE}/prompts`, cls: "text-emerald-400" },
        { label: "已发布", value: promptPub, href: `${ADMIN_BASE}/prompts?status=published`, cls: "text-sky-400" },
        { label: "待审核", value: promptPend, href: `${ADMIN_BASE}/prompts?status=pending`, cls: "text-amber-400" },
        { label: "已驳回", value: promptRej, href: `${ADMIN_BASE}/prompts?status=rejected`, cls: "text-rose-400" },
        { label: "含媒体", value: promptMedia, href: `${ADMIN_BASE}/prompts`, cls: "text-cyan-400" },
        { label: "24h 新增", value: promptToday, href: `${ADMIN_BASE}/prompts`, cls: "text-fuchsia-400" },
      ],
    },
    {
      title: "🧩 技能", href: `${ADMIN_BASE}/skills`,
      cards: [
        { label: "总数", value: skillTotal, href: `${ADMIN_BASE}/skills`, cls: "text-emerald-400" },
        { label: "已发布", value: skillPub, href: `${ADMIN_BASE}/skills?status=published`, cls: "text-sky-400" },
        { label: "总查看", value: skillViews, href: `${ADMIN_BASE}/skills?sort=views`, cls: "text-violet-400" },
        { label: "总复制", value: skillCopies, href: `${ADMIN_BASE}/skills?sort=copies`, cls: "text-amber-400" },
      ],
    },
    {
      title: "💾 软件", href: `${ADMIN_BASE}/software`,
      cards: [
        { label: "总数", value: softTotal, href: `${ADMIN_BASE}/software`, cls: "text-emerald-400" },
        { label: "已发布", value: softPub, href: `${ADMIN_BASE}/software?status=published`, cls: "text-sky-400" },
        { label: "总查看", value: softViews, href: `${ADMIN_BASE}/software?sort=views`, cls: "text-violet-400" },
        { label: "总下载", value: softDowns, href: `${ADMIN_BASE}/software?sort=downloads`, cls: "text-amber-400" },
      ],
    },
    {
      title: "👥 会员 / 评论", href: `${ADMIN_BASE}/users`,
      cards: [
        { label: "注册会员", value: userTotal, href: `${ADMIN_BASE}/users`, cls: "text-violet-400" },
        { label: "24h 新注册", value: userToday, href: `${ADMIN_BASE}/users`, cls: "text-fuchsia-400" },
        { label: "评论总数", value: commentTotal, href: `${ADMIN_BASE}/comments`, cls: "text-cyan-400" },
        { label: "待审评论", value: commentPend, href: `${ADMIN_BASE}/comments?status=pending`, cls: "text-amber-400" },
      ],
    },
  ];

  return (
    <div>
      <h1 className="mb-5 text-xl font-bold">仪表盘</h1>

      <div className="space-y-5">
        {groups.map((g) => (
          <section key={g.title}>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium text-zinc-300">{g.title}</h2>
              <Link href={g.href} className="text-xs text-zinc-500 transition hover:text-emerald-300">管理 →</Link>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {g.cards.map((c) => (
                <Link
                  key={c.label}
                  href={c.href}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition hover:border-emerald-700/50"
                >
                  <div className={`text-2xl font-bold ${c.cls}`}>{c.value}</div>
                  <div className="mt-1 text-xs text-zinc-500">{c.label}</div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-300">
          待审核提示词 {promptPend > 0 && <span className="ml-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-300">{promptPend}</span>}
        </h2>
        {pendingList.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-600">暂无待审核内容</p>
        ) : (
          <div className="divide-y divide-zinc-800/70">
            {pendingList.map((p) => (
              <div key={p.id} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{getCategoryMeta(p.category).name.zh}</span>
                <Link href={`/p/${p.id}`} target="_blank" className="flex-1 truncate text-zinc-200 hover:text-emerald-300">
                  {p.title}
                </Link>
                <span className={`text-xs ${p.adminAuthor ? "text-indigo-300" : "text-zinc-500"}`}>
                  {p.adminAuthor
                    ? `${p.adminAuthor.nickname || p.adminAuthor.username}（管理员）`
                    : p.user.nickname || p.user.username}
                </span>
                <Link href={`${ADMIN_BASE}/prompts?status=pending`} className="text-xs text-amber-400 hover:underline">
                  去审核
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
