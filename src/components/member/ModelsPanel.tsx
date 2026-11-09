"use client";

import { useEffect, useState } from "react";

// ─── v0.92 #10 会员中心模型列表：全部模型（计数）/ 按厂商分组（计数）+ 模型名称与功能 ───

type ModelItem = {
  id: number;
  name: string;
  displayName: string | null;
  type: string;
  features: string[];
  remark: string | null;
};

type VendorGroup = {
  id: number;
  name: string;
  slug: string;
  count: number;
  models: ModelItem[];
};

type ModelsData = {
  total: number;
  vendorCount: number;
  vendors: VendorGroup[];
};

export default function ModelsPanel() {
  const [data, setData] = useState<ModelsData | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<Record<number, boolean>>({});

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/member/models");
        const d = await r.json();
        if (r.ok) {
          setData(d);
          // 默认展开前 3 个厂商
          const init: Record<number, boolean> = {};
          (d.vendors || []).slice(0, 3).forEach((v: VendorGroup) => (init[v.id] = true));
          setOpen(init);
        } else {
          setErr(d.error || "加载失败");
        }
      } catch {
        setErr("加载失败，请稍后重试");
      }
    })();
  }, []);

  return (
    <div>
      {/* 总览：全部模型计数 / 厂商计数 */}
      <div className="mb-4 flex flex-wrap items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div>
          <p className="text-xs text-zinc-500">全部模型</p>
          <p className="mt-1 text-3xl font-bold text-emerald-400">{data ? data.total : "—"}</p>
        </div>
        <div>
          <p className="text-xs text-zinc-500">模型厂商</p>
          <p className="mt-1 text-3xl font-bold text-emerald-400">{data ? data.vendorCount : "—"}</p>
        </div>
        <p className="ml-auto max-w-xs text-xs text-zinc-500">
          以下为已上线的全部模型，按厂商分组；每行展示模型名称与支持的功能
        </p>
      </div>

      {err && <p className="mb-2 text-xs text-rose-400">{err}</p>}

      {data == null && !err ? (
        <div className="rounded-xl border border-zinc-800 p-6 text-center text-sm text-zinc-500">加载中…</div>
      ) : (
        <div className="space-y-3">
          {(data?.vendors || []).map((v) => (
            <div key={v.id} className="overflow-hidden rounded-xl border border-zinc-800">
              {/* 厂商大栏目（折叠） */}
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [v.id]: !o[v.id] }))}
                className="flex w-full items-center gap-3 bg-zinc-900/60 px-4 py-3 text-left transition hover:bg-zinc-900"
              >
                <span className="text-zinc-500">{open[v.id] ? "▾" : "▸"}</span>
                <span className="text-sm font-semibold text-zinc-100">{v.name}</span>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">
                  {v.count} 个模型
                </span>
              </button>
              {/* 模型小栏目 */}
              {open[v.id] && (
                <ul className="divide-y divide-zinc-800/70">
                  {v.models.length === 0 ? (
                    <li className="px-4 py-4 text-center text-sm text-zinc-500">该厂商暂无上线模型</li>
                  ) : (
                    v.models.map((m) => (
                      <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-zinc-200">
                              {m.displayName || m.name}
                            </span>
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">
                              {m.type}
                            </span>
                          </div>
                          <p className="mt-0.5 font-mono text-[11px] text-zinc-600">{m.name}</p>
                          {m.remark && <p className="mt-0.5 text-xs text-zinc-500">{m.remark}</p>}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {m.features.length === 0 ? (
                            <span className="text-xs text-zinc-600">—</span>
                          ) : (
                            m.features.map((f) => (
                              <span
                                key={f}
                                className="rounded-full border border-emerald-600/40 px-2 py-0.5 text-[11px] text-emerald-300"
                              >
                                {f}
                              </span>
                            ))
                          )}
                        </div>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
