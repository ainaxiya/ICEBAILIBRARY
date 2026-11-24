"use client";

import { useEffect, useState } from "react";

// ─── P7 邮件体系后台组件：邮箱服务配置 + 邮件模板管理 ───

const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-emerald-500";
const labelCls = "mb-1 block text-sm text-zinc-400";
const cardCls = "rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 mb-4";

function okCls() {
  return "ml-3 text-sm text-emerald-400";
}

// ─── 邮箱服务配置 ───

export function EmailConfigForm() {
  const [f, setF] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");

  useEffect(() => {
    fetch("/api/admin/settings/email")
      .then((r) => r.json())
      .then((d) => setF({ ...d, smtpPass: "" }))
      .catch(() => setError("配置加载失败"));
  }, []);

  if (!f) return <p className="py-10 text-center text-zinc-500">加载中…</p>;

  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const num = (k: string, min: number, max: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value) || 0;
    set(k, Math.min(max, Math.max(min, v)));
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/admin/settings/email", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(f),
      });
      const d = await r.json();
      if (r.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setError(d.error || "保存失败");
      }
    } catch {
      setError("保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult("");
    try {
      const r = await fetch("/api/admin/settings/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testTo }),
      });
      const d = await r.json();
      setTestResult(r.ok ? "测试邮件已发送，请查收（含垃圾邮件箱）" : d.error || "发送失败");
    } catch {
      setTestResult("发送失败，请稍后重试");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="max-w-2xl">
      {error && <p className="mb-3 text-sm text-rose-500">{error}</p>}

      <div className={cardCls}>
        <label className="flex items-center gap-2 text-sm text-zinc-200">
          <input type="checkbox" checked={!!f.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          启用邮件服务（关闭后所有发信接口拒绝，验证码/找回密码不可用）
        </label>
        {!f.configured && (
          <p className="mt-2 text-xs text-amber-400">
            SMTP 尚未配置完整（服务器 / 用户 / 密码 / 发件地址），保存后才能发信。
          </p>
        )}
      </div>

      <div className={cardCls}>
        <h3 className="mb-3 text-sm font-medium text-zinc-200">SMTP 服务器</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>SMTP 服务器地址 *</label>
            <input value={f.smtpHost} onChange={(e) => set("smtpHost", e.target.value)} placeholder="如 smtp.example.com" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>端口 *</label>
            <input type="number" value={f.smtpPort} onChange={num("smtpPort", 1, 65535)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>SMTP 用户名 *</label>
            <input value={f.smtpUser} onChange={(e) => set("smtpUser", e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>SMTP 密码 {f.hasPass ? "（留空保持不变）" : "*"}</label>
            <input type="password" value={f.smtpPass} onChange={(e) => set("smtpPass", e.target.value)} autoComplete="new-password" className={inputCls} />
          </div>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={!!f.smtpSecure} onChange={(e) => set("smtpSecure", e.target.checked)} />
          隐式 SSL（465 端口勾选；587 端口 STARTTLS 不勾选）
        </label>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>发件人名称</label>
            <input value={f.fromName} onChange={(e) => set("fromName", e.target.value)} placeholder="如 冰山AI" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>发件邮箱 *</label>
            <input value={f.fromAddress} onChange={(e) => set("fromAddress", e.target.value)} placeholder="如 noreply@example.com" className={inputCls} />
          </div>
        </div>
        <p className="mt-2 text-xs text-zinc-500">密码 AES-256-GCM 加密存储，保存后不回显。</p>
      </div>

      <div className={cardCls}>
        <h3 className="mb-3 text-sm font-medium text-zinc-200">验证码策略</h3>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={!!f.resetPasswordVerify} onChange={(e) => set("resetPasswordVerify", e.target.checked)} />
          找回密码需邮箱验证码（关闭后用户无法自助找回密码）
        </label>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>验证码有效期（分钟）</label>
            <input type="number" value={f.codeTtlMinutes} onChange={num("codeTtlMinutes", 1, 60)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>重发冷却（秒）</label>
            <input type="number" value={f.resendCooldownSeconds} onChange={num("resendCooldownSeconds", 30, 3600)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>每小时上限（次/邮箱）</label>
            <input type="number" value={f.hourlySendLimit} onChange={num("hourlySendLimit", 1, 30)} className={inputCls} />
          </div>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          注册邮箱验证码开关在「会员管理 → 注册设置」页配置；验证码连续输错 5 次自动作废。
        </p>
      </div>

      <div className={cardCls}>
        <h3 className="mb-3 text-sm font-medium text-zinc-200">测试发送</h3>
        <div className="flex items-center gap-3">
          <input
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="接收测试邮件的邮箱"
            className={inputCls + " flex-1"}
          />
          <button
            onClick={sendTest}
            disabled={testing || !testTo.trim()}
            className="whitespace-nowrap rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:border-emerald-500 disabled:opacity-50"
          >
            {testing ? "发送中…" : "发送测试邮件"}
          </button>
        </div>
        {testResult && <p className="mt-2 text-xs text-zinc-400">{testResult}</p>}
        <p className="mt-1 text-xs text-zinc-600">测试邮件使用「邮件模板」中的测试模板；建议先保存配置再测试。</p>
      </div>

      <div className="mt-6">
        <button onClick={save} disabled={busy}
          className="rounded-lg bg-emerald-500 px-6 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
          {busy ? "保存中…" : "保存设置"}
        </button>
        {saved && <span className={okCls()}>已保存 ✓</span>}
      </div>
    </div>
  );
}

// ─── 邮件模板管理 ───

interface TplItem {
  key: string;
  name: string;
  desc: string;
  vars: string[];
  defaultSubject: string;
  defaultBodyHtml: string;
  subject: string;
  bodyHtml: string;
  enabled: boolean;
  customized: boolean;
}

export function EmailTemplatesForm() {
  const [items, setItems] = useState<TplItem[] | null>(null);
  const [savedKey, setSavedKey] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/admin/email-templates")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok || !d.templates) throw new Error(d.error || `HTTP ${r.status}`);
        setItems(d.templates);
      })
      .catch((e) => setError("模板加载失败：" + (e?.message || "未知错误")));
  }, []);

  if (error) return <p className="py-10 text-center text-sm text-rose-400">{error}</p>;
  if (!items) return <p className="py-10 text-center text-zinc-500">加载中…</p>;

  const set = (idx: number, k: string, v: any) => {
    const next = [...items];
    next[idx] = { ...next[idx], [k]: v };
    setItems(next);
  };

  const save = async (idx: number) => {
    const it = items[idx];
    setError("");
    try {
      const r = await fetch("/api/admin/email-templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: it.key, subject: it.subject, bodyHtml: it.bodyHtml, enabled: it.enabled }),
      });
      const d = await r.json();
      if (r.ok) {
        setSavedKey(it.key);
        setTimeout(() => setSavedKey(""), 2000);
        // 重新拉取（subject/body 双空会还原默认，刷新 customized 状态）
        const fresh = await fetch("/api/admin/email-templates").then((x) => x.json());
        setItems(fresh.templates);
      } else {
        setError(d.error || "保存失败");
      }
    } catch {
      setError("保存失败，请稍后重试");
    }
  };

  const reset = (idx: number) => {
    const it = items[idx];
    set(idx, "subject", "");
    set(idx, "bodyHtml", "");
  };

  return (
    <div className="max-w-3xl">
      {error && <p className="mb-3 text-sm text-rose-500">{error}</p>}
      {items.map((it, idx) => (
        <div key={it.key} className={cardCls}>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-zinc-200">
                {it.name}
                <span className="ml-2 text-xs text-zinc-600">{it.key}</span>
                {it.customized && <span className="ml-2 rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400">已自定义</span>}
              </h3>
              <p className="mt-0.5 text-xs text-zinc-500">{it.desc}</p>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={it.enabled} onChange={(e) => set(idx, "enabled", e.target.checked)} />
              启用
            </label>
          </div>
          <label className={labelCls}>邮件标题（可用变量：{it.vars.join("、")}）</label>
          <input value={it.subject} onChange={(e) => set(idx, "subject", e.target.value)} className={"mb-3 " + inputCls} />
          <label className={labelCls}>正文 HTML</label>
          <textarea
            value={it.bodyHtml}
            onChange={(e) => set(idx, "bodyHtml", e.target.value)}
            rows={10}
            className={inputCls + " font-mono text-xs"}
          />
          <div className="mt-3 flex items-center gap-3">
            <button onClick={() => save(idx)}
              className="rounded-lg bg-emerald-500 px-5 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400">
              保存模板
            </button>
            <button onClick={() => reset(idx)}
              className="rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-300 hover:border-amber-500">
              还原默认（保存后生效）
            </button>
            {savedKey === it.key && <span className={okCls()}>已保存 ✓</span>}
          </div>
        </div>
      ))}
      <p className="text-xs text-zinc-600">
        变量用双花括号插值，如 {"{{code}}"}；正文标题与正文同时留空保存 = 还原内置默认模板。
      </p>
    </div>
  );
}
