"use client";

import { useEffect, useState } from "react";

// 优化器使用记录表格 + 详情弹层
// 列表每行一行显示完、文本截断；「查看详细」弹层用 SKILL.md 样式多行框完整展示

type Row = {
  id: number;
  ip: string;
  source?: string; // home=首页神器区 / shenqi=单页工具页
  input: string;
  output: string;
  error: string;
  createdAt: string;
};

const SOURCE_LABEL: Record<string, string> = { home: "首页", shenqi: "单页工具" };

// ISO 时间 → 浏览器本地时区显示（与操作日志一致）
const fmtTime = (s: string) => {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("zh-CN", { hour12: false });
};

const clip = (s: string, n = 24) => (s.length > n ? s.slice(0, n) + "…" : s || "—");

// SKILL.md 样式多行文本框（与技能详情页一致）
function CodeBox({ title, text, tone = "zinc" }: { title: string; text: string; tone?: "zinc" | "rose" | "emerald" }) {
  const borderCls =
    tone === "rose"
      ? "border-rose-800/60 bg-rose-950/30"
      : tone === "emerald"
        ? "border-emerald-800/60 bg-zinc-950/80"
        : "border-zinc-800 bg-zinc-950/80";
  const titleCls =
    tone === "rose" ? "text-rose-300" : tone === "emerald" ? "text-emerald-300" : "text-zinc-400";
  return (
    <div className={`rounded-xl border ${borderCls} text-left`}>
      <div className={`flex items-center justify-between border-b px-4 py-2.5 ${tone === "rose" ? "border-rose-800/60" : "border-zinc-800"}`}>
        <span className={`font-mono text-xs ${titleCls}`}>{title}</span>
      </div>
      <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-zinc-300">
        {text || <span className="text-zinc-600">—</span>}
      </pre>
    </div>
  );
}

export default function OptimizerLogTable({ rows }: { rows: Row[] }) {
  const [active, setActive] = useState<Row | null>(null);

  // 弹层打开时锁定滚动 / Esc 关闭
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setActive(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900">
        <table className="w-full min-w-[980px] text-sm">
          <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
            <tr>
              <th className="w-40 px-3 py-2.5">使用时间</th>
              <th className="w-36 px-3 py-2.5">IP</th>
              <th className="w-24 px-3 py-2.5">来源</th>
              <th className="px-3 py-2.5">提交的提示词</th>
              <th className="px-3 py-2.5">优化后的提示词</th>
              <th className="w-44 px-3 py-2.5">错误内容</th>
              <th className="w-24 px-3 py-2.5">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-zinc-600">
                  暂无使用记录
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="align-middle hover:bg-zinc-800/30">
                <td className="whitespace-nowrap px-3 py-2.5 text-xs text-zinc-500">{fmtTime(r.createdAt)}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-xs text-zinc-400">{r.ip || "—"}</td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${r.source === "shenqi" ? "bg-sky-500/15 text-sky-300" : "bg-zinc-700/40 text-zinc-300"}`}>
                    {SOURCE_LABEL[r.source || "home"] || r.source}
                  </span>
                </td>
                <td className="max-w-[240px] truncate px-3 py-2.5 text-zinc-300">{clip(r.input, 26)}</td>
                <td className="max-w-[240px] truncate px-3 py-2.5 text-zinc-300">{r.output ? clip(r.output, 26) : "—"}</td>
                <td className="max-w-[180px] truncate px-3 py-2.5">
                  {r.error ? (
                    <span className="text-xs text-rose-400">{clip(r.error, 20)}</span>
                  ) : (
                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300">成功</span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <button
                    onClick={() => setActive(r)}
                    className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 transition hover:bg-zinc-700"
                  >
                    查看详细
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 详情弹层 */}
      {active && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setActive(null)}
        >
          <div
            className="max-h-[86vh] w-full max-w-3xl overflow-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-base font-bold text-zinc-100">
                使用详情
                <span className="ml-2 text-xs font-normal text-zinc-500">#{active.id}</span>
              </h3>
              <button
                onClick={() => setActive(null)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 transition hover:bg-zinc-700"
              >
                关闭
              </button>
            </div>
            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-400">
              <span>IP：{active.ip || "—"}</span>
              <span>来源：{SOURCE_LABEL[active.source || "home"] || active.source || "—"}</span>
              <span>使用时间：{fmtTime(active.createdAt)}</span>
              <span>
                状态：
                {active.error ? (
                  <span className="text-rose-400">出错</span>
                ) : (
                  <span className="text-emerald-400">成功</span>
                )}
              </span>
            </div>
            <div className="space-y-4">
              <CodeBox title="用户提交的提示词" text={active.input} />
              <CodeBox title="优化后的提示词" text={active.output} tone={active.output ? "emerald" : "zinc"} />
              {active.error && <CodeBox title="错误内容" text={active.error} tone="rose" />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
