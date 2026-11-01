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

// 后台积分包管理（挂在「网站设置」页下方的小节）
export default function CreditPacksAdmin() {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [msg, setMsg] = useState("");

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

  if (!loaded) return <p className="text-sm text-zinc-500">加载中…</p>;

  return (
    <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <h2 className="text-base font-semibold text-zinc-100">积分包管理</h2>
      <p className="mt-1 text-xs text-zinc-500">
        充值商品与到账积分（价格单位：元；到账积分为整数，含赠送）。
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {msg && <p className="mt-2 text-xs text-emerald-400">{msg}</p>}
    </div>
  );
}
