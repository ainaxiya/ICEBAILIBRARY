"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import UserAvatar from "@/components/UserAvatar";

// 头像编辑插件（React Photo Editor）：缩放 / 旋转 / 翻转，保存后自动中心方裁
const ReactPhotoEditor = dynamic(
  () => import("react-photo-editor").then((m) => m.ReactPhotoEditor),
  { ssr: false }
);

// ─── v0.92 #9 资料修改：头像上传（前端裁剪）/ 昵称 / 手机 / 邮箱 / 微信 / QQ / TG / 生日 / 性别 / 国籍 ───

type Profile = {
  id: number;
  username: string;
  email: string | null;
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

const OUT = 512; // 头像输出尺寸（编辑器保存后中心方裁为 512×512）

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
  const [wechat, setWechat] = useState("");
  const [qq, setQq] = useState("");
  const [telegram, setTelegram] = useState("");
  const [birthday, setBirthday] = useState("");
  const [gender, setGender] = useState("");
  const [nationality, setNationality] = useState("");
  const [bio, setBio] = useState("");
  const [avatar, setAvatar] = useState("");

  // 头像编辑（React Photo Editor 插件）：点头像选图 → 缩放/旋转/翻转 → 保存
  const fileRef = useRef<HTMLInputElement>(null);
  const [editFile, setEditFile] = useState<File | null>(null);
  const [editOpen, setEditOpen] = useState(false);

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
        setWechat(d.wechat || "");
        setQq(d.qq || "");
        setTelegram(d.telegram || "");
        setBirthday(d.birthday ? String(d.birthday).slice(0, 10) : "");
        setGender(d.gender || "");
        setNationality(d.nationality || "");
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
    if (file.size > 5 * 1024 * 1024) {
      setErr("头像仅支持图片且不能超过 5MB");
      return;
    }
    // 进入 Photo Editor 弹层（缩放 / 旋转 / 翻转）
    setEditFile(file);
    setEditOpen(true);
  };

  // 编辑器保存：输出图中心方裁为 512×512 webp 后上传
  const onSaveEdited = async (file: File) => {
    setEditOpen(false);
    setEditFile(null);
    setUploading(true);
    setErr("");
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const el = new Image();
        el.onload = () => res(el);
        el.onerror = () => rej(new Error("img"));
        el.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = OUT;
      canvas.height = OUT;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas");
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - side) / 2;
      const sy = (img.naturalHeight - side) / 2;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, OUT, OUT);
      URL.revokeObjectURL(url);
      const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/webp", 0.9));
      if (!blob) throw new Error("blob");
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
      setErr("头像处理失败，请重试");
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
          email: email.trim() || null,
          wechat: wechat.trim() || null,
          qq: qq.trim() || null,
          telegram: telegram.trim() || null,
          birthday: birthday || null,
          gender: gender || null,
          nationality: nationality.trim() || null,
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

      {/* 头像：点击即改（悬停显示「修改头像」），编辑走 Photo Editor 插件，无移除 */}
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
        <p className="text-xs text-zinc-500">点击头像更换，支持缩放 / 旋转 / 翻转编辑</p>
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
          <span className="mb-1 block text-sm text-zinc-400">邮箱</span>
          <input value={email} onChange={(e) => setEmail(e.target.value.slice(0, 100))} placeholder="选填" className={inputCls} />
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
          <input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} max={new Date().toISOString().slice(0, 10)} className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-zinc-400">性别</span>
          <select value={gender} onChange={(e) => setGender(e.target.value)} className={inputCls}>
            {GENDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-zinc-400">国籍</span>
          <input value={nationality} onChange={(e) => setNationality(e.target.value.slice(0, 50))} placeholder="选填" className={inputCls} />
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

      {/* 头像编辑弹层（React Photo Editor 插件） */}
      {editFile && (
        <ReactPhotoEditor
          file={editFile}
          open={editOpen}
          onClose={() => {
            setEditOpen(false);
            setEditFile(null);
          }}
          onSaveImage={onSaveEdited}
          allowColorEditing={false}
          allowDrawing={false}
          allowRotate
          allowFlip
          allowZoom
          downloadOnSave={false}
          modalHeight="34rem"
          modalWidth="34rem"
          labels={{
            close: "关闭",
            save: "保存头像",
            rotate: "旋转",
            brightness: "亮度",
            contrast: "对比度",
            saturate: "饱和度",
            grayscale: "灰度",
            reset: "重置",
            flipHorizontal: "水平翻转",
            flipVertical: "垂直翻转",
            zoomIn: "放大",
            zoomOut: "缩小",
            draw: "画笔",
            brushColor: "画笔颜色",
            brushWidth: "画笔粗细",
          }}
        />
      )}
    </div>
  );
}
