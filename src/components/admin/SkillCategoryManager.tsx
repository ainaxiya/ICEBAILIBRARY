"use client";

import { useState } from "react";
import IconPicker from "./IconPicker";

type Cat = {
  id: number;
  name: string;
  nameEn: string;
  slug: string;
  icon: string;
  sort: number;
  skillCount?: number;
  metaDescription?: string | null;
  metaKeywords?: string | null;
};

export default function SkillCategoryManager({ initial }: { initial: Cat[] }) {
  const [cats, setCats] = useState<Cat[]>(initial);
  const [editing, setEditing] = useState<Cat | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [slug, setSlug] = useState("");
  const [icon, setIcon] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [metaKeywords, setMetaKeywords] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const flash = (kind: "ok" | "err", text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 3000);
  };

  // 从英文名自动建议 2 字母短码
  const suggestSlug = (en: string) => {
    const parts = en.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return parts[0][0] + parts[1][0];
    if (parts[0]?.length >= 2) return parts[0].slice(0, 2);
    return "";
  };

  const openCreate = () => { setEditing(null); setName(""); setNameEn(""); setSlug(""); setIcon(""); setMetaDescription(""); setMetaKeywords(""); setShowForm(true); };
  const openEdit = (c: Cat) => { setEditing(c); setName(c.name); setNameEn(c.nameEn); setSlug(c.slug); setIcon(c.icon || ""); setMetaDescription(c.metaDescription || ""); setMetaKeywords(c.metaKeywords || ""); setShowForm(true); };

  const submit = async () => {
    if (!name.trim() || !slug.trim()) { flash("err", "名称与短码均为必填"); return; }
    setBusy(true);
    try {
      const metaPayload = { metaDescription: metaDescription.trim(), metaKeywords: metaKeywords.trim() };
      if (editing) {
        const r = await fetch(`/api/admin/skill-categories/${editing.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), nameEn: nameEn.trim(), slug: slug.trim(), icon: icon.trim(), ...metaPayload }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "保存失败");
        setCats((prev) => prev.map((c) => c.id === editing.id ? { ...c, name: name.trim(), nameEn: nameEn.trim() || name.trim(), slug: slug.trim(), icon: icon.trim(), ...metaPayload } : c));
        flash("ok", "已更新");
      } else {
        const r = await fetch("/api/admin/skill-categories", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), nameEn: nameEn.trim(), slug: slug.trim(), icon: icon.trim(), ...metaPayload }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "创建失败");
        setCats((prev) => [...prev, { ...d, skillCount: 0 }]);
        flash("ok", "已创建");
      }
      setShowForm(false);
    } catch (e) {
      flash("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: Cat) => {
    if (!confirm(`确定删除分类「${c.name}」吗？\n若该分类下还有技能将无法删除。`)) return;
    try {
      const r = await fetch(`/api/admin/skill-categories/${c.id}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "删除失败");
      setCats((prev) => prev.filter((x) => x.id !== c.id));
      flash("ok", "已删除");
    } catch (e) {
      flash("err", (e as Error).message);
    }
  };

  const move = async (idx: number, dir: -1 | 1) => {
    const next = [...cats];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    const reordered = next.map((c, i) => ({ ...c, sort: i }));
    setCats(reordered);
    try {
      await fetch("/api/admin/skill-categories", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: reordered.map((c) => c.id) }),
      });
    } catch {
      setCats(cats);
      flash("err", "排序保存失败");
    }
  };

  const inputCls = "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500";

  return (
    <div>
      {msg && (
        <div className={`mb-3 rounded-lg px-3 py-2 text-sm ${msg.kind === "ok" ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}>
          {msg.text}
        </div>
      )}

      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-zinc-400">共 {cats.length} 个分类</p>
        <button type="button" onClick={openCreate} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500">
          + 新增分类
        </button>
      </div>

      {showForm && (
        <div className="mb-5 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="mb-3 text-sm font-medium">{editing ? "编辑分类" : "新增分类"}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">图标</label>
              <IconPicker value={icon} onChange={setIcon} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">中文名称 *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="如：智能体" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">英文名称</label>
              <input
                value={nameEn}
                onChange={(e) => {
                  setNameEn(e.target.value);
                  if (!editing && !slug) setSlug(suggestSlug(e.target.value));
                }}
                className={inputCls}
                placeholder="如：AI Agents"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">短码（2 小写字母）*</label>
              <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} maxLength={2} className={inputCls} placeholder="zn" />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">栏目描述（SEO description，留空用默认文案）</label>
              <textarea
                value={metaDescription}
                onChange={(e) => setMetaDescription(e.target.value.slice(0, 500))}
                rows={2}
                maxLength={500}
                className={inputCls}
                placeholder="如：智能体搭建技能合集：让 AI 自动执行任务、编排工作流的完整 SKILL 模板"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">栏目关键字（SEO keywords，逗号分隔，留空用默认）</label>
              <input
                value={metaKeywords}
                onChange={(e) => setMetaKeywords(e.target.value.slice(0, 300))}
                className={inputCls}
                placeholder="如：智能体技能,AI agent,工作流自动化,SKILL 模板"
              />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={submit} disabled={busy} className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50">
              {busy ? "保存中…" : "保存"}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">
              取消
            </button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <th className="px-4 py-3 w-16">排序</th>
              <th className="px-4 py-3 w-14">图标</th>
              <th className="px-4 py-3">中文名称</th>
              <th className="px-4 py-3">英文名称</th>
              <th className="px-4 py-3 w-16">短码</th>
              <th className="px-4 py-3 w-24">技能数</th>
              <th className="px-4 py-3 w-32 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {cats.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-zinc-600">暂无分类</td></tr>
            )}
            {cats.map((c, i) => (
              <tr key={c.id} className="hover:bg-zinc-800/30">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-white disabled:opacity-30">↑</button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === cats.length - 1} className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-white disabled:opacity-30">↓</button>
                  </div>
                </td>
                <td className="px-4 py-3 text-lg leading-none">{c.icon || <span className="text-xs text-zinc-600">—</span>}</td>
                <td className="px-4 py-3 font-medium text-zinc-100">{c.name}</td>
                <td className="px-4 py-3 text-zinc-400">{c.nameEn}</td>
                <td className="px-4 py-3"><span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-300">{c.slug}</span></td>
                <td className="px-4 py-3"><span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">{c.skillCount ?? 0}</span></td>
                <td className="px-4 py-3 text-right">
                  <button type="button" onClick={() => openEdit(c)} className="mr-2 text-sky-400 hover:underline">编辑</button>
                  <button type="button" onClick={() => remove(c)} className="text-rose-400 hover:underline">删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
