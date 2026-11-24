"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { stripHtml } from "@/lib/rich";
import { assetTypeIcon } from "@/lib/asset-types";
import LogoutButton from "@/components/LogoutButton";

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
    emailVerified: boolean;
    phone: string | null;
    hasPassword: boolean;
  };
  balance: number;
  wallet: { spentCredits: number; requests: number };
  stats: { favCount: number; assetCount: number; postCount: number; apiCalls: number };
  recentAssets: { id: string; assetType: string; name: string; sizeBytes: number; createdAt: string }[];
  notices: { id: string; subject: string | null; body: string; createdAt: string; unread: boolean }[];
};

// v0.96：目前只有普通会员一种等级，不再区分 Pro/VIP

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDay(d: string) {
  return d.slice(0, 10);
}

// b10：常见问题（首页引导卡，静态文案）
const FAQ_ITEMS = [
  { q: "如何创建 API Key？", a: "会员中心 → API Key → 新建。明文只在创建时显示一次，之后只保留前缀。" },
  { q: "接入地址是什么？", a: "OpenAI 兼容协议，Base URL 用上方地址；模型名与参数见接口文档。" },
  { q: "积分怎么计算和退回？", a: "按模型定价（按次 / 千字符 / 音频秒）扣减；任务失败自动全额退回。" },
  { q: "请求返回 429 怎么办？", a: "触发限流或并发上限，稍后重试即可；持续出现可在工单里反馈。" },
];

const GUIDE_STEPS: { title: string; desc: string; action: string; panel?: string; href?: string }[] = [
  { title: "创建 API Key", desc: "名称可自定义，创建后复制明文保存。", action: "去创建", panel: "apikeys" },
  { title: "充值积分", desc: "按需充值，余额与消耗在本页同屏可见。", action: "去充值", panel: "recharge" },
  { title: "按文档接入", desc: "OpenAI 兼容，替换 Base URL 与模型名即可。", action: "看文档", href: "/api-docs" },
];



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
  const { user, balance, wallet, stats, recentAssets, notices } = data;

  // b10：接入地址按当前站点 origin 推导；首帧为空，挂载后填充，避免水合不一致
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  const apiBase = origin ? `${origin}/v1` : "";
  async function copyBase() {
    if (!apiBase) return;
    try {
      await navigator.clipboard.writeText(apiBase);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时保持原文展示，用户可手动复制 */
    }
  }

  const boundCount = [user.email, user.phone, user.hasPassword].filter(Boolean).length;
  const securityLevel = boundCount >= 3 ? "高" : boundCount === 2 ? "中" : "低";

  const quickLinks = [
    { href: "/categories", icon: "📚", label: "提示词库" },
    { href: "/skills", icon: "🧩", label: "技能库" },
    { href: "/playground", icon: "▶", label: "实验场" },
    { href: "/api-docs", icon: "📖", label: "API 文档" },
    { href: "/recharge", icon: "⚡", label: "充值中心" },
  ];

  return (
    <div className="space-y-5">
      {/* ── Hero 会员信息横幅（含账户信息） ── */}
      <div className="mc-hero relative overflow-hidden p-5 sm:p-7">
        {/* v0.96：右上角改为「修改资料 + 退出登录」按钮组（手机在流内右对齐一行，避免遮挡；PC 绝对定位右上角） */}
        <div className="mb-3 flex items-center justify-end gap-2 sm:absolute sm:right-5 sm:top-4 sm:mb-0 sm:gap-2.5">
          <button
            type="button"
            onClick={() => onOpenPanel("profile")}
            className="flex items-center gap-1.5 rounded-full border border-white/25 bg-white/12 px-3.5 py-2 text-xs font-medium text-blue-100 backdrop-blur-sm transition hover:bg-white/22 hover:text-white sm:px-4 sm:py-2 sm:text-sm"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 sm:h-4 sm:w-4">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            修改资料
          </button>
          <LogoutButton className="flex items-center gap-1.5 rounded-full border border-white/25 bg-white/12 px-3.5 py-2 text-xs font-medium text-blue-100 backdrop-blur-sm transition hover:bg-white/22 hover:text-white sm:px-4 sm:py-2 sm:text-sm" />
        </div>
        <div className="flex items-center gap-4 sm:pr-40">
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
            <div className="text-xs text-blue-200/60">邮箱</div>
            <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-slate-200">
              <span className="truncate">{user.email || <span className="text-slate-500">未绑定</span>}</span>
              {user.email && user.emailVerified && (
                <span className="shrink-0 rounded bg-emerald-500/20 px-1 py-0.5 text-xs font-medium text-emerald-300">已验证</span>
              )}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-xs text-blue-200/60">手机</div>
            <div className="mt-0.5 truncate text-xs text-slate-200">
              {user.phone || <span className="text-slate-500">未绑定</span>}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-xs text-blue-200/60">登录方式</div>
            <div className="mt-0.5 truncate text-xs text-slate-200">{user.hasPassword ? "账号密码" : "快捷登录"}</div>
          </div>
          <div className="min-w-0">
            <div className="text-xs text-blue-200/60">安全等级</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-xs font-semibold text-emerald-400">{securityLevel}</span>
              <div className="mc-progress h-1 max-w-24 flex-1">
                <i className="mc-bar-green" style={{ width: `${(boundCount / 3) * 100}%` }} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── b4 钱包三指标同屏：当前积分 / 累计消耗 / 累计请求 + 充值 / 积分明细入口 ── */}
      <div className="mc-card flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="grid flex-1 grid-cols-3 gap-3">
          <div className="min-w-0">
            <div className="text-xs text-slate-500">当前积分</div>
            <div className="mt-1 truncate text-lg font-bold text-amber-300">{balance.toLocaleString()}</div>
          </div>
          <div className="min-w-0">
            <div className="text-xs text-slate-500">累计消耗</div>
            <div className="mt-1 truncate text-lg font-bold text-slate-100">{wallet.spentCredits.toLocaleString()}</div>
          </div>
          <div className="min-w-0">
            <div className="text-xs text-slate-500">累计请求</div>
            <div className="mt-1 truncate text-lg font-bold text-slate-100">{wallet.requests.toLocaleString()}</div>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => onOpenPanel("recharge")}
            className="rounded-lg bg-emerald-500/15 px-3.5 py-2 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/25"
          >
            充值积分
          </button>
          <button
            type="button"
            onClick={() => onOpenPanel("ledger")}
            className="rounded-lg bg-zinc-800 px-3.5 py-2 text-xs font-medium text-slate-300 transition hover:bg-zinc-700"
          >
            积分明细
          </button>
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
              全部通知
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
                      <span className="shrink-0 text-xs text-slate-500">{fmtDay(n.createdAt)}</span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-slate-400">{stripHtml(n.body)}</p>
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
              查看全部
            </button>
          </div>
          {recentAssets.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-500">暂无生成资产，去 API 文档开始创作</p>
          ) : (
            <ul className="space-y-2.5">
              {recentAssets.map((a) => (
                <li key={a.id} className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/12 text-base">
                    {assetTypeIcon(a.assetType)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-slate-200">{a.name}</div>
                    <div className="text-xs text-slate-500">{fmtDay(a.createdAt)} · {fmtSize(a.sizeBytes)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ── b10 控制台首页四块引导：公告 / 接入信息 / FAQ / 新手引导 ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 公告 */}
        <div className="mc-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="mc-section-title">公告</h3>
            <button onClick={() => onOpenPanel("messages")} className="text-xs text-blue-400 hover:underline">
              全部
            </button>
          </div>
          {notices[0] ? (
            <>
              <div className="truncate text-xs font-medium text-slate-200">{notices[0].subject || "网站公告"}</div>
              <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-slate-400">{stripHtml(notices[0].body)}</p>
              <div className="mt-2 text-xs text-slate-500">{fmtDay(notices[0].createdAt)}</div>
            </>
          ) : (
            <p className="py-4 text-center text-xs text-slate-500">暂无公告</p>
          )}
        </div>

        {/* 接入信息 */}
        <div className="mc-card p-5">
          <h3 className="mc-section-title mb-3">接入信息</h3>
          <p className="text-xs text-slate-400">OpenAI 兼容接口，Base URL：</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-emerald-300">
              {apiBase || "加载中…"}
            </code>
            <button
              type="button"
              onClick={copyBase}
              disabled={!apiBase}
              className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-zinc-600 disabled:cursor-not-allowed disabled:text-slate-600"
            >
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          <div className="mt-3 flex items-center gap-4 text-xs">
            <Link href="/api-docs" className="text-blue-400 hover:underline">接口文档</Link>
            <button onClick={() => onOpenPanel("apikeys")} className="text-blue-400 hover:underline">管理 API Key</button>
          </div>
        </div>

        {/* FAQ */}
        <div className="mc-card p-5">
          <h3 className="mc-section-title mb-3">常见问题</h3>
          <div className="space-y-1.5">
            {FAQ_ITEMS.map((f) => (
              <details key={f.q} className="group rounded-lg border border-zinc-800 px-3 py-2">
                <summary className="cursor-pointer list-none text-xs font-medium text-slate-200 group-open:text-emerald-300">
                  {f.q}
                </summary>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{f.a}</p>
              </details>
            ))}
          </div>
        </div>

        {/* 新手引导 */}
        <div className="mc-card p-5">
          <h3 className="mc-section-title mb-3">新手引导</h3>
          <ol className="space-y-2.5">
            {GUIDE_STEPS.map((s, i) => (
              <li key={s.title} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-xs font-semibold text-blue-300">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-slate-200">{s.title}</div>
                  <div className="mt-0.5 text-xs text-slate-400">{s.desc}</div>
                </div>
                {s.panel ? (
                  <button
                    type="button"
                    onClick={() => onOpenPanel(s.panel!)}
                    className="shrink-0 rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-slate-300 transition hover:bg-zinc-700"
                  >
                    {s.action}
                  </button>
                ) : (
                  <Link
                    href={s.href!}
                    className="shrink-0 rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-slate-300 transition hover:bg-zinc-700"
                  >
                    {s.action}
                  </Link>
                )}
              </li>
            ))}
          </ol>
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
            <span className="text-xs font-medium text-slate-300 sm:text-xs">{q.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
