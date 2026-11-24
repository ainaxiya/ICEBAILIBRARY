"use client";

// b13 敏感操作二次验证弹窗（全局挂一次，见后台 layout）
// adminFetch 命中 403 + code=REAUTH_REQUIRED 时调用 requestReauth()，用户重输密码后自动重试原请求。
import { useEffect, useRef, useState } from "react";

type Resolver = (ok: boolean) => void;

let opener: ((resolve: Resolver) => void) | null = null;

export function requestReauth(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!opener) {
      resolve(false);
      return;
    }
    opener(resolve);
  });
}

export default function ReauthHost() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const resolverRef = useRef<Resolver | null>(null);

  useEffect(() => {
    opener = (resolve) => {
      resolverRef.current = resolve;
      setPassword("");
      setErr("");
      setOpen(true);
    };
    return () => {
      opener = null;
    };
  }, []);

  const close = (ok: boolean) => {
    setOpen(false);
    setBusy(false);
    resolverRef.current?.(ok);
    resolverRef.current = null;
  };

  const submit = async () => {
    if (!password) {
      setErr("请输入当前管理员密码");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/admin/reauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "验证失败");
        return;
      }
      close(true);
    } catch {
      setErr("网络异常，请重试");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-[#0f1630] p-5 shadow-2xl">
        <h2 className="mb-1 text-base font-bold text-zinc-100">敏感操作二次验证</h2>
        <p className="mb-4 text-xs text-zinc-400">
          该操作涉及权限、账号或积分变更，请重新输入当前管理员密码。验证通过后 10 分钟内有效。
        </p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) submit();
            if (e.key === "Escape") close(false);
          }}
          placeholder="当前管理员密码"
          className="mb-3 w-full rounded-lg border border-zinc-700 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
        />
        {err && <p className="mb-3 text-xs text-rose-400">{err}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={() => close(false)}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={busy || !password}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? "验证中…" : "验证并继续"}
          </button>
        </div>
      </div>
    </div>
  );
}
