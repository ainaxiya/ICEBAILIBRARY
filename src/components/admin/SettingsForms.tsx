"use client";

import { useEffect, useState } from "react";
import OptionDropdown from "@/components/OptionDropdown";

function useSettings() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    fetch("/api/admin/settings").then((r) => r.json()).then(setData);
  }, []);
  return data;
}

function SaveBar({ section, value, onSaved }: { section: string; value: any; onSaved?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section, value }),
    });
    setBusy(false);
    if (r.ok) {
      setOk(true);
      onSaved?.();
      setTimeout(() => setOk(false), 2000);
    } else alert("保存失败");
  };
  return (
    <div className="mt-6">
      <button onClick={save} disabled={busy}
        className="rounded-lg bg-emerald-500 px-6 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
        {busy ? "保存中…" : "保存设置"}
      </button>
      {ok && <span className="ml-3 text-sm text-emerald-400">已保存 ✓</span>}
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-emerald-500";
const labelCls = "mb-1 block text-sm text-zinc-400";
const cardCls = "rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 mb-4";

export function PublishForm() {
  const all = useSettings();
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (all) setF({ ...all.publish }); }, [all]);
  if (!f) return <p className="py-10 text-center text-zinc-500">加载中…</p>;
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const num = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(k, Math.max(0, parseInt(e.target.value) || 0));

  return (
    <div className="max-w-2xl">
      <div className={cardCls}>
        <label className={labelCls}>发布模式</label>
        <div className="mb-2">
          <OptionDropdown
            value={f.mode}
            size="md"
            onChange={(v) => set("mode", v)}
            options={[
              { value: "auto", label: "发布即上线（免审核）", tone: "green" },
              { value: "review", label: "先审核后上线", tone: "amber" },
            ]}
          />
        </div>
        <p className="text-xs text-zinc-500">切换为审核模式后，用户新发布的内容需在「提示词管理」中通过后才公开。</p>
      </div>

      <div className={cardCls}>
        <h3 className="mb-3 text-sm font-medium text-zinc-300">上传与转载</h3>
        <label className="mb-3 flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={!!f.allowUpload} onChange={(e) => set("allowUpload", e.target.checked)} />
          允许本地上传图片/视频
        </label>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>图片上限 MB</label>
            <input type="number" value={f.maxImageMB} onChange={num("maxImageMB")} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>视频上限 MB</label>
            <input type="number" value={f.maxVideoMB} onChange={num("maxVideoMB")} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>每条媒体数</label>
            <input type="number" value={f.maxMediaPerPrompt} onChange={num("maxMediaPerPrompt")} className={inputCls} />
          </div>
        </div>
      </div>

      <div className={cardCls}>
        <label className={labelCls}>内容最大长度（字符）</label>
        <input type="number" value={f.maxContentLen} onChange={num("maxContentLen")} className={inputCls} />
      </div>

      <SaveBar section="publish" value={f} />
    </div>
  );
}

// ─── 注册设置（原会员设置）：注册总开关 + 扩展字段收集策略 ───
const FIELD_OPTS = [
  { value: "off", label: "不收集", tone: "zinc" as const },
  { value: "optional", label: "可选填", tone: "amber" as const },
  { value: "required", label: "必填", tone: "green" as const },
];

export function RegisterSettingsForm() {
  const all = useSettings();
  const [f, setF] = useState<any>(null);
  useEffect(() => {
    if (all) {
      setF({
        allowRegister: all.register?.allowRegister ?? true,
        emailVerify: all.register?.emailVerify ?? false,
        fields: {
          email: all.register?.fields?.email ?? "off",
          nickname: all.register?.fields?.nickname ?? "optional",
          phone: all.register?.fields?.phone ?? "off",
        },
      });
    }
  }, [all]);
  if (!f) return <p className="py-10 text-center text-zinc-500">加载中…</p>;

  const setField = (k: string, v: string) => setF({ ...f, fields: { ...f.fields, [k]: v } });

  const rows = [
    { key: "email", name: "邮箱", desc: "用于找回密码、接收通知" },
    { key: "nickname", name: "昵称", desc: "前台展示名称，不填则默认显示账号" },
    { key: "phone", name: "手机号", desc: "用于账号安全验证" },
  ];

  return (
    <div className="max-w-2xl">
      <div className={cardCls}>
        <label className="flex items-center gap-2 text-sm text-zinc-200">
          <input
            type="checkbox"
            checked={!!f.allowRegister}
            onChange={(e) => setF({ ...f, allowRegister: e.target.checked })}
          />
          开放前台会员注册
        </label>
        <p className="mt-1.5 text-xs text-zinc-500">
          关闭后注册接口与前台注册页均不可用，已有会员登录不受影响。
        </p>
        <div className="mt-4 border-t border-zinc-800 pt-4">
          <label className="flex items-center gap-2 text-sm text-zinc-200">
            <input
              type="checkbox"
              checked={!!f.emailVerify}
              onChange={(e) => setF({ ...f, emailVerify: e.target.checked })}
            />
            注册需邮箱验证码
          </label>
          <p className="mt-1.5 text-xs text-zinc-500">
            开启后注册必须填邮箱并输入验证码（邮箱强制必填）。前置条件：已配置并启用「邮箱服务」，否则注册会被阻断。
          </p>
        </div>
      </div>

      <div className={cardCls}>
        <h3 className="mb-3 text-sm font-medium text-zinc-200">注册需要填写的内容</h3>
        <p className="mb-4 text-xs text-zinc-500">
          账号、密码为系统固定必填项；以下资料可分别设置为「不收集 / 可选填 / 必填」，设置后立即作用于前台注册页。
        </p>
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center justify-between gap-4 rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-3">
              <div>
                <p className="text-sm text-zinc-200">{r.name}</p>
                <p className="text-xs text-zinc-500">{r.desc}</p>
              </div>
              <OptionDropdown
                value={f.fields[r.key]}
                options={FIELD_OPTS}
                onChange={(v) => setField(r.key, v)}
                size="md"
                align="right"
              />
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-zinc-600">
          邮箱与手机号均做全站唯一校验；当前版本仅普通会员一个级别。
        </p>
      </div>

      <SaveBar section="register" value={f} />
    </div>
  );
}

// ─── 注册赠送（试用积分）：SiteSetting key="credits_config"，注册时自动发放 ───
// v0.92 #1 从「运营告警」页迁入「会员管理-注册设置」
export function RegisterGiftForm() {
  const [trialEnabled, setTrialEnabled] = useState(false);
  const [trialCredits, setTrialCredits] = useState(0);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/admin/settings/credits")
      .then((r) => r.json())
      .then((d) => {
        setTrialEnabled(!!d.trialEnabled);
        setTrialCredits(Number(d.trialCredits) || 0);
      })
      .catch(() => {});
  }, []);

  const saveTrial = async () => {
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const r = await fetch("/api/admin/settings/credits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trialEnabled, trialCredits }),
      });
      const d = await r.json();
      if (r.ok) {
        setTrialEnabled(!!d.value?.trialEnabled);
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

  return (
    <div>
      {error && <p className="mb-3 text-sm text-rose-500">{error}</p>}
      <div className={cardCls}>
        <h3 className="mb-3 text-sm font-medium text-zinc-200">注册赠送</h3>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={trialEnabled} onChange={(e) => setTrialEnabled(e.target.checked)} />
          开启注册赠送积分（默认关闭）
        </label>
        <div className="mt-3">
          <label className={labelCls}>每个新用户赠送积分（0 = 不发放）</label>
          <input
            type="number"
            min={0}
            value={trialCredits}
            onChange={(e) => setTrialCredits(Math.max(0, parseInt(e.target.value) || 0))}
            className={inputCls}
          />
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={saveTrial}
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? "保存中…" : "保存配置"}
          </button>
          {saved && <span className="text-sm text-emerald-500">已保存 ✓</span>}
        </div>
        <p className="mt-3 text-xs text-zinc-600">
          开关仅对新注册用户生效（写 trial 类型积分发放记录），已注册用户不补发。
        </p>
      </div>
    </div>
  );
}
