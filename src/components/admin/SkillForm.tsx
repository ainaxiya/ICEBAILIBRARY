"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ADMIN_BASE } from "@/lib/admin-path";

type Cat = { id: number; name: string };
type FileEntry = { path: string; content: string };

export type SkillFormData = {
  id?: number;
  slug: string; name: string; summary: string; skillMd: string;
  files: FileEntry[];
  categoryId: number; tags: string[];
  author: string; sourceUrl: string; sourceSite: string;
  version: string; license: string; language: string; status: string;
  viewCount: number; copyCount: number; downloadCount: number; commentCount: number;
  publishedAt: string; // datetime-local 格式或 ""
};

const inputCls = "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500";
const labelCls = "mb-1 block text-xs text-zinc-400";

export default function SkillForm({ cats, initial }: { cats: Cat[]; initial: SkillFormData }) {
  const router = useRouter();
  const [f, setF] = useState<SkillFormData>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [tagInput, setTagInput] = useState("");
  const editing = !!initial.id;

  const set = <K extends keyof SkillFormData>(k: K, v: SkillFormData[K]) => setF((p) => ({ ...p, [k]: v }));
  const flash = (kind: "ok" | "err", text: string) => { setMsg({ kind, text }); if (kind === "ok") setTimeout(() => setMsg(null), 3000); };

  // 标签胶囊：回车/逗号/失焦添加，Backspace 删尾
  const addTag = (raw: string) => {
    const v = raw.trim().replace(/[,，]$/, "").trim();
    if (!v) return;
    setF((p) => (p.tags.includes(v) || p.tags.length >= 8 ? p : { ...p, tags: [...p.tags, v] }));
    setTagInput("");
  };
  const removeTag = (t: string) => setF((p) => ({ ...p, tags: p.tags.filter((x) => x !== t) }));

  const setFile = (i: number, k: keyof FileEntry, v: string) =>
    setF((p) => { const files = [...p.files]; files[i] = { ...files[i], [k]: v }; return { ...p, files }; });

  const submit = async () => {
    if (!f.name.trim() || !f.summary.trim() || !f.skillMd.trim()) {
      flash("err", "名称/简介/SKILL.md 均为必填");
      return;
    }
    if (!f.categoryId) {
      flash("err", "请选择分类");
      return;
    }
    setBusy(true);
    try {
      const payload: any = {
        slug: f.slug.trim(),
        name: f.name.trim(),
        summary: f.summary.trim(),
        skillMd: f.skillMd,
        files: f.files.filter((x) => x.path.trim() && x.content.trim()).map((x) => ({ path: x.path.trim(), content: x.content })),
        categoryId: f.categoryId,
        tags: f.tags,
        author: f.author.trim() || null,
        sourceUrl: f.sourceUrl.trim() || null,
        sourceSite: f.sourceSite.trim() || null,
        version: f.version.trim() || null,
        license: f.license.trim() || null,
        language: f.language || "zh",
        status: f.status,
        viewCount: f.viewCount, copyCount: f.copyCount, downloadCount: f.downloadCount, commentCount: f.commentCount,
        publishedAt: f.publishedAt ? new Date(f.publishedAt).toISOString() : null,
      };
      const r = editing
        ? await fetch(`/api/admin/skills/${initial.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/admin/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "保存失败");
      flash("ok", "已保存");
      setTimeout(() => router.push(`${ADMIN_BASE}/skills`), 600);
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
          <label className={labelCls}>名称 *</label>
          <input value={f.name} onChange={(e) => set("name", e.target.value)} className={inputCls} placeholder="如：amazon-ads-optimizer" />
        </div>
        <div>
          <label className={labelCls}>slug（URL 用，留空自动生成，可重复）</label>
          <input value={f.slug} onChange={(e) => set("slug", e.target.value)} className={inputCls} placeholder="amazon-ads-optimizer" />
        </div>
        <div className="lg:col-span-2">
          <label className={labelCls}>简介 / 触发语（Use when…）*</label>
          <textarea value={f.summary} onChange={(e) => set("summary", e.target.value)} rows={2} className={inputCls} placeholder="Use when optimizing Amazon Ads accounts…" />
        </div>
        <div className="lg:col-span-2">
          <label className={labelCls}>SKILL.md 完整内容 *</label>
          <textarea value={f.skillMd} onChange={(e) => set("skillMd", e.target.value)} rows={16} className={`${inputCls} font-mono text-xs`} placeholder="# Skill Name&#10;&#10;## Instructions…" />
        </div>

        {/* files 行编辑器 */}
        <div className="lg:col-span-2">
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs text-zinc-400">附加文件（可选，随下载打包）</label>
            <button type="button" onClick={() => set("files", [...f.files, { path: "", content: "" }])} className="text-xs text-emerald-400 hover:underline">+ 添加文件</button>
          </div>
          {f.files.length === 0 && <p className="text-xs text-zinc-600">无附加文件时，下载按钮直接输出 SKILL.md</p>}
          {f.files.map((file, i) => (
            <div key={i} className="mb-2 rounded-lg border border-zinc-800 p-2.5">
              <div className="mb-1.5 flex items-center gap-2">
                <input value={file.path} onChange={(e) => setFile(i, "path", e.target.value)} className={inputCls} placeholder="路径，如 scripts/run.py" />
                <button type="button" onClick={() => set("files", f.files.filter((_, j) => j !== i))} className="shrink-0 text-rose-400 hover:underline">移除</button>
              </div>
              <textarea value={file.content} onChange={(e) => setFile(i, "content", e.target.value)} rows={4} className={`${inputCls} font-mono text-xs`} placeholder="文件内容" />
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
          <label className={labelCls}>标签（回车或逗号添加，最多 8 个）</label>
          <div className={`${inputCls} flex flex-wrap items-center gap-1.5`}>
            {f.tags.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300">
                {t}
                <button type="button" onClick={() => removeTag(t)} className="text-emerald-400/70 hover:text-emerald-200">×</button>
              </span>
            ))}
            <input
              value={tagInput}
              onChange={(e) => {
                const v = e.target.value;
                if (/[,，]$/.test(v)) addTag(v);
                else setTagInput(v);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); addTag(tagInput); }
                else if (e.key === "Backspace" && !tagInput && f.tags.length) removeTag(f.tags[f.tags.length - 1]);
              }}
              onBlur={() => addTag(tagInput)}
              className="min-w-[80px] flex-1 bg-transparent text-sm outline-none"
              placeholder={f.tags.length ? "" : "ai-agents, node, api"}
            />
          </div>
        </div>
        <div>
          <label className={labelCls}>作者</label>
          <input value={f.author} onChange={(e) => set("author", e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>来源站点</label>
          <input value={f.sourceSite} onChange={(e) => set("sourceSite", e.target.value)} className={inputCls} placeholder="GitHub / skillsdirectory" />
        </div>
        <div>
          <label className={labelCls}>来源链接</label>
          <input value={f.sourceUrl} onChange={(e) => set("sourceUrl", e.target.value)} className={inputCls} placeholder="https://github.com/…" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>版本</label>
            <input value={f.version} onChange={(e) => set("version", e.target.value)} className={inputCls} placeholder="1.0.0" />
          </div>
          <div>
            <label className={labelCls}>License</label>
            <input value={f.license} onChange={(e) => set("license", e.target.value)} className={inputCls} placeholder="MIT" />
          </div>
          <div>
            <label className={labelCls}>语言</label>
            <select value={f.language} onChange={(e) => set("language", e.target.value)} className={inputCls}>
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>
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
        <div className="grid grid-cols-4 gap-3">
          <div>
            <label className={labelCls}>浏览量</label>
            <input type="number" min={0} value={f.viewCount} onChange={(e) => set("viewCount", Math.max(0, parseInt(e.target.value) || 0))} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>复制数</label>
            <input type="number" min={0} value={f.copyCount} onChange={(e) => set("copyCount", Math.max(0, parseInt(e.target.value) || 0))} className={inputCls} />
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
          {busy ? "保存中…" : editing ? "保存修改" : "创建技能"}
        </button>
        <button type="button" onClick={() => router.push(`${ADMIN_BASE}/skills`)} className="rounded-lg border border-zinc-700 px-5 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
          返回列表
        </button>
      </div>
    </div>
  );
}
