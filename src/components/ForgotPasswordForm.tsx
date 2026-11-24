"use client";

import { useEffect, useState } from "react";

const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-emerald-500";

// ─── P7 找回密码：邮箱验证码 → 设置新密码 ───
export default function ForgotPasswordForm() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [codeMsg, setCodeMsg] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => setEnabled(!!d.emailResetEnabled))
      .catch(() => setEnabled(false));
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const sendCode = async () => {
    if (!email.trim()) {
      setCodeMsg("请先填写注册时的邮箱");
      return;
    }
    setCodeMsg("");
    const res = await fetch("/api/auth/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), purpose: "reset" }),
    });
    const d = await res.json();
    if (res.ok) {
      setCooldown(d.cooldownSeconds || 60);
      setCodeMsg(`若邮箱已注册，验证码已发送（${d.ttlMinutes || 10} 分钟内有效）；没收到请查垃圾邮件箱`);
    } else {
      setCodeMsg(d.error || "发送失败，请稍后再试");
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), code: code.trim(), newPassword }),
    });
    const d = await res.json();
    setLoading(false);
    if (res.ok) {
      setDone(true);
    } else {
      setError(d.error || "重置失败");
    }
  };

  if (enabled === null) return <p className="py-10 text-center text-zinc-500">加载中…</p>;

  return (
    <form
      onSubmit={submit}
      className="mx-auto mt-16 w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900/60 p-6"
    >
      <h1 className="mb-6 text-center text-xl font-bold">找回密码</h1>

      {!enabled ? (
        <p className="mb-4 rounded bg-amber-500/10 p-3 text-sm text-amber-300">
          未开启邮箱找回密码功能，请联系管理员。
        </p>
      ) : done ? (
        <>
          <p className="mb-4 rounded bg-emerald-500/10 p-3 text-sm text-emerald-300">
            密码已重置，请使用新密码登录。
          </p>
          <a
            href="/login"
            className="block w-full rounded-lg bg-emerald-500 py-2 text-center font-medium text-zinc-950 hover:bg-emerald-400"
          >
            去登录
          </a>
        </>
      ) : (
        <>
          <label className="mb-1 block text-sm text-zinc-400">注册邮箱 *</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={"mb-4 " + inputCls}
          />

          <label className="mb-1 block text-sm text-zinc-400">邮箱验证码 *</label>
          <div className="mb-4 flex items-center gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required
              inputMode="numeric"
              placeholder="6 位数字"
              className={inputCls + " flex-1"}
            />
            <button
              type="button"
              onClick={sendCode}
              disabled={cooldown > 0}
              className="whitespace-nowrap rounded-lg border border-zinc-600 px-3 py-2 text-sm text-zinc-200 hover:border-emerald-500 disabled:opacity-50"
            >
              {cooldown > 0 ? `重发(${cooldown}s)` : "发送验证码"}
            </button>
          </div>
          {codeMsg && <p className="-mt-2 mb-4 text-xs text-zinc-400">{codeMsg}</p>}

          <label className="mb-1 block text-sm text-zinc-400">新密码 *</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={6}
            className={"mb-4 " + inputCls}
          />

          {error && <p className="mb-3 rounded bg-rose-500/10 p-2 text-sm text-rose-300">{error}</p>}

          <button
            disabled={loading}
            className="w-full rounded-lg bg-emerald-500 py-2 font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            {loading ? "…" : "重置密码"}
          </button>
        </>
      )}

      <p className="mt-4 text-center text-sm text-zinc-500">
        <a href="/login" className="text-emerald-400 hover:underline">返回登录</a>
      </p>
    </form>
  );
}
