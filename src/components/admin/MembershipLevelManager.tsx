"use client";

// 等级管理：列表 / 新建 / 改名 / 改获得条件 / 排序 / 启停 / 设默认 / 删除
import { useCallback, useEffect, useState } from "react";

type Level = {
  code: string;
  name: string;
  isSystem: boolean;
  canLogin: boolean;
  isDefault: boolean;
  grantCondition: string;
  sortOrder: number;
  isActive: boolean;
  remark: string | null;
  userCount: number;
};

const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-950/80 px-2 py-1.5 text-sm outline-none focus:border-indigo-500";

export default function MembershipLevelManager() {
  const [rows, setRows] = useState<Level[]>([]);
  const [draft, setDraft] = useState<Record<string, Partial<Level>>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [nw, setNw] = useState({
    code: "",
    name: "",
    isSystem: false,
    canLogin: true,
    grantCondition: "",
    sortOrder: 100,
  });

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/membership-levels").then((x) => x.json());
    setRows(r.list || []);
    setDraft({});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const flash = (ok: boolean, text: string) => {
    setMsg({ ok, text });
    setTimeout(() => setMsg(null), 3000);
  };

  const patch = async (code: string) => {
    const d = draft[code] || {};
    if (!Object.keys(d).length) return;
    const r = await fetch(`/api/admin/membership-levels/${code}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(d),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return flash(false, j.error || "保存失败");
    flash(true, "已保存");
    load();
  };

  const del = async (l: Level) => {
    if (!confirm(`删除等级「${l.name}」？`)) return;
    const r = await fetch(`/api/admin/membership-levels/${l.code}`, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return flash(false, j.error || "删除失败");
    flash(true, "已删除");
    load();
  };

  const create = async () => {
    const r = await fetch("/api/admin/membership-levels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...nw, isSystem: nw.isSystem, canLogin: nw.isSystem ? false : nw.canLogin }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return flash(false, j.error || "新建失败");
    flash(true, "已新建");
    setCreating(false);
    setNw({ code: "", name: "", isSystem: false, canLogin: true, grantCondition: "", sortOrder: 100 });
    load();
  };

  const set = (code: string, k: keyof Level, v: unknown) =>
    setDraft((p) => ({ ...p, [code]: { ...p[code], [k]: v } }));
  const val = <K extends keyof Level>(l: Level, k: K): Level[K] =>
    (draft[l.code]?.[k] !== undefined ? draft[l.code][k] : l[k]) as Level[K];

  return (
    <div className="space-y-4">
      {msg && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            msg.ok ? "border-emerald-800 bg-emerald-950/40 text-emerald-300" : "border-rose-800 bg-rose-950/40 text-rose-300"
          }`}
        >
          {msg.text}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-500">
          系统等级不可前台登录；默认等级禁止删除（可改名）；被账号引用的等级需先调整账号后才能删除。
        </p>
        <button
          onClick={() => setCreating((v) => !v)}
          className="rounded-lg border border-indigo-700 bg-indigo-950/40 px-3 py-1.5 text-xs text-indigo-300 hover:bg-indigo-900/40"
        >
          {creating ? "取消" : "新建等级"}
        </button>
      </div>

      {creating && (
        <div className="grid grid-cols-1 gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 md:grid-cols-7">
          <input className={inputCls} placeholder="编码 free_v2" value={nw.code} onChange={(e) => setNw({ ...nw, code: e.target.value })} />
          <input className={inputCls} placeholder="显示名" value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} />
          <select
            className={inputCls}
            value={nw.isSystem ? "1" : "0"}
            onChange={(e) => setNw({ ...nw, isSystem: e.target.value === "1", canLogin: e.target.value === "1" ? false : true })}
          >
            <option value="0">普通等级</option>
            <option value="1">系统等级</option>
          </select>
          <input
            className={inputCls}
            placeholder="获得条件"
            value={nw.grantCondition}
            onChange={(e) => setNw({ ...nw, grantCondition: e.target.value })}
          />
          <input
            className={inputCls}
            type="number"
            value={nw.sortOrder}
            onChange={(e) => setNw({ ...nw, sortOrder: Number(e.target.value) })}
          />
          <button onClick={create} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500">
            创建
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-zinc-800">
        <table className="w-full min-w-[980px] text-sm">
          <thead className="bg-zinc-900/60 text-left text-xs text-zinc-400">
            <tr>
              <th className="px-3 py-3">编码</th>
              <th className="px-3 py-3">显示名</th>
              <th className="px-3 py-3">类别</th>
              <th className="px-3 py-3">可登录</th>
              <th className="px-3 py-3">默认</th>
              <th className="px-3 py-3">获得条件</th>
              <th className="px-3 py-3 w-20">排序</th>
              <th className="px-3 py-3">启用</th>
              <th className="px-3 py-3">账号数</th>
              <th className="px-3 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.code} className="border-t border-zinc-800/70">
                <td className="px-3 py-2 font-mono text-xs text-zinc-300">{l.code}</td>
                <td className="px-3 py-2">
                  <input className={inputCls} value={val(l, "name")} onChange={(e) => set(l.code, "name", e.target.value)} />
                </td>
                <td className="px-3 py-2 text-xs">
                  <span className={l.isSystem ? "text-amber-300" : "text-zinc-400"}>{l.isSystem ? "系统" : "普通"}</span>
                </td>
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-indigo-500"
                    checked={val(l, "canLogin")}
                    disabled={l.isSystem}
                    onChange={(e) => set(l.code, "canLogin", e.target.checked)}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="radio"
                    name="default-level"
                    className="h-4 w-4 accent-indigo-500"
                    checked={val(l, "isDefault")}
                    disabled={l.isSystem}
                    onChange={() => set(l.code, "isDefault", true)}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    className={inputCls}
                    value={val(l, "grantCondition")}
                    onChange={(e) => set(l.code, "grantCondition", e.target.value)}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    className={inputCls}
                    type="number"
                    value={val(l, "sortOrder")}
                    onChange={(e) => set(l.code, "sortOrder", Number(e.target.value))}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-indigo-500"
                    checked={val(l, "isActive")}
                    onChange={(e) => set(l.code, "isActive", e.target.checked)}
                  />
                </td>
                <td className="px-3 py-2 text-xs text-zinc-400">{l.userCount}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-2">
                    <button onClick={() => patch(l.code)} className="text-xs text-indigo-300 hover:text-indigo-200">
                      保存
                    </button>
                    <button
                      onClick={() => del(l)}
                      disabled={l.isDefault}
                      className="text-xs text-rose-300 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
