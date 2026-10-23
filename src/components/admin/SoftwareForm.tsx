"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ADMIN_BASE } from "@/lib/admin-path";
import RichEditor from "@/components/RichEditor";

type Cat = { id: number; name: string };
type Bucket = { id: number; name: string; isDefault: boolean };
export type DownloadEntry = {
  label: string; storageType: "local" | "bucket";
  fileUrl: string; bucketId: number | 0; objectKey: string;
  sizeBytes: number | null; memberOnly: boolean; sort: number;
};

export type SoftwareFormData = {
  id?: number;
  slug: string; name: string; version: string; tagline: string; description: string;
  icon: string; categoryId: number; tags: string[];
  sizeText: string; platform: string; language: string; officialUrl: string;
  status: string;
  viewCount: number; downloadCount: number; commentCount: number;
  publishedAt: string; // datetime-local 格式或 ""
  downloads: DownloadEntry[];
};

const inputCls = "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500";
const labelCls = "mb-1 block text-xs text-zinc-400";
const PLATFORMS = ["Windows", "macOS", "Linux", "Android", "iOS"];

const emptyDl = (sort: number, defaultBucket: number): DownloadEntry => ({
  label: "", storageType: "local", fileUrl: "", bucketId: defaultBucket, objectKey: "",
  sizeBytes: null, memberOnly: false, sort,
});

export default function SoftwareForm({
  cats, buckets, initial,
}: {
  cats: Cat[]; buckets: Bucket[]; initial: SoftwareFormData;
}) {
  const router = useRouter();
  const [f, setF] = useState<SoftwareFormData>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [upProg, setUpProg] = useState<Record<number, number>>({});
  const [iconUpProg, setIconUpProg] = useState<number | null>(null);
  const [tagInput, setTagInput] = useState("");
  const fileRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const iconRef = useRef<HTMLInputElement | null>(null);
  const editing = !!initial.id;
  const defaultBucket = buckets.find((b) => b.isDefault)?.id || buckets[0]?.id || 0;

  const set = <K extends keyof SoftwareFormData>(k: K, v: SoftwareFormData[K]) => setF((p) => ({ ...p, [k]: v }));
  const flash = (kind: "ok" | "err", text: string) => { setMsg({ kind, text }); if (kind === "ok") setTimeout(() => setMsg(null), 3000); };

  const setDl = <K extends keyof DownloadEntry>(i: number, k: K, v: DownloadEntry[K]) =>
    setF((p) => { const downloads = [...p.downloads]; downloads[i] = { ...downloads[i], [k]: v }; return { ...p, downloads }; });

  const clearProg = (i: number) => setUpProg((p) => { const n = { ...p }; delete n[i]; return n; });

  // XHR 上传（带进度），统一走本站接口（服务端中转），不依赖桶 CORS
  const xhrUpload = (progKey: number | "icon", method: string, url: string, body: FormData) =>
    new Promise<any>((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      const setProg = (v: number | null) => {
        if (progKey === "icon") setIconUpProg(v);
        else if (v === null) clearProg(progKey);
        else setUpProg((p) => ({ ...p, [progKey]: v }));
      };
      x.upload.onprogress = (e) => {
        if (e.lengthComputable) setProg(Math.round((e.loaded / e.total) * 100));
      };
      x.onload = () => {
        setProg(null);
        if (x.status >= 200 && x.status < 300) {
          try { resolve(x.responseText ? JSON.parse(x.responseText) : {}); } catch { resolve({}); }
        } else {
          let m = `HTTP ${x.status}`;
          try { m = JSON.parse(x.responseText).error || m; } catch {}
          reject(new Error(m));
        }
      };
      x.onerror = () => { setProg(null); reject(new Error("网络错误")); };
      x.send(body as any);
    });

  const uploadFile = async (i: number, file: File) => {
    const dl = f.downloads[i];
    if (!dl) return;
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (dl.storageType === "local") {
        const d = await xhrUpload(i, "POST", "/api/admin/software/upload", fd);
        setDl(i, "fileUrl", d.url);
        setDl(i, "sizeBytes", d.size ?? file.size);
      } else {
        const bid = dl.bucketId || defaultBucket;
        if (!bid) { flash("err", "尚未配置存储桶，请先在「存储桶」页添加"); return; }
        if (!dl.bucketId) setDl(i, "bucketId", bid);
        fd.append("bucketId", String(bid));
        const d = await xhrUpload(i, "POST", "/api/admin/software/upload-bucket", fd);
        setDl(i, "objectKey", d.objectKey);
        setDl(i, "sizeBytes", d.size ?? file.size);
      }
      if (!dl.label.trim()) setDl(i, "label", file.name);
      flash("ok", `已上传：${file.name}`);
    } catch (e) {
      flash("err", (e as Error).message);
    }
  };

  // 图标上传：复用本站接口（图片扩展名已放行），保存时仍会过外链本地化
  const uploadIcon = async (file: File) => {
    try {
      const fd = new FormData();
      fd.append("file", file);
      const d = await xhrUpload("icon", "POST", "/api/admin/software/upload", fd);
      set("icon", d.url);
      flash("ok", "图标已上传");
    } catch (e) {
      flash("err", (e as Error).message);
    }
  };

  // 标签：胶囊增删
  const addTag = (raw?: string) => {
    const v = (raw ?? tagInput).trim().replace(/^#/, "");
    if (!v) return;
    setF((p) => (p.tags.includes(v) || p.tags.length >= 8 ? p : { ...p, tags: [...p.tags, v] }));
    setTagInput("");
  };
  const removeTag = (t: string) => setF((p) => ({ ...p, tags: p.tags.filter((x) => x !== t) }));

  // 支持平台多选：切换 token 并保留列表外旧值（如 Web）
  const togglePlatform = (p: string) => {
    const tokens = f.platform.split(/[\/,，]/).map((s) => s.trim()).filter(Boolean);
    const has = tokens.some((x) => x.toLowerCase() === p.toLowerCase());
    let next = tokens.filter((x) => x.toLowerCase() !== p.toLowerCase());
    if (!has) next = [...next, p];
    next.sort((a, b) => {
      const ia = PLATFORMS.findIndex((x) => x.toLowerCase() === a.toLowerCase());
      const ib = PLATFORMS.findIndex((x) => x.toLowerCase() === b.toLowerCase());
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    set("platform", next.join(" / "));
  };

  // 自动获取标签：从名称/简介/官网/平台提取候选关键词
  const autoTags = () => {
    const text = `${f.name} ${f.tagline} ${f.officialUrl} ${f.platform}`.toLowerCase();
    const dict: [RegExp, string][] = [
      [/mac|macos|darwin/, "mac"], [/win(dows)?/, "windows"], [/linux/, "linux"],
      [/ios|iphone|ipad/, "iOS"], [/android|apk/, "Android"], [/web|浏览器|在线/, "Web"],
      [/chrome|edge|extension|插件/, "浏览器插件"], [/开源|open[- ]?source|github/, "开源"],
      [/免费|free/, "免费"], [/付费|pro|premium/, "付费"],
      [/cli|命令行|terminal/, "CLI"], [/桌面|desktop|客户端|client/, "客户端"],
      [/ai|gpt|claude|llm|大模型/, "AI"], [/绘图|绘画|image|画/, "AI绘图"],
      [/视频|video|剪辑/, "视频"], [/音频|audio|音乐|music/, "音频"],
      [/写作|writing|文案/, "写作"], [/翻译|translat/, "翻译"], [/办公|office|文档/, "办公"],
      [/效率|productivity|工具|tool/, "效率工具"], [/开发|dev|代码|code|编程/, "开发工具"],
      [/聊天|chat|对话/, "聊天"], [/知识库|笔记|note/, "知识管理"], [/自动化|automation|workflow/, "自动化"],
    ];
    const picked: string[] = [];
    for (const [re, tag] of dict) {
      if (re.test(text) && !f.tags.includes(tag) && !picked.includes(tag)) picked.push(tag);
      if (f.tags.length + picked.length >= 8) break;
    }
    if (picked.length === 0) { flash("err", "未能从现有内容提取到标签，请先填名称/简介/平台"); return; }
    setF((p) => ({ ...p, tags: [...p.tags, ...picked].slice(0, 8) }));
    flash("ok", `已添加：${picked.join("、")}`);
  };

  const submit = async () => {
    if (!f.name.trim() || !f.description.trim()) {
      flash("err", "名称/详细介绍均为必填");
      return;
    }
    if (!f.categoryId) {
      flash("err", "请选择分类");
      return;
    }
    for (const dl of f.downloads) {
      if (!dl.label.trim()) { flash("err", "下载条目标题不能为空"); return; }
      if (dl.storageType === "local" && !dl.fileUrl.trim()) { flash("err", `下载「${dl.label}」需填本站文件路径`); return; }
      if (dl.storageType === "bucket" && (!dl.bucketId || !dl.objectKey.trim())) { flash("err", `下载「${dl.label}」需选桶并填对象 Key`); return; }
    }
    setBusy(true);
    try {
      const payload: any = {
        slug: f.slug.trim(),
        name: f.name.trim(),
        version: f.version.trim() || null,
        tagline: f.tagline.trim() || null,
        description: f.description,
        icon: f.icon.trim() || null,
        categoryId: f.categoryId,
        tags: f.tags,
        sizeText: f.sizeText.trim() || null,
        platform: f.platform.trim() || null,
        language: f.language.trim() || null,
        officialUrl: f.officialUrl.trim() || null,
        status: f.status,
        viewCount: f.viewCount, downloadCount: f.downloadCount, commentCount: f.commentCount,
        publishedAt: f.publishedAt ? new Date(f.publishedAt).toISOString() : null,
        downloads: f.downloads.map((dl, i) => ({
          label: dl.label.trim(),
          storageType: dl.storageType,
          fileUrl: dl.storageType === "local" ? dl.fileUrl.trim() : null,
          bucketId: dl.storageType === "bucket" ? dl.bucketId : null,
          objectKey: dl.storageType === "bucket" ? dl.objectKey.trim() : null,
          sizeBytes: dl.sizeBytes,
          memberOnly: dl.memberOnly,
          sort: i,
        })),
      };
      const r = editing
        ? await fetch(`/api/admin/software/${initial.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/admin/software", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "保存失败");
      flash("ok", "已保存");
      setTimeout(() => router.push(`${ADMIN_BASE}/software`), 600);
    } catch (e) {
      flash("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {msg && (
        <div className={`mb-3 rounded-lg px-3 py-2 text-sm ${msg.kind === "ok" ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}>
          {msg.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <label className={labelCls}>软件名称 *</label>
          <input value={f.name} onChange={(e) => set("name", e.target.value)} className={inputCls} placeholder="如：ChatWise" />
        </div>
        <div>
          <label className={labelCls}>slug（URL 用，留空自动生成）</label>
          <input value={f.slug} onChange={(e) => set("slug", e.target.value)} className={inputCls} placeholder="chatwise" />
        </div>
        <div>
          <label className={labelCls}>一句话简介（列表卡片用）</label>
          <input value={f.tagline} onChange={(e) => set("tagline", e.target.value)} className={inputCls} placeholder="桌面端多模型 AI 聊天客户端" />
        </div>
        <div>
          <label className={labelCls}>图标（外链自动本地化，或 /uploads 站内路径）</label>
          <div className="flex items-center gap-2">
            {f.icon && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={f.icon} alt="" className="h-9 w-9 shrink-0 rounded-lg border border-zinc-800 object-cover" />
            )}
            <input value={f.icon} onChange={(e) => set("icon", e.target.value)} className={inputCls} placeholder="https://…/icon.png" />
            <input
              type="file"
              accept=".jpg,.jpeg,.png,.webp,.gif"
              className="hidden"
              ref={iconRef}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadIcon(file);
                e.target.value = "";
              }}
            />
            {iconUpProg !== null ? (
              <span className="shrink-0 text-xs text-emerald-300">{iconUpProg}%</span>
            ) : (
              <button
                type="button"
                onClick={() => iconRef.current?.click()}
                className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-2 text-xs text-zinc-300 transition hover:border-emerald-600 hover:text-emerald-300"
              >
                上传
              </button>
            )}
          </div>
        </div>
        <div className="lg:col-span-2">
          <label className={labelCls}>详细介绍 *（富文本）</label>
          <RichEditor value={f.description} onChange={(html) => set("description", html)} />
        </div>

        {/* 下载条目编辑器 */}
        <div className="lg:col-span-2">
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs text-zinc-400">下载地址（可多条，如官方版/免安装版/网盘镜像）</label>
            <button type="button" onClick={() => set("downloads", [...f.downloads, emptyDl(f.downloads.length, defaultBucket)])} className="text-xs text-emerald-400 hover:underline">+ 添加下载</button>
          </div>
          {f.downloads.length === 0 && <p className="text-xs text-zinc-600">至少添加一条下载地址，前台才会显示下载按钮</p>}
          {f.downloads.map((dl, i) => (
            <div key={i} className="mb-2 rounded-lg border border-zinc-800 p-3">
              <div className="grid grid-cols-1 gap-2 md:grid-cols-12">
                <input value={dl.label} onChange={(e) => setDl(i, "label", e.target.value)} className={`${inputCls} md:col-span-2`} placeholder="标题，如 官方原版 dmg" />
                <select value={dl.storageType} onChange={(e) => setDl(i, "storageType", e.target.value as "local" | "bucket")} className={`${inputCls} md:col-span-2`}>
                  <option value="local">本站文件</option>
                  <option value="bucket">对象存储</option>
                </select>
                {dl.storageType === "local" ? (
                  <input value={dl.fileUrl} onChange={(e) => setDl(i, "fileUrl", e.target.value)} className={`${inputCls} md:col-span-4`} placeholder="/uploads/soft/xxx.zip" />
                ) : (
                  <>
                    <select value={dl.bucketId || ""} onChange={(e) => setDl(i, "bucketId", Number(e.target.value))} className={`${inputCls} md:col-span-2`}>
                      <option value="" disabled>选择桶</option>
                      {buckets.map((b) => <option key={b.id} value={b.id}>{b.name}{b.isDefault ? "（默认）" : ""}</option>)}
                    </select>
                    <input value={dl.objectKey} onChange={(e) => setDl(i, "objectKey", e.target.value)} className={`${inputCls} md:col-span-2`} placeholder="对象 Key，如 soft/xxx.zip" />
                  </>
                )}
                <div className="flex items-center gap-2 md:col-span-2">
                  <input
                    type="file"
                    className="hidden"
                    ref={(el) => { fileRefs.current[i] = el; }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) uploadFile(i, file);
                      e.target.value = "";
                    }}
                  />
                  {upProg[i] !== undefined ? (
                    <div className="w-full max-w-[110px]">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                        <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${upProg[i]}%` }} />
                      </div>
                      <div className="mt-0.5 text-center text-[10px] text-emerald-300">{upProg[i]}%</div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => fileRefs.current[i]?.click()}
                      className="shrink-0 rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 transition hover:border-emerald-600 hover:text-emerald-300"
                    >
                      上传文件
                    </button>
                  )}
                  {dl.sizeBytes ? (
                    <span className="shrink-0 text-[10px] text-zinc-600">
                      {dl.sizeBytes >= 1048576 ? `${(dl.sizeBytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(dl.sizeBytes / 1024))} KB`}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-3 md:col-span-2">
                  <label className="flex items-center gap-1 text-xs text-zinc-400">
                    <input type="checkbox" checked={dl.memberOnly} onChange={(e) => setDl(i, "memberOnly", e.target.checked)} />
                    会员限定
                  </label>
                  <button type="button" onClick={() => set("downloads", f.downloads.filter((_, j) => j !== i))} className="shrink-0 text-rose-400 hover:underline">移除</button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div>
          <label className={labelCls}>分类 *</label>
          <select value={f.categoryId || ""} onChange={(e) => set("categoryId", Number(e.target.value))} className={inputCls}>
            <option value="" disabled>选择分类</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 flex items-center justify-between text-xs text-zinc-400">
            <span>标签（回车添加，最多 8 个）</span>
            <button type="button" onClick={autoTags} className="text-emerald-400 hover:underline">✨ 自动获取</button>
          </label>
          <div className={`${inputCls} flex flex-wrap items-center gap-1.5 py-1.5`}>
            {f.tags.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">
                #{t}
                <button type="button" onClick={() => removeTag(t)} className="text-emerald-500 hover:text-rose-400">×</button>
              </span>
            ))}
            <input
              value={tagInput}
              onChange={(e) => {
                const v = e.target.value;
                // 输入逗号/中文逗号即把前面内容收为一个标签
                if (/[,，]$/.test(v)) { addTag(v.slice(0, -1)); } else { setTagInput(v); }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); addTag(); }
                else if (e.key === "Backspace" && !tagInput && f.tags.length) { removeTag(f.tags[f.tags.length - 1]); }
              }}
              onBlur={() => addTag()}
              className="min-w-[90px] flex-1 bg-transparent text-sm outline-none"
              placeholder={f.tags.length ? "" : "输入后回车"}
            />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>版本</label>
            <input value={f.version} onChange={(e) => set("version", e.target.value)} className={inputCls} placeholder="2.1.0" />
          </div>
          <div>
            <label className={labelCls}>体积（展示文本）</label>
            <input value={f.sizeText} onChange={(e) => set("sizeText", e.target.value)} className={inputCls} placeholder="86 MB" />
          </div>
          <div>
            <label className={labelCls}>界面语言</label>
            <input value={f.language} onChange={(e) => set("language", e.target.value)} className={inputCls} placeholder="中文/英文" />
          </div>
        </div>
        <div>
          <label className={labelCls}>支持平台（多选）</label>
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2">
            {PLATFORMS.map((p) => {
              const on = f.platform.split(/[\/,，]/).map((s) => s.trim().toLowerCase()).includes(p.toLowerCase());
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => togglePlatform(p)}
                  className={`rounded-lg px-2.5 py-1 text-xs transition ${on ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500" : "bg-zinc-800/70 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"}`}
                >
                  {on ? "✓ " : ""}{p}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <label className={labelCls}>官网链接</label>
          <input value={f.officialUrl} onChange={(e) => set("officialUrl", e.target.value)} className={inputCls} placeholder="https://…" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>状态</label>
            <select value={f.status} onChange={(e) => set("status", e.target.value)} className={inputCls}>
              <option value="published">发布</option>
              <option value="pending">待审</option>
              <option value="rejected">拒绝</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>发布时间（留空=首次发布时自动填）</label>
            <input type="datetime-local" value={f.publishedAt} onChange={(e) => set("publishedAt", e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>浏览量</label>
            <input type="number" min={0} value={f.viewCount} onChange={(e) => set("viewCount", Math.max(0, parseInt(e.target.value) || 0))} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>下载数</label>
            <input type="number" min={0} value={f.downloadCount} onChange={(e) => set("downloadCount", Math.max(0, parseInt(e.target.value) || 0))} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>评论数</label>
            <input type="number" min={0} value={f.commentCount} onChange={(e) => set("commentCount", Math.max(0, parseInt(e.target.value) || 0))} className={inputCls} />
          </div>
        </div>
      </div>

      <div className="mt-5 flex gap-2">
        <button type="button" onClick={submit} disabled={busy} className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
          {busy ? "保存中…" : editing ? "保存修改" : "创建软件"}
        </button>
        <button type="button" onClick={() => router.push(`${ADMIN_BASE}/software`)} className="rounded-lg border border-zinc-700 px-5 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
          返回列表
        </button>
      </div>
    </div>
  );
}
