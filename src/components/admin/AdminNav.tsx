"use client";

// ─── 后台侧边栏菜单：分类分组 + 折叠 ───
// 仪表盘固定置顶；其余按分组折叠，默认只展开当前页面所在分组，点击分组标题展开/收起。
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ADMIN_BASE } from "@/lib/admin-path";

type NavItem = { href: string; label: string; icon: string };

// 分组定义（hrefs 里未被服务端权限过滤掉的项才会显示）
const GROUPS: { key: string; label: string; icon: string; hrefs: string[] }[] = [
  {
    key: "content",
    label: "内容管理",
    icon: "🗂️",
    hrefs: [
      `${ADMIN_BASE}/prompts`,
      `${ADMIN_BASE}/categories`,
      `${ADMIN_BASE}/tags`,
      `${ADMIN_BASE}/skills`,
      `${ADMIN_BASE}/software`,
      `${ADMIN_BASE}/comments`,
    ],
  },
  {
    key: "member",
    label: "会员管理",
    icon: "👥",
    hrefs: [`${ADMIN_BASE}/users`, `${ADMIN_BASE}/settings/membership`, `${ADMIN_BASE}/messages`],
  },
  {
    key: "pay",
    label: "支付与交易",
    icon: "💳",
    hrefs: [
      `${ADMIN_BASE}/settings/pay-channels`,
      `${ADMIN_BASE}/settings/credit-packs`,
      `${ADMIN_BASE}/reports/usage`,
      `${ADMIN_BASE}/pay/orders`,
      `${ADMIN_BASE}/pay/ledger`,
      `${ADMIN_BASE}/pay/usage-records`,
      `${ADMIN_BASE}/alerts`,
    ],
  },
  {
    key: "model",
    label: "模型与网关",
    icon: "🤖",
    hrefs: [`${ADMIN_BASE}/models`, `${ADMIN_BASE}/models/api-docs`, `${ADMIN_BASE}/optimizer-logs`],
  },
  {
    key: "site",
    label: "站点管理",
    icon: "🌐",
    hrefs: [
      `${ADMIN_BASE}/settings/site`,
      `${ADMIN_BASE}/settings/pages`,
      `${ADMIN_BASE}/settings/publish`,
      `${ADMIN_BASE}/meiliadmin`,
    ],
  },
  {
    key: "ops",
    label: "采集与存储",
    icon: "📡",
    hrefs: [`${ADMIN_BASE}/collect`, `${ADMIN_BASE}/storage`],
  },
  {
    key: "system",
    label: "系统管理",
    icon: "🛡️",
    hrefs: [`${ADMIN_BASE}/admins`, `${ADMIN_BASE}/roles`, `${ADMIN_BASE}/logs`],
  },
];

const linkCls =
  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition hover:bg-emerald-800/60 hover:text-white";
const subLinkCls =
  "flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] transition hover:bg-emerald-800/60 hover:text-white";

export default function AdminNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  // 仪表盘置顶，其余按分组归类；不在任何分组定义里的进「其他」
  const { dashboard, groups, others } = useMemo(() => {
    const dashboard = items.filter((i) => i.href === ADMIN_BASE);
    const rest = items.filter((i) => i.href !== ADMIN_BASE);
    const used = new Set<string>();
    const groups = GROUPS.map((g) => {
      const list = g.hrefs
        .map((h) => rest.find((i) => i.href === h))
        .filter((x): x is NavItem => Boolean(x));
      list.forEach((i) => used.add(i.href));
      return { ...g, list };
    }).filter((g) => g.list.length > 0);
    const others = rest.filter((i) => !used.has(i.href));
    return { dashboard, groups, others };
  }, [items]);

  // 当前页面命中的分组（用于默认展开 + 高亮）
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const activeKeys = useMemo(
    () => new Set(groups.filter((g) => g.list.some((i) => isActive(i.href))).map((g) => g.key)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, pathname]
  );

  const [open, setOpen] = useState<Set<string>>(() => new Set(activeKeys));
  // 路由变化后自动展开新页面所在分组（不收起用户手动展开的）
  useEffect(() => {
    setOpen((prev) => {
      const next = new Set(prev);
      activeKeys.forEach((k) => next.add(k));
      return next;
    });
  }, [activeKeys]);

  const toggle = (key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <nav className="flex flex-col gap-1 overflow-y-auto">
      {dashboard.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          className={`${linkCls} ${isActive(n.href) ? "bg-emerald-800/50 text-white" : "text-zinc-300"}`}
        >
          <span>{n.icon}</span>
          {n.label}
        </Link>
      ))}

      {groups.map((g) => {
        const expanded = open.has(g.key);
        return (
          <div key={g.key}>
            <button
              type="button"
              onClick={() => toggle(g.key)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-400 transition hover:bg-zinc-800/60 hover:text-zinc-200"
            >
              <span>{g.icon}</span>
              <span className="flex-1 text-left">{g.label}</span>
              <span
                className={`text-[9px] text-zinc-600 transition-transform ${expanded ? "rotate-90" : ""}`}
              >
                ▶
              </span>
            </button>
            {expanded && (
              <div className="ml-3 flex flex-col gap-0.5 border-l border-zinc-800 pl-2">
                {g.list.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={`${subLinkCls} ${isActive(n.href) ? "bg-emerald-800/50 text-white" : "text-zinc-400"}`}
                  >
                    <span>{n.icon}</span>
                    {n.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {others.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          className={`${linkCls} ${isActive(n.href) ? "bg-emerald-800/50 text-white" : "text-zinc-300"}`}
        >
          <span>{n.icon}</span>
          {n.label}
        </Link>
      ))}
    </nav>
  );
}
