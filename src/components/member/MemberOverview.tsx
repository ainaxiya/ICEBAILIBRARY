"use client";

import Link from "next/link";
import { stripHtml } from "@/lib/rich";

// ─── v0.95 会员中心概览首页（Hero 含账户信息 / 统计卡 / 网站通知 / 最近资产 / 快捷入口） ───
// v0.95 变更：UID→账号、免费用户→普通会员、去续费升级按钮、账户信息并入 Hero、
// 会员权益卡→网站通知（工单通知）、使用额度卡→最近资产、删除底部三栏。

export type OverviewData = {
  user: {
    id: number;
    username: string;
    nickname: string | null;
    avatar: string | null;
    bio: string | null;
    membershipLevel: string; // free | pro | vip
    membershipUntil: string | null;
    email: string | null;
    phone: string | null;
    hasPassword: boolean;
  };
  balance: number;
  stats: { favCount: number; assetCount: number; postCount: number; apiCalls: number };
  recentAssets: { id: string; assetType: string; name: string; sizeBytes: number; createdAt: string }[];
  notices: { id: string; subject: string | null; body: string; createdAt: string; unread: boolean }[];
};

// v0.96：目前只有普通会员一种等级，不再区分 Pro/VIP

const ASSET_ICON: Record<string, string> = {
  image: "🖼️",
  video: "🎬",
  audio: "🎵",
  file: "📄",
};

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDay(d: string) {
  return d.slice(0, 10);
}



function StatCard({ num, label, icon }: { num: number | string; label: string; icon: string }) {
  return (
    <div className="mc-card mc-card-hover flex items-center gap-3 px-4 py-3.5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/15 text-lg">{icon}</span>
      <div className="min-w-0">
        <div className="mc-stat-num truncate">{num}</div>
        <div className="mc-stat-label">{label}</div>
      </div>
    </div>
  );
}

export default function MemberOverview({
  data,
  onOpenPanel,
}: {
  data: OverviewData;
  onOpenPanel: (tab: string) => void;
}) {
  const { user, balance, stats, recentAssets, notices } = data;

  const boundCount = [user.email, user.phone, user.hasPassword].filter(Boolean).length;
  const securityLevel = boundCount >= 3 ? "高" : boundCount === 2 ? "中" : "低";

  const quickLinks = [
    { href: "/categories", icon: "📚", label: "提示词库" },
    { href: "/skills", icon: "🧩", label: "技能库" },
    { href: "/software", icon: "💾", label: "软件下载" },
    { href: "/api-docs", icon: "📖", label: "API 文档" },
    { href: "/recharge", icon: "⚡", label: "充值中心" },
  ];

  return (
    <div className="space-y-5">
      {/* ── Hero 会员信息横幅（含账户信息） ── */}
      <div className="mc-hero relative overflow-hidden p-5 sm:p-7">
        {/* v0.96：右上角皇冠装饰改为「修改资料」按钮 */}
        <button
          type="button"
          onClick={() => onOpenPanel("profile")}
          className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-full border border-white/25 bg-white/12 px-3 py-1.5 text-xs font-medium text-blue-100 backdrop-blur-sm transition hover:bg-white/22 hover:text-white sm:right-5 sm:top-4 sm:px-4 sm:py-2 sm:text-sm"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 sm:h-4 sm:w-4">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
          修改资料
        </button>
        <div className="flex items-center gap-4 pr-24 sm:pr-36">
          {user.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.avatar} alt="" className="h-16 w-16 rounded-full border-2 border-blue-300/40 object-cover sm:h-20 sm:w-20" />
          ) : (
            <span className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-blue-300/40 bg-blue-500/25 text-3xl sm:h-20 sm:w-20">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-9 w-9 text-blue-200">
                <circle cx="12" cy="8" r="3.5" />
                <path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5" />
              </svg>
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="max-w-full shrink-0 truncate text-lg font-bold text-white sm:text-xl">{user.nickname || user.username}</h2>
              <span className="mc-badge mc-badge-ghost shrink-0 whitespace-nowrap">普通会员</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-blue-200/70">
              <span className="whitespace-nowrap">账号：{user.username}</span>
              <span className="whitespace-nowrap">积分余额：<b className="text-amber-300">{balance.toLocaleString()}</b></span>
            </div>
          </div>
        </div>

        {/* 账户信息（v0.95 并入 Hero） */}
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-white/10 pt-4 sm:grid-cols-4">
          <div className="min-w-0">
            <div className="text-[11px] text-blue-200/60">邮箱</div>
            <div className="mt-0.5 truncate text-xs text-slate-200">
              {user.email || <span className="text-slate-500">未绑定</span>}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-[11px] text-blue-200/60">手机</div>
            <div className="mt-0.5 truncate text-xs text-slate-200">
              {user.phone || <span className="text-slate-500">未绑定</span>}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-[11px] text-blue-200/60">登录方式</div>
            <div className="mt-0.5 truncate text-xs text-slate-200">{user.hasPassword ? "账号密码" : "快捷登录"}</div>
          </div>
          <div className="min-w-0">
            <div className="text-[11px] text-blue-200/60">安全等级</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-xs font-semibold text-emerald-400">{securityLevel}</span>
              <div className="mc-progress h-1 max-w-24 flex-1">
                <i className="mc-bar-green" style={{ width: `${(boundCount / 3) * 100}%` }} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── 4 统计卡 ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard num={stats.favCount} label="我的收藏" icon="❤️" />
        <StatCard num={stats.assetCount} label="我的资产（生成）" icon="🗂️" />
        <StatCard num={stats.postCount} label="我的发布" icon="📝" />
        <StatCard num={stats.apiCalls} label="API 调用次数" icon="🔗" />
      </div>

      {/* ── 两栏：网站通知 / 最近资产 ── */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* 网站通知（工单·通知） */}
        <div className="mc-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="mc-section-title">网站通知</h3>
            <button onClick={() => onOpenPanel("messages")} className="text-xs text-blue-400 hover:underline">
              全部通知 ›
            </button>
          </div>
          {notices.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-500">暂无通知</p>
          ) : (
            <ul className="space-y-3.5">
              {notices.map((n) => (
                <li
                  key={n.id}
                  onClick={() => onOpenPanel("messages")}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg p-1 -m-1 transition hover:bg-white/5"
                >
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${n.unread ? "bg-emerald-400" : "bg-slate-600"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-xs font-medium text-slate-200">{n.subject || "网站通知"}</span>
                      <span className="shrink-0 text-[11px] text-slate-500">{fmtDay(n.createdAt)}</span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-slate-400">{stripHtml(n.body)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 最近资产 */}
        <div className="mc-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="mc-section-title">最近资产</h3>
            <button onClick={() => onOpenPanel("assets")} className="text-xs text-blue-400 hover:underline">
              查看全部 ›
            </button>
          </div>
          {recentAssets.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-500">暂无生成资产，去 API 文档开始创作</p>
          ) : (
            <ul className="space-y-2.5">
              {recentAssets.map((a) => (
                <li key={a.id} className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/12 text-base">
                    {ASSET_ICON[a.assetType] || "📄"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-slate-200">{a.name}</div>
                    <div className="text-[11px] text-slate-500">{fmtDay(a.createdAt)} · {fmtSize(a.sizeBytes)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ── 快捷入口 ── */}
      <div className="grid grid-cols-5 gap-2.5 sm:gap-3">
        {quickLinks.map((q) => (
          <Link
            key={q.href}
            href={q.href}
            className="mc-card mc-card-hover flex flex-col items-center gap-1.5 px-2 py-3.5 text-center"
          >
            <span className="text-2xl">{q.icon}</span>
            <span className="text-[11px] font-medium text-slate-300 sm:text-xs">{q.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
