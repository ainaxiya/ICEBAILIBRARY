"use client";

import { useState } from "react";

// ─── v0.92 #9 修改密码 ───

const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500";

export default function PasswordChange() {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    setMsg("");
    if (!oldPassword || !newPassword) {
      setErr("请填写当前密码与新密码");
      return;
    }
    if (newPassword.length < 6 || newPassword.length > 64) {
      setErr("新密码长度需 6-64 位");
      return;
    }
    if (newPassword !== confirm) {
      setErr("两次输入的新密码不一致");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/user/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "修改失败");
        return;
      }
      setOldPassword("");
      setNewPassword("");
      setConfirm("");
      setMsg("密码已修改 ✓");
      setTimeout(() => setMsg(""), 3000);
    } catch {
      setErr("网络错误");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 className="mb-1 text-base font-semibold text-zinc-100">修改密码</h2>
      <p className="mb-4 text-xs text-zinc-500">修改成功后下次登录请使用新密码</p>

      <label className="mb-4 block">
        <span className="mb-1 block text-sm text-zinc-400">当前密码</span>
        <input
          type="password"
          value={oldPassword}
          onChange={(e) => setOldPassword(e.target.value)}
          autoComplete="current-password"
          className={inputCls}
        />
      </label>
      <label className="mb-4 block">
        <span className="mb-1 block text-sm text-zinc-400">新密码（6-64 位）</span>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          className={inputCls}
        />
      </label>
      <label className="mb-4 block">
        <span className="mb-1 block text-sm text-zinc-400">确认新密码</span>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className={inputCls}
        />
      </label>

      {err && <p className="mb-3 text-sm text-rose-400">{err}</p>}
      {msg && <p className="mb-3 text-sm text-emerald-400">{msg}</p>}

      <button
        onClick={submit}
        disabled={saving}
        className="rounded-lg bg-emerald-500 px-5 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
      >
        {saving ? "提交中…" : "确认修改"}
      </button>
    </div>
  );
}
