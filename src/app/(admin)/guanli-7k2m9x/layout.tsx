import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { ADMIN_BASE } from "@/lib/admin-path";
import { getAdminPermissions, PERMISSIONS } from "@/lib/rbac";
import { getPublicSite } from "@/lib/settings";
import { APP_VERSION } from "@/lib/version";
import LogoutButton from "@/components/LogoutButton";
import AdminNav from "@/components/admin/AdminNav";

export const dynamic = "force-dynamic";

export const metadata = { title: "管理后台" };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  if (!admin) {
    redirect(`${ADMIN_BASE}/login?next=${encodeURIComponent(ADMIN_BASE)}`);
  }
  // 站名/LOGO 走网站设置，与前台一致（后台上传自定义 LOGO 后自动替换）
  const site = await getPublicSite();

  // 仅采集管理按细粒度权限显隐（其余栏目沿用历史行为，页面/API 内部各自鉴权）
  const perms = admin.isSuper ? null : await getAdminPermissions(admin.id);
  const nav: { href: string; label: string; icon: string; superOnly?: boolean; perm?: string }[] = [
    { href: ADMIN_BASE, label: "仪表盘", icon: "📊" },
    { href: `${ADMIN_BASE}/settings/site`, label: "网站设置", icon: "🌐" },
    { href: `${ADMIN_BASE}/settings/pages`, label: "单页内容管理", icon: "📄" },
    { href: `${ADMIN_BASE}/settings/pay-channels`, label: "支付接口管理", icon: "💳" },
    { href: `${ADMIN_BASE}/settings/credit-packs`, label: "积分包管理", icon: "🎁" },
    { href: `${ADMIN_BASE}/optimizer-logs`, label: "优化器使用记录", icon: "📈", perm: PERMISSIONS.OPTIMIZER_LOG_READ },
    { href: `${ADMIN_BASE}/prompts`, label: "提示词管理", icon: "📝" },
    { href: `${ADMIN_BASE}/skills`, label: "技能管理", icon: "🧩", perm: PERMISSIONS.SKILL_MANAGE },
    { href: `${ADMIN_BASE}/software`, label: "软件管理", icon: "💾", perm: PERMISSIONS.SOFTWARE_MANAGE },
    { href: `${ADMIN_BASE}/categories`, label: "提示词分类", icon: "🗂️" },
    { href: `${ADMIN_BASE}/tags`, label: "Tag标签管理", icon: "🏷️" },
    { href: `${ADMIN_BASE}/meiliadmin`, label: "搜索管理", icon: "🔍" },
    { href: `${ADMIN_BASE}/collect`, label: "采集管理", icon: "📡", perm: PERMISSIONS.CRAWL_MANAGE },
    { href: `${ADMIN_BASE}/storage`, label: "存储桶管理", icon: "🪣", perm: PERMISSIONS.STORAGE_MANAGE },
    { href: `${ADMIN_BASE}/models`, label: "模型库管理", icon: "🤖", perm: PERMISSIONS.MODELS_READ },
    { href: `${ADMIN_BASE}/models/api-docs`, label: "API 文档", icon: "📘", perm: PERMISSIONS.MODELS_READ },
    { href: `${ADMIN_BASE}/reports/usage`, label: "消费报表", icon: "💹", perm: PERMISSIONS.REPORT_READ },
    { href: `${ADMIN_BASE}/pay/orders`, label: "订单管理", icon: "🧾" },
    { href: `${ADMIN_BASE}/pay/ledger`, label: "积分流水", icon: "📒" },
    { href: `${ADMIN_BASE}/pay/usage-records`, label: "使用记录管理", icon: "📝" },
    { href: `${ADMIN_BASE}/alerts`, label: "运营告警", icon: "🚨", perm: PERMISSIONS.REPORT_READ },
    { href: `${ADMIN_BASE}/settings/publish`, label: "发布设置", icon: "📤" },
    { href: `${ADMIN_BASE}/users`, label: "用户管理", icon: "👥" },
    { href: `${ADMIN_BASE}/settings/membership`, label: "注册设置", icon: "🧾" },
    { href: `${ADMIN_BASE}/comments`, label: "评论管理", icon: "💬" },
    { href: `${ADMIN_BASE}/messages`, label: "消息工单", icon: "✉️" },
    { href: `${ADMIN_BASE}/admins`, label: "管理员设置", icon: "🛡️", superOnly: true },
    { href: `${ADMIN_BASE}/roles`, label: "权限角色", icon: "🔑" },
    { href: `${ADMIN_BASE}/logs`, label: "后台操作日志", icon: "📋" },
  ].filter((n) => (!n.superOnly || admin.isSuper) && (!n.perm || !perms || perms.has(n.perm)));

  return (
    <div
      className="grid min-h-screen grid-cols-1 lg:grid-cols-[210px_1fr]"
      style={{
        backgroundImage:
          "radial-gradient(1000px 600px at 110% -10%, rgba(47,146,232,0.12), transparent 60%), radial-gradient(800px 600px at -20% 110%, rgba(69,182,245,0.08), transparent 60%)",
      }}
    >
      <aside className="border-b border-zinc-800/80 bg-[#0b0f29]/85 px-3 py-5 backdrop-blur lg:min-h-screen lg:border-b-0 lg:border-r">
        <div className="mb-5 flex items-center gap-2 px-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={site.logoIcon || "/logo/icon.png"}
            alt={site.siteName}
            className="h-7 w-7 rounded-md object-cover"
          />
          <span className="text-base font-bold tracking-wide text-gold-gradient">{site.siteName}</span>
        </div>
        {/* 分组折叠菜单（默认展开当前页所在分组） */}
        <AdminNav items={nav.map(({ href, label, icon }) => ({ href, label, icon }))} />
        <div className="mt-6 hidden border-t border-zinc-800/80 pt-4 text-xs text-zinc-500 lg:block">
          <a
            href="/"
            target="_blank"
            rel="noopener"
            className="inline-block rounded border border-emerald-700/60 px-2 py-1 text-[10px] tracking-widest text-emerald-400 transition hover:bg-emerald-900/40 hover:text-emerald-300"
          >
            前台查看
          </a>
          <p className="mt-3 px-2 leading-relaxed">
            管理员：{admin.nickname || admin.username}
            {admin.isSuper && (
              <span className="ml-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400">
                超管
              </span>
            )}
          </p>
          <div className="mt-3 px-2">
            <LogoutButton admin />
          </div>
          <div className="mt-4 flex items-center gap-2 px-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={site.logoIcon || "/logo/icon.png"}
              alt={site.siteName}
              className="h-5 w-5 rounded object-cover opacity-80"
            />
            <span className="text-[10px] tracking-widest text-zinc-600">{APP_VERSION}</span>
          </div>
        </div>
      </aside>
      <div className="min-w-0 p-4 lg:p-7">{children}</div>
    </div>
  );
}
