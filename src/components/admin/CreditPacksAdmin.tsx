"use client";

import { useEffect, useState } from "react";

type Pack = {
  id: number;
  packCode: string;
  priceCents: number;
  credits: number;
  isActive: boolean;
  sortOrder: number;
};

const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-950/80 px-3 py-2 text-sm outline-none focus:border-indigo-500";
const labelCls = "mb-1 block text-xs text-zinc-400";

// 后台积分包管理（独立菜单页「积分包管理」）
// 支持：行内编辑保存、新建、单个删除（confirm）、复选框批量上架/下架/删除。
export default function CreditPacksAdmin() {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  // 批量选择的积分包 id
  const [selected, setSelected] = useState<number[]>([]);
  // 新建弹层
  const [showCreate, setShowCreate] = useState(false);

  const load = () =>
    fetch("/api/admin/credits/packs")
      .then((r) => r.json())
      .then((d) => setPacks(d.packs || []))
      .catch(() => {})
      .finally(() => setLoaded(true));

  useEffect(() => {
    load();
  }, []);

  const setField = (id: number, patch: Partial<Pack>) =>
    setPacks((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const save = async (p: Pack) => {
    setSavingId(p.id);
    setMsg("");
    try {
      const r = await fetch("/api/admin/credits/packs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: p.id,
          priceCents: p.priceCents,
          credits: p.credits,
          sortOrder: p.sortOrder,
          isActive: p.isActive,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setMsg(d.error || "保存失败");
        return;
      }
      setMsg("已保存 ✓");
      load();
    } catch (e) {
      setMsg("保存失败：" + String(e));
    } finally {
      setSavingId(null);
    }
  };

  // ─── 复选框选择 ───
  const toggle = (id: number) =>
    setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const allChecked = packs.length > 0 && selected.length === packs.length;
  const toggleAll = () => setSelected(allChecked ? [] : packs.map((p) => p.id));

  // ─── 批量操作（含单行删除复用） ───
  const batch = async (action: "activate" | "deactivate" | "delete", ids: number[]) => {
    if (ids.length === 0) return;
    if (action === "delete" && !window.confirm(`确认删除选中的 ${ids.length} 个积分包？删除后不可恢复。`)) return;
    setMsg("");
    try {
      const r = await fetch("/api/admin/credits/packs/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg(d.error || "操作失败");
        return;
      }
      setMsg(`已${action === "activate" ? "上架" : action === "deactivate" ? "下架" : "删除"} ${d.count ?? ids.length} 项 ✓`);
      setSelected((list) => list.filter((x) => !ids.includes(x)));
      load();
    } catch (e) {
      setMsg("操作失败：" + String(e));
    }
  };

  if (!loaded) return <p className="text-sm text-zinc-500">加载中…</p>;

  return (
    <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">积分包管理</h2>
          <p className="mt-1 text-xs text-zinc-500">
            充值商品与到账积分（价格单位：元；到账积分为整数，含赠送）。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
        >
          + 新建积分包
        </button>
      </div>

      {/* 批量操作条 */}
      {selected.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-300">
          <span>已选 {selected.length} 项</span>
          <button
            type="button"
            onClick={() => batch("activate", selected)}
            className="rounded bg-emerald-700 px-3 py-1 text-white hover:bg-emerald-600"
          >
            批量上架
          </button>
          <button
            type="button"
            onClick={() => batch("deactivate", selected)}
            className="rounded bg-zinc-700 px-3 py-1 text-white hover:bg-zinc-600"
          >
            批量下架
          </button>
          <button
            type="button"
            onClick={() => batch("delete", selected)}
            className="rounded bg-rose-700 px-3 py-1 text-white hover:bg-rose-600"
          >
            批量删除
          </button>
          <button type="button" onClick={() => setSelected([])} className="text-zinc-500 hover:text-zinc-300">
            取消选择
          </button>
        </div>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <th className="px-2 py-2">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={toggleAll}
                  className="h-4 w-4 accent-emerald-500"
                />
              </th>
              <th className="px-2 py-2">商品码</th>
              <th className="px-2 py-2">价格（元）</th>
              <th className="px-2 py-2">到账积分</th>
              <th className="px-2 py-2">排序</th>
              <th className="px-2 py-2">上架</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {packs.map((p) => (
              <tr key={p.id}>
                <td className="px-2 py-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(p.id)}
                    onChange={() => toggle(p.id)}
                    className="h-4 w-4 accent-emerald-500"
                  />
                </td>
                <td className="px-2 py-2 font-mono text-zinc-200">{p.packCode}</td>
                <td className="px-2 py-2">
                  <input
                    type="number"
                    min={1}
                    value={p.priceCents / 100}
                    onChange={(e) => setField(p.id, { priceCents: Math.round(Number(e.target.value) * 100) })}
                    className="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
                  />
                </td>
                <td className="px-2 py-2">
                  <input
                    type="number"
                    min={1}
                    value={p.credits}
                    onChange={(e) => setField(p.id, { credits: Number(e.target.value) })}
                    className="w-28 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
                  />
                </td>
                <td className="px-2 py-2">
                  <input
                    type="number"
                    min={0}
                    value={p.sortOrder}
                    onChange={(e) => setField(p.id, { sortOrder: Number(e.target.value) })}
                    className="w-16 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
                  />
                </td>
                <td className="px-2 py-2">
                  <input
                    type="checkbox"
                    checked={p.isActive}
                    onChange={(e) => setField(p.id, { isActive: e.target.checked })}
                    className="h-4 w-4 accent-emerald-500"
                  />
                </td>
                <td className="px-2 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => save(p)}
                    disabled={savingId === p.id}
                    className="rounded bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {savingId === p.id ? "保存中…" : "保存"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`确认删除积分包 ${p.packCode}？删除后不可恢复。`)) {
                        batch("delete", [p.id]);
                      }
                    }}
                    className="ml-2 rounded bg-rose-700 px-3 py-1 text-xs text-white hover:bg-rose-600"
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {msg && <p className="mt-2 text-xs text-emerald-400">{msg}</p>}

      {/* 新建积分包弹层 */}
      {showCreate && (
        <CreatePackModal
          onClose={() => setShowCreate(false)}
          onDone={() => {
            setShowCreate(false);
            setMsg("已创建 ✓");
            load();
          }}
        />
      )}
    </div>
  );
}

// 新建积分包弹层（参照 UserManager 的 ModalShell 写法）
function CreatePackModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ packCode: "", priceYuan: "", credits: "", sortOrder: "0", isActive: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    const priceCents = Math.round(Number(f.priceYuan) * 100);
    const credits = Number(f.credits);
    if (!f.packCode.trim()) return setErr("请填写商品码");
    if (!Number.isFinite(priceCents) || priceCents < 1) return setErr("价格须大于 0");
    if (!Number.isInteger(credits) || credits < 1) return setErr("到账积分须为正整数");
    setBusy(true);
    try {
      const r = await fetch("/api/admin/credits/packs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packCode: f.packCode.trim(),
          priceCents,
          credits,
          sortOrder: Number(f.sortOrder) || 0,
          isActive: f.isActive,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "创建失败");
        return;
      }
      onDone();
    } catch (e) {
      setErr("创建失败：" + String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 py-10" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-[#0f1630] p-4 shadow-2xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-zinc-100">新建积分包</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">✕</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className={labelCls}>商品码（唯一，如 p50）</label>
            <input
              className={inputCls}
              value={f.packCode}
              onChange={(e) => setF({ ...f, packCode: e.target.value })}
              placeholder="p50"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
            <div>
              <label className={labelCls}>价格（元）</label>
              <input
                type="number"
                min={0.01}
                step="0.01"
                className={inputCls}
                value={f.priceYuan}
                onChange={(e) => setF({ ...f, priceYuan: e.target.value })}
                placeholder="50"
              />
            </div>
            <div>
              <label className={labelCls}>到账积分（整数，含赠送）</label>
              <input
                type="number"
                min={1}
                className={inputCls}
                value={f.credits}
                onChange={(e) => setF({ ...f, credits: e.target.value })}
                placeholder="5000"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
            <div>
              <label className={labelCls}>排序（小的在前）</label>
              <input
                type="number"
                min={0}
                className={inputCls}
                value={f.sortOrder}
                onChange={(e) => setF({ ...f, sortOrder: e.target.value })}
              />
            </div>
            <label className="flex items-center gap-2 pt-5 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={f.isActive}
                onChange={(e) => setF({ ...f, isActive: e.target.checked })}
                className="h-4 w-4 accent-emerald-500"
              />
              创建后立即上架
            </label>
          </div>
          {err && <p className="text-xs text-rose-400">{err}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              取消
            </button>
            <button
              onClick={submit}
              disabled={busy || !f.packCode || !f.priceYuan || !f.credits}
              className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? "提交中…" : "创建"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
