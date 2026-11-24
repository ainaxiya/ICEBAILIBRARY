"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import UserAvatar from "@/components/UserAvatar";
import RegionCascade from "@/components/RegionCascade";
import { LOCALES, TIMEZONES, type RegionValue } from "@/lib/regions";

// 头像裁剪（自研 AvatarCropper）：正方形取景 / 缩放 / 双指捏合，打开期间屏蔽抽屉手势
const AvatarCropper = dynamic(() => import("@/components/AvatarCropper"), { ssr: false });

// ─── v0.92 #9 资料修改：头像上传（前端裁剪）/ 昵称 / 手机 / 邮箱（锁定+已验证）/ 微信 / QQ / TG / 生日 / 性别 / 国籍-省-市-区 ───

type Profile = {
  id: number;
  username: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  nickname: string | null;
  avatar: string | null;
  bio: string | null;
  wechat: string | null;
  qq: string | null;
  telegram: string | null;
  birthday: string | null;
  gender: string | null;
  nationality: string | null;
  countryCode: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  address: string | null;
  postalCode: string | null;
  website: string | null;
  locale: string | null;
  timezone: string | null;
};

const GENDER_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "不公开" },
  { value: "male", label: "男" },
  { value: "female", label: "女" },
  { value: "other", label: "其他" },
  { value: "secret", label: "保密" },
];

const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500";
// 原生日期控件：统一深色渲染 + 最小高度（修复手机版样式错乱）
const dateCls = `${inputCls} min-h-[42px] [color-scheme:dark]`;

export default function ProfileSettings() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  // 表单字段
  const [nickname, setNickname] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [emailVerified, setEmailVerified] = useState(false);
  const [wechat, setWechat] = useState("");
  const [qq, setQq] = useState("");
  const [telegram, setTelegram] = useState("");
  const [birthday, setBirthday] = useState("");
  const [gender, setGender] = useState("");
  const [region, setRegion] = useState<RegionValue>({
    countryCode: "",
    province: "",
    city: "",
    district: "",
  });
  const [address, setAddress] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [website, setWebsite] = useState("");
  const [locale, setLocale] = useState("");
  const [timezone, setTimezone] = useState("");
  const [bio, setBio] = useState("");
  const [avatar, setAvatar] = useState("");

  // 头像编辑（自研裁剪）：点头像选图 → 缩放调整 → 保存上传
  const fileRef = useRef<HTMLInputElement>(null);
  const [editFile, setEditFile] = useState<File | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/user/profile");
        const d = await r.json();
        if (!r.ok) {
          setErr(d.error || "加载失败");
          return;
        }
        setProfile(d);
        setNickname(d.nickname || "");
        setPhone(d.phone || "");
        setEmail(d.email || "");
        setEmailVerified(!!d.emailVerified);
        setWechat(d.wechat || "");
        setQq(d.qq || "");
        setTelegram(d.telegram || "");
        setBirthday(d.birthday ? String(d.birthday).slice(0, 10) : "");
        setGender(d.gender || "");
        setRegion({
          countryCode: d.countryCode || "",
          province: d.province || "",
          city: d.city || "",
          district: d.district || "",
        });
        setAddress(d.address || "");
        setPostalCode(d.postalCode || "");
        setWebsite(d.website || "");
        setLocale(d.locale || "");
        setTimezone(d.timezone || "");
        setBio(d.bio || "");
        setAvatar(d.avatar || "");
      } catch {
        setErr("网络错误，请稍后重试");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErr("请选择图片文件");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setErr("头像仅支持图片且不能超过 20MB");
      return;
    }
    // 进入裁剪弹层（正方形取景 / 缩放）
    setEditFile(file);
  };

  // 裁剪保存：输出 512×512 webp 直接上传（大图由裁剪器自动 cover 适配）
  const onSaveBlob = async (blob: Blob) => {
    setEditFile(null);
    setUploading(true);
    setErr("");
    try {
      const form = new FormData();
      form.append("file", blob, "avatar.webp");
      const r = await fetch("/api/user/avatar/upload", { method: "POST", body: form });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || "头像上传失败");
        return;
      }
      setAvatar(d.url);
      setMsg("头像已更新 ✓");
      setTimeout(() => setMsg(""), 2000);
    } catch {
      setErr("头像上传失败，请重试");
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setErr("");
    setMsg("");
    try {
      const r = await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nickname: nickname.trim() || null,
          phone: phone.trim() || null,
          wechat: wechat.trim() || null,
          qq: qq.trim() || null,
          telegram: telegram.trim() || null,
          birthday: birthday || null,
          gender: gender || null,
          countryCode: region.countryCode || null,
          province: region.province || null,
          city: region.city || null,
          district: region.district || null,
          address: address.trim() || null,
          postalCode: postalCode.trim() || null,
          website: website.trim() || null,
          locale: locale || null,
          timezone: timezone || null,
          bio: bio.trim() || null,
          avatar: avatar || null,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "保存失败");
        return;
      }
      setMsg("已保存 ✓");
      setTimeout(() => setMsg(""), 2000);
    } catch {
      setErr("网络错误");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 text-center text-sm text-zinc-500">加载中…</div>;

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 className="mb-4 text-base font-semibold text-zinc-100">资料修改</h2>

      {/* 头像：点击即可更换 */}
      <div className="mb-5 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="修改头像"
          className="group relative h-[72px] w-[72px] shrink-0 overflow-hidden rounded-full ring-1 ring-zinc-700 transition hover:ring-emerald-500/70"
        >
          <UserAvatar src={avatar} name={nickname || profile?.username || ""} size={72} />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/55 text-xs text-white opacity-0 transition group-hover:opacity-100">
            修改头像
          </span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickFile} />
        <p className="text-xs text-zinc-500">点击头像更换就可以了</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm text-zinc-400">昵称</span>
          <input value={nickname} onChange={(e) => setNickname(e.target.value.slice(0, 30))} maxLength={30} className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-zinc-400">手机</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value.slice(0, 20))} placeholder="选填" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 flex items-center gap-2 text-sm text-zinc-400">
            邮箱
            {email && emailVerified && (
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs font-medium text-emerald-300">已验证</span>
            )}
          </span>
          {/* 邮箱注册后锁定不可修改 */}
          <input
            value={email}
            readOnly
            placeholder="选填"
            title="邮箱注册后不可修改"
            className={`${inputCls} cursor-not-allowed opacity-70`}
          />
          {email && !emailVerified && <span className="mt-1 block text-xs text-zinc-500">邮箱注册后不可修改</span>}
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-zinc-400">微信</span>
          <input value={wechat} onChange={(e) => setWechat(e.target.value.slice(0, 50))} placeholder="选填" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-zinc-400">QQ</span>
          <input value={qq} onChange={(e) => setQq(e.target.value.slice(0, 30))} placeholder="选填" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-zinc-400">Telegram</span>
          <input value={telegram} onChange={(e) => setTelegram(e.target.value.slice(0, 50))} placeholder="选填" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-zinc-400">生日</span>
          <input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} max={new Date().toISOString().slice(0, 10)} className={dateCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-zinc-400">性别</span>
          <select value={gender} onChange={(e) => setGender(e.target.value)} className={inputCls}>
            {GENDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-sm text-zinc-400">国家 / 省州 / 城市 / 区</span>
          <RegionCascade value={region} onChange={setRegion} />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-sm text-zinc-400">详细地址</span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value.slice(0, 200))}
            maxLength={200}
            placeholder="街道、门牌号等（选填）"
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-zinc-400">邮编</span>
          <input
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value.slice(0, 20))}
            maxLength={20}
            placeholder="选填"
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-zinc-400">个人网站</span>
          <input
            value={website}
            onChange={(e) => setWebsite(e.target.value.slice(0, 200))}
            maxLength={200}
            placeholder="https://（选填）"
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-zinc-400">语言偏好</span>
          <select value={locale} onChange={(e) => setLocale(e.target.value)} className={inputCls}>
            <option value="">未设置</option>
            {LOCALES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-zinc-400">时区</span>
          <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className={inputCls}>
            <option value="">未设置</option>
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="mt-4 block">
        <span className="mb-1 block text-sm text-zinc-400">简介</span>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value.slice(0, 500))}
          rows={3}
          maxLength={500}
          className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500"
        />
      </label>

      {err && <p className="mt-3 text-sm text-rose-400">{err}</p>}
      {msg && <p className="mt-3 text-sm text-emerald-400">{msg}</p>}

      <button
        onClick={save}
        disabled={saving}
        className="mt-4 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
      >
        {saving ? "保存中…" : "保存资料"}
      </button>

      {/* 头像裁剪弹层（自研：正方形取景 / 拖动 / 缩放 / 双指捏合） */}
      {editFile && (
        <AvatarCropper
          file={editFile}
          onCancel={() => setEditFile(null)}
          onSaved={onSaveBlob}
        />
      )}
      {uploading && <div className="mt-2 text-xs text-zinc-500">头像上传中…</div>}
    </div>
  );
}
