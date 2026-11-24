"use client";

import { translate as t, useLocale } from "@/lib/i18n-client";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type FieldMode = "off" | "optional" | "required";
type RegFields = { email: FieldMode; nickname: FieldMode; phone: FieldMode };

// 输入框：移动端固定 16px，避免 iOS Safari 聚焦时自动放大把布局顶飞；桌面回落 14px
const inputCls =
  "w-full rounded-xl border border-[rgba(56,189,248,0.5)] bg-white/[0.05] py-3 pl-10 pr-3.5 text-[16px] text-white outline-none transition placeholder:text-zinc-500 focus:border-[rgba(56,189,248,0.85)] focus:bg-white/[0.09] focus:shadow-[0_0_0_3px_rgba(56,189,248,0.14)] sm:text-sm";
const inputWithTrailingCls = inputCls + " pr-11";

const labelCls = "mb-1.5 block text-[13px] font-medium text-zinc-300";
const fieldWrapCls = "relative";

// 主次按钮沿用积分不足页配色：蓝→青渐变主按钮 + 深色半透次按钮
const primaryBtnCls =
  "glow-line-sky flex w-full items-center justify-center gap-2 rounded-xl border border-[rgba(70,144,255,0.7)] bg-gradient-to-r from-[#2b6df6] to-[#38d9f0] py-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50";
const secondaryBtnCls =
  "whitespace-nowrap rounded-xl border border-[rgba(56,189,248,0.5)] bg-white/[0.06] px-3 py-3 text-sm text-zinc-100 backdrop-blur-sm transition hover:border-[rgba(56,189,248,0.85)] hover:bg-white/[0.1] hover:text-white disabled:opacity-50";
// 错误 / 提示条：描边统一天蓝系，与卡片同一套色，只靠文字颜色区分语义
const noticeCls = "mb-4 rounded-xl border border-[rgba(56,189,248,0.32)] bg-white/[0.06] px-3 py-2 text-sm";

function FieldIcon({ name }: { name: "user" | "lock" | "mail" | "phone" | "shield" }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-zinc-300",
  };
  switch (name) {
    case "user":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 20c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5" />
        </svg>
      );
    case "lock":
      return (
        <svg {...common}>
          <rect x="5" y="10" width="14" height="10" rx="2.5" />
          <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
        </svg>
      );
    case "mail":
      return (
        <svg {...common}>
          <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
          <path d="M4 7l8 6 8-6" />
        </svg>
      );
    case "phone":
      return (
        <svg {...common}>
          <rect x="7" y="3" width="10" height="18" rx="2.5" />
          <path d="M11 18h2" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M12 3l7 3v6c0 4.2-2.9 7.5-7 9-4.1-1.5-7-4.8-7-9V6l7-3z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
  }
}

/** 第三方登录图标（按设计稿：谷歌 / GitHub / 微信 / 邮箱）
 *  当前仅做静态展示，不接 OAuth：点击只给「暂未开放」轻提示，不跳转、不弹窗、不调接口。 */
const THIRD_PARTY: { key: "google" | "github" | "wechat" | "email"; name: string }[] = [
  { key: "google", name: "谷歌" },
  { key: "github", name: "GitHub" },
  { key: "wechat", name: "微信" },
  { key: "email", name: "邮箱" },
];

function ThirdPartyIcon({ name }: { name: "google" | "github" | "wechat" | "email" }) {
  switch (name) {
    case "google":
      return (
        <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden>
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
        </svg>
      );
    case "github":
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="#181717" aria-hidden>
          <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
        </svg>
      );
    case "wechat":
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="#07C160" aria-hidden>
          <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088-.135-.01-.27-.027-.407-.032zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
          <path fill="#2563EB" d="M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11z" />
          <path d="M4.2 6.4 12 12.3l7.8-5.9" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}

export default function AuthForm({
  mode,
  siteName,
  logoIcon = "/logo/icon.png",
}: {
  mode: "login" | "register";
  siteName?: string;
  logoIcon?: string;
}) {
  const locale = useLocale();
  const sp = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [nickname, setNickname] = useState("");
  const [regFields, setRegFields] = useState<RegFields | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [closed, setClosed] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  // 第三方登录：按设计稿只做静态入口，点击仅给「暂未开放」轻提示（暂不接 OAuth）
  const [oauthHint, setOauthHint] = useState(false);
  // P7 注册邮箱验证码
  const [emailVerify, setEmailVerify] = useState(false);
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [codeMsg, setCodeMsg] = useState("");

  useEffect(() => {
    if (mode === "register") {
      fetch("/api/settings")
        .then((r) => r.json())
        .then((d) => {
          setClosed(!d.basic.allowRegister);
          setRegFields(
            d.registerFields || { email: "off", nickname: "off", phone: "off" }
          );
          setEmailVerify(!!d.emailVerifyRequired);
        })
        .catch(() => {});
    }
  }, [mode]);

  // 重发倒计时
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const sendCode = async () => {
    if (!email.trim()) {
      setCodeMsg("请先填写邮箱");
      return;
    }
    setCodeMsg("");
    const res = await fetch("/api/auth/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), purpose: "register" }),
    });
    const d = await res.json();
    if (res.ok) {
      setCooldown(d.cooldownSeconds || 60);
      setCodeMsg(`验证码已发送至邮箱，${d.ttlMinutes || 10} 分钟内有效；没收到请查垃圾邮件箱`);
    } else {
      setCodeMsg(d.error || "发送失败，请稍后再试");
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const payload: Record<string, string> =
      mode === "register"
        ? {
            username,
            password,
            // P7 邮箱验证码开启：邮箱强制必填并携带验证码
            ...(emailVerify
              ? { email: email.trim(), code: code.trim() }
              : regFields?.email !== "off" && email.trim()
                ? { email: email.trim() }
                : {}),
            ...(regFields?.phone !== "off" && phone.trim() ? { phone: phone.trim() } : {}),
            ...(regFields?.nickname !== "off" && nickname.trim() ? { nickname: nickname.trim() } : {}),
            // locale：未填昵称时后端按界面语言自动取随机名（zh→中文名 / en→英文名）
            locale,
          }
        : { username, password };
    const res = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(
        d.error === "registration closed"
          ? t(locale, "auth.registrationClosed")
          : d.error || "Error"
      );
      return;
    }
    const rawNext = sp.get("next") || "/";
    // 仅允许站内路径，防开放重定向
    const next =
      rawNext.startsWith("/") && !rawNext.startsWith("//") && !rawNext.startsWith("/\\")
        ? rawNext
        : "/";
    // 整页跳转：登录态在服务端布局/UserMenu 里，客户端路由跳转不会重取登录状态
    // （router.push + refresh 有竞态，导航栏会停留在旧状态），必须整页加载
    window.location.replace(next);
  };

  const f = regFields;
  const showEmail = mode === "register" && (emailVerify || (f && f.email !== "off"));
  const emailRequired = mode === "register" && (emailVerify || f?.email === "required");
  const show = (k: keyof RegFields) => mode === "register" && !emailVerify && f && f[k] !== "off";
  const req = (k: keyof RegFields) => f?.[k] === "required";

  return (
    <form
      onSubmit={submit}
      aria-label={mode === "login" ? t(locale, "auth.login") : t(locale, "auth.register")}
      className="glow-line-sky relative isolate mx-auto w-full max-w-[420px] overflow-hidden rounded-[24px] border border-[rgba(56,189,248,0.34)] bg-[#071634]/85 px-5 py-6 shadow-[0_24px_70px_-24px_rgba(29,78,216,0.75)] backdrop-blur-[5px] sm:px-7 sm:py-7"
    >
      {/* 顶部与底部极淡的品牌光，仅作玻璃质感层次 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-24 h-48 bg-[radial-gradient(closest-side,rgba(56,189,248,0.22),transparent)]"
      />

      <div className="relative">
        {/* 登录 / 注册 双态切换：同一套视觉，只切路由 */}
        <div className="relative mb-8 flex items-end justify-center gap-10 border-b border-[rgba(56,189,248,0.18)]">
          {(["login", "register"] as const).map((m) => (
            <a
              key={m}
              href={`/${m}`}
              aria-current={mode === m ? "page" : undefined}
              className={`relative -mb-px pb-3 text-[15px] font-semibold transition ${
                mode === m ? "text-white" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {m === "login" ? t(locale, "auth.login") : t(locale, "auth.register")}
              {mode === m && (
                <span className="absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-gradient-to-r from-[#38bdf8] to-[#2b6df6] shadow-[0_0_12px_rgba(56,189,248,0.85)]" />
              )}
            </a>
          ))}
        </div>

        {/* 品牌区：复用站点现有 LOGO 图（与页头/页脚同一资源），不另切图 */}
        <div className="mb-8 flex items-center justify-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logoIcon}
            alt={siteName || ""}
            className="h-11 w-11 shrink-0 rounded-xl object-cover sm:h-12 sm:w-12"
          />
          <div className="leading-tight">
            <h1 className="text-[20px] font-semibold tracking-wide text-white">{siteName}</h1>
            <p className="mt-1 text-[14px] font-medium tracking-[0.33em] text-white">ICEBAI.COM</p>
          </div>
        </div>

       
        <div className={fieldWrapCls + " mb-4"}>
          <FieldIcon name="user" />
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            maxLength={20}
            pattern="[A-Za-z0-9_\-]+"
            autoComplete="username"
            placeholder={mode === "login" ? "输入您的用户名" : "设置用户名"}
            className={inputCls}
          />
        </div>

        {show("nickname") && (
          <>
            <div className={fieldWrapCls + " mb-4"}>
              <FieldIcon name="user" />
              <input
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                required={req("nickname")}
                maxLength={20}
                placeholder="昵称2-20个字符"
                className={inputCls}
              />
            </div>
          </>
        )}

        {showEmail && (
          <>
            <div className={fieldWrapCls + " mb-4"}>
              <FieldIcon name="mail" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required={emailRequired}
                autoComplete="email"
                placeholder="填写邮箱地址Email"
                className={inputCls}
              />
            </div>
          </>
        )}

        {mode === "register" && emailVerify && (
          <>
            <label className={labelCls}>点击获取验证码,再前往您填写的邮箱查看</label>
            <div className="mb-4 flex items-center gap-2">
              <div className={fieldWrapCls + " flex-1"}>
                <FieldIcon name="shield" />
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  required
                  inputMode="numeric"
                  placeholder="6 位数字"
                  className={inputCls}
                />
              </div>
              <button
                type="button"
                onClick={sendCode}
                disabled={cooldown > 0}
                className={secondaryBtnCls}
              >
                {cooldown > 0 ? `重发(${cooldown}s)` : "发送验证码"}
              </button>
            </div>
            {codeMsg && <p className="-mt-2.5 mb-4 text-xs text-zinc-400">{codeMsg}</p>}
          </>
        )}

        {show("phone") && (
          <>
            
            <div className={fieldWrapCls + " mb-4"}>
              <FieldIcon name="phone" />
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required={req("phone")}
                autoComplete="tel"
                placeholder="请输入手机号"
                className={inputCls}
              />
            </div>
          </>
        )}

        
        <div className={fieldWrapCls + " mb-3"}>
          <FieldIcon name="lock" />
          <input
            type={showPwd ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            placeholder={mode === "login" ? "请输入密码" : "设置密码 最少6位"}
            className={inputWithTrailingCls}
          />
          <button
            type="button"
            onClick={() => setShowPwd((v) => !v)}
            aria-label={showPwd ? "隐藏密码" : "显示密码"}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-zinc-500 transition hover:text-zinc-200"
          >
            {showPwd ? (
              <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 text-sky-300/50" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3l18 18" />
                <path d="M10.6 6.3A9.9 9.9 0 0 1 12 6c5 0 8.5 4.5 9.5 6-.4.6-1.2 1.8-2.4 2.9" />
                <path d="M6.5 7.8C4.7 9.2 3.3 11 2.5 12c1 1.5 4.5 6 9.5 6 1.5 0 2.9-.4 4.1-1.1" />
                <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 text-sky-300/50" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
                <circle cx="12" cy="12" r="2.8" />
              </svg>
            )}
          </button>
        </div>

        {mode === "login" && (
          <div className="mb-4 flex items-center justify-end">
            <a href="/forgot-password" className="text-sm text-royal-200 transition hover:text-white hover:underline">
              忘记密码？
            </a>
          </div>
        )}

       


        <button disabled={loading || (mode === "register" && closed)} className={primaryBtnCls}>
          {loading ? "…" : mode === "login" ? t(locale, "auth.login") : t(locale, "auth.register")}
          
        </button>
        {closed && mode === "register" && !error && (
          <p className={"mt-2 text-center text-amber-200"}>{t(locale, "auth.registrationClosed")}</p>
        )}
        {error && <p className={"mt-2 text-center text-rose-300 h-8"}>{error}</p>}
        {/* 第三方登录：按设计稿位置放静态入口。当前不接 OAuth，点击只提示「暂未开放」 */}
        <div className="mt-5">
          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-[rgba(56,189,248,0.18)]" aria-hidden />
            <span className="whitespace-nowrap text-[12px] text-zinc-400">
              或使用其他方式{mode === "login" ? "登录" : "注册"}
            </span>
            <span className="h-px flex-1 bg-[rgba(56,189,248,0.18)]" aria-hidden />
          </div>
          <div className="mt-4 flex items-center justify-center gap-4">
            {THIRD_PARTY.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setOauthHint(true)}
                aria-label={`${p.name}（暂未开放）`}
                title={`${p.name}登录暂未开放`}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-[0_2px_10px_rgba(0,0,0,0.28)] transition hover:brightness-95 active:scale-95"
              >
                <ThirdPartyIcon name={p.key} />
              </button>
            ))}
          </div>
          {/* 轻提示：行内文字，不弹窗、不跳转、不调接口；预留高度避免卡片跳动 */}
          <p role="status" className="mt-2 h-4 text-center text-[12px] text-zinc-400">
            {oauthHint ? "第三方登录暂未开放，后续接入 OAuth 后可用" : ""}
          </p>
        </div>

        <p className="mt-2 text-center text-[16px] text-zinc-400">
          {mode === "login" ? (
            <>
              还没有账号？
              <a href="/register" className="ml-1 text-royal-200 transition hover:text-white hover:underline">
                立即注册
              </a>
            </>
          ) : (
            <>
              <a href="/login" className="text-royal-200 transition hover:text-white hover:underline">
                {t(locale, "auth.hasAccount")}
              </a>
            </>
          )}
        </p>
      </div>
    </form>
  );
}
