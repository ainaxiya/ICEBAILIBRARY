"use client";

import { useEffect, useRef, useState } from "react";

// 分段提示词编辑器：编辑「[N] 标题 + 正文」纯文本格式（前台 PromptToc「本页结构」的数据源）
// - 卡片式分段：标题 / 正文 / 增删 / 上下移
// - 粘贴大篇幅文本一键拆分
// - 保存/输出时自动重编号 [1][2]…

type Seg = { title: string; body: string };

// 文本 → 分段：行首 [N] 标题 开启新段；首个标题之前的文本作为无标题段
function parseSegments(text: string): Seg[] {
  const lines = (text || "").replace(/\r\n/g, "\n").split("\n");
  const segs: Seg[] = [];
  let cur: Seg | null = null;
  for (const line of lines) {
    const m = line.match(/^\[\d+\]\s*(.+)$/);
    if (m) {
      if (cur) segs.push(cur);
      cur = { title: m[1].trim(), body: "" };
    } else if (cur) {
      cur.body += (cur.body ? "\n" : "") + line;
    } else if (line.trim()) {
      cur = { title: "", body: line };
    }
  }
  if (cur) segs.push(cur);
  return segs.map((s) => ({ title: s.title, body: s.body.replace(/^\n+|\n+$/g, "") }));
}

// 分段 → 文本：有标题段自动编号 [N]；无标题段原样输出（正文保留内部空行）
function serializeSegments(segs: Seg[]): string {
  let n = 0;
  return segs
    .map((s) => {
      const body = s.body.replace(/^\n+|\n+$/g, "");
      const title = s.title.trim();
      if (!title) return body;
      n += 1;
      return body ? `[${n}] ${title}\n${body}` : `[${n}] ${title}`;
    })
    .filter((s) => s.trim())
    .join("\n\n");
}

export default function SegmentedPromptEditor({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (text: string) => void;
  disabled?: boolean;
}) {
  const [segs, setSegs] = useState<Seg[]>(() => parseSegments(value));
  const lastEmitted = useRef(value);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");

  // 外部 value 变化（加载旧数据/切换模式）时重新解析；自己 emit 的不回解析
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setSegs(parseSegments(value));
    }
  }, [value]);

  const emit = (next: Seg[]) => {
    setSegs(next);
    const text = serializeSegments(next);
    lastEmitted.current = text;
    onChange(text);
  };

  const update = (i: number, patch: Partial<Seg>) =>
    emit(segs.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= segs.length) return;
    const next = [...segs];
    [next[i], next[j]] = [next[j], next[i]];
    emit(next);
  };

  const remove = (i: number) => emit(segs.filter((_, idx) => idx !== i));

  const add = () => emit([...segs, { title: "", body: "" }]);

  // 粘贴拆分：含 [N] 标题按标题拆；否则按空行拆（无标题段）
  const splitBulk = () => {
    const text = bulkText.replace(/\r\n/g, "\n").trim();
    if (!text) return;
    let parsed = parseSegments(text);
    if (parsed.length <= 1 && !/^\[\d+\]/m.test(text)) {
      parsed = text
        .split(/\n{2,}/)
        .map((b) => ({ title: "", body: b.trim() }))
        .filter((s) => s.body);
    }
    if (!parsed.length) return;
    if (segs.length && !window.confirm(`将用拆分出的 ${parsed.length} 段替换当前 ${segs.length} 段，确定？`)) return;
    emit(parsed);
    setBulkText("");
    setBulkOpen(false);
  };

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900">
      {/* 头部工具条 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <span className="text-sm font-medium text-zinc-300">
          分段编辑 <span className="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">共 {segs.length} 段</span>
        </span>
        <span className="text-xs text-zinc-600">保存时自动重编号 [1][2]…，前台自动生成「本页结构」导航</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => setBulkOpen((v) => !v)}
            className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {bulkOpen ? "收起粘贴拆分" : "📋 粘贴一键拆分"}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={add}
            className="rounded-lg border border-emerald-600/60 bg-emerald-600/15 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-600/25 disabled:opacity-50"
          >
            + 添加一段
          </button>
        </div>
      </div>

      {/* 粘贴拆分面板 */}
      {bulkOpen && (
        <div className="border-b border-zinc-800 bg-zinc-950/40 p-3">
          <p className="mb-1.5 text-xs text-zinc-500">
            粘贴整篇提示词：含「[1] 标题」行按标题拆分；否则按空行拆分（无标题段可在下方补标题）
          </p>
          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={"[1] 角色设定\n你是一位…\n\n[2] 任务目标\n…"}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs outline-none focus:border-emerald-500"
          />
          <button
            type="button"
            disabled={disabled || !bulkText.trim()}
            onClick={splitBulk}
            className="mt-2 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            拆分为分段
          </button>
        </div>
      )}

      {/* 分段卡片 */}
      <div className="max-h-[560px] space-y-3 overflow-y-auto p-3">
        {segs.length === 0 && (
          <p className="py-8 text-center text-sm text-zinc-600">暂无分段，点「+ 添加一段」或「粘贴一键拆分」</p>
        )}
        {segs.map((s, i) => (
          <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/60">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs font-semibold text-emerald-300">
                #{i + 1}
              </span>
              {s.title.trim() && (
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-500">[{i + 1}]</span>
              )}
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  disabled={disabled || i === 0}
                  onClick={() => move(i, -1)}
                  title="上移"
                  className="rounded border border-zinc-700 px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={disabled || i === segs.length - 1}
                  onClick={() => move(i, 1)}
                  title="下移"
                  className="rounded border border-zinc-700 px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => remove(i)}
                  title="删除本段"
                  className="rounded border border-rose-800/60 px-1.5 py-0.5 text-xs text-rose-400 hover:bg-rose-900/30 disabled:opacity-30"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="space-y-2 p-3">
              <input
                value={s.title}
                onChange={(e) => update(i, { title: e.target.value })}
                disabled={disabled}
                placeholder="段标题（留空=不输出 [N] 编号，作为前言/过渡段）"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-200 outline-none focus:border-emerald-500"
              />
              <textarea
                value={s.body}
                onChange={(e) => update(i, { body: e.target.value })}
                disabled={disabled}
                rows={Math.min(12, Math.max(3, s.body.split("\n").length + 1))}
                spellCheck={false}
                placeholder="本段正文…"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-emerald-500"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
