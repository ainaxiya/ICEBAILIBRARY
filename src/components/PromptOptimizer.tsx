"use client";

import { useState } from "react";

// ─── 神器·全能提示词优化器（首页工具区，替换原 banner）───
// 排版：统计条（单行一块）→ 大标题（一行）→ 英文名 → 介绍 → 输入框（按钮内嵌）→ 图标行 → 输出框（SKILL.md 样式，顶栏带复制/下载）

type Props = {
  siteName: string;
  promptCount: number;
  skillCount: number;
  // 使用记录来源：home=首页神器区 / shenqi=单页工具页（/shenqi）
  source?: "home" | "shenqi";
};

// 可使用优化结果的模型/工具图标行（内联 SVG，全站无站外资源）
// 数量按"桌面单行整齐排下"精简为 8 个（含 LIBLIB / 即梦）
const TOOLS: { name: string; color: string; glyph: "spark" | "star" | "wave" | "cube" }[] = [
  { name: "ChatGPT", color: "#10a37f", glyph: "spark" },
  { name: "Claude", color: "#d97757", glyph: "star" },
  { name: "Gemini", color: "#4285f4", glyph: "spark" },
  { name: "DeepSeek", color: "#4d6bfe", glyph: "wave" },
  { name: "豆包", color: "#2f6df6", glyph: "star" },
  { name: "即梦", color: "#00c8d4", glyph: "wave" },
  { name: "LIBLIB", color: "#f06292", glyph: "spark" },
  { name: "可灵", color: "#f59e0b", glyph: "star" },
];

function Glyph({ kind, color }: { kind: "spark" | "star" | "wave" | "cube"; color: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 sm:h-3.5 sm:w-3.5" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {kind === "spark" && <path d="M12 2l2.2 6.2L20 10l-5.8 1.8L12 18l-2.2-6.2L4 10l5.8-1.8z" />}
      {kind === "star" && <path d="M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.4 9.4l6-.8z" />}
      {kind === "wave" && <path d="M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0" />}
      {kind === "cube" && <path d="M12 2l8 4.5v9L12 20l-8-4.5v-9zM12 11l8-4.5M12 11L4 6.5M12 11v9" />}
    </svg>
  );
}

export default function PromptOptimizer({ siteName, promptCount, skillCount, source = "home" }: Props) {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const optimize = async () => {
    const text = input.trim();
    if (!text) {
      setError("请先输入你想做的事，哪怕只是一句大白话");
      return;
    }
    setError("");
    setLoading(true);
    setOutput("");
    try {
      // 流式接收（NDJSON：{"s":1} 开始 / {"d":"片段"} 增量 / {"e":"错误"} 错误）
      const r = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, source }),
      });
      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || "优化失败，请稍后重试");
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";
      let err = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (typeof ev.d === "string" && ev.d) {
              acc += ev.d;
              setOutput(acc); // 打字机式实时显示
            } else if (typeof ev.e === "string" && ev.e) {
              err = ev.e;
            }
          } catch {
            // 忽略半行/坏行
          }
        }
      }
      if (err) throw new Error(err);
      if (!acc) throw new Error("模型未返回内容，请稍后重试");
      setOutput(acc);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("复制失败，请手动全选复制");
    }
  };

  const download = () => {
    if (!output) return;
    const content = `【此提示词由 冰山AI资料库 wango8.com 用提示词优化神器生成】\n\n${output}`;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `优化提示词-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="relative mb-10 overflow-hidden rounded-3xl border border-blue-400/20">
      {/* 向中心聚光的渐变背景 */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 900px 480px at 50% -12%, rgba(59,130,246,0.32), transparent 62%), radial-gradient(ellipse 700px 380px at 50% 112%, rgba(34,211,238,0.14), transparent 60%), linear-gradient(180deg, #0d1740 0%, #0a1235 55%, #091030 100%)",
        }}
      />
      {/* 背景图（30% 透明度，叠在聚光渐变之上） */}
      <div
        className="absolute inset-0 bg-cover bg-center opacity-30"
        style={{ backgroundImage: "url(/site-assets/shenqi-bg.png)" }}
      />
      {/* 四角暗角，强化聚光 */}
      <div
        className="absolute inset-0"
        style={{ background: "radial-gradient(ellipse at 50% 45%, transparent 38%, rgba(4,7,22,0.55) 100%)" }}
      />

      <div className="relative px-4 py-8 text-center sm:px-8 sm:py-12">
        {/* 第一行：统计条（单块单行，手机端不换行） */}
        <div className="flex justify-center">
          <span className="inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1.5 text-[10px] font-medium text-cyan-100 backdrop-blur sm:gap-1.5 sm:px-4 sm:text-sm">
            <b className="font-bold text-white">{siteName}</b>
            <span className="text-cyan-300/50">·</span>
            <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 5a2 2 0 012-2h9l5 5v11a2 2 0 01-2 2H6a2 2 0 01-2-2z" />
              <path d="M14 3v5h5" />
            </svg>
            已存 <b className="font-bold text-white">{promptCount.toLocaleString()}</b> 条提示词
            <span className="text-cyan-300/50">·</span>
            <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 2l8 4.5v9L12 20l-8-4.5v-9zM12 11l8-4.5M12 11L4 6.5M12 11v9" />
            </svg>
            已存 <b className="font-bold text-white">{skillCount.toLocaleString()}</b> 个技能
          </span>
        </div>

        {/* 第二行：大标题（一行显示完） */}
        <h1 className="mt-6 whitespace-nowrap text-[26px] font-black tracking-tight text-white sm:text-5xl lg:text-6xl">
          <span className="bg-gradient-to-r from-cyan-300 via-sky-400 to-blue-400 bg-clip-text text-transparent drop-shadow-[0_0_28px_rgba(56,189,248,0.45)]">
            神器
          </span>
          <span className="mx-1.5 text-lg font-light text-cyan-200/70 sm:mx-3 sm:text-4xl">·</span>
          全能提示词优化器
        </h1>

        {/* 第三行：英文 */}
        <p className="mt-2.5 whitespace-nowrap text-xs font-semibold tracking-[0.15em] text-sky-400 sm:text-2xl sm:tracking-[0.22em]">
          Master Prompt Optimizer
        </p>

        {/* 补充介绍文字（桌面一行显示完） */}
        <p className="mx-auto mt-3 max-w-4xl text-[11px] leading-relaxed text-cyan-100/75 sm:whitespace-nowrap sm:text-sm">
          把你的任意大白话，瞬间重构为全行业万能专业级提示词,碰到问题也可以在这直接提
        </p>

        {/* 第四行：输入框（未聚焦=半透明玻璃态，聚焦=白底+蓝光；优化按钮一体化贴右侧全高） */}
        <div className="mx-auto mt-6 w-full max-w-3xl">
          <div className="relative rounded-2xl border border-white/25 bg-white/10 shadow-[0_18px_50px_-12px_rgba(2,8,30,0.75)] backdrop-blur-md transition focus-within:border-sky-400 focus-within:bg-white focus-within:ring-4 focus-within:ring-sky-400/25">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={2}
              placeholder="例：抖音上的引流视频帮我写剧本分镜脚本 或 怎么用提示词生成视频?"
              className="min-h-[62px] w-full resize-y rounded-2xl bg-transparent py-3 pl-5 pr-[118px] text-left text-sm leading-relaxed text-white outline-none transition-colors placeholder:text-white/55 focus:text-slate-800 focus:placeholder:text-sky-400/80 sm:pr-[138px]"
            />
            <button
              onClick={optimize}
              disabled={loading}
              className="group absolute right-0 top-0 flex h-full items-center gap-1.5 overflow-hidden rounded-r-2xl bg-gradient-to-b from-[#1772d6] to-[#0c5cbf] px-4 text-sm font-bold text-white shadow-[0_10px_26px_-6px_rgba(12,92,190,0.55)] transition hover:shadow-[0_14px_32px_-6px_rgba(12,92,190,0.75)] disabled:cursor-not-allowed disabled:opacity-60 sm:px-5 sm:text-base"
            >
              <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-white/25 to-transparent opacity-0 transition group-hover:opacity-100" />
              {loading ? (
                <>
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                    <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                  优化中…
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2l2.2 6.2L20 10l-5.8 1.8L12 18l-2.2-6.2L4 10l5.8-1.8z" />
                  </svg>
                  优化
                </>
              )}
            </button>
          </div>
        </div>

        {/* 提示文字一行居中 + 模型/工具图标一行居中（不裁切不换行错位） */}
        <div className="mx-auto mt-4 max-w-5xl">
          <p className="text-xs text-cyan-300/85 sm:text-sm">本站的AI提示词和AI技能均可适用于以下模型或软件复制即用</p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
            {TOOLS.map((t) => (
            <span
              key={t.name}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-cyan-50/85 backdrop-blur transition hover:border-cyan-300/40 hover:bg-white/10 sm:text-xs"
            >
              <Glyph kind={t.glyph} color={t.color} />
              {t.name}
            </span>
            ))}
          </div>
        </div>

        {/* 错误提示 */}
        {error && (
          <p className="mx-auto mt-4 max-w-3xl rounded-xl border border-rose-400/30 bg-rose-500/15 px-4 py-2.5 text-sm text-rose-200">
            {error}
          </p>
        )}

        {/* 输出框：SKILL.md 样式（顶栏 + 只读等宽正文 + 内部滚动） */}
        <div className="mx-auto mt-6 max-w-3xl rounded-xl border border-zinc-800 bg-zinc-950/80 text-left shadow-[0_18px_50px_-12px_rgba(2,8,30,0.75)]">
          <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3.5">
            <span className="whitespace-nowrap bg-gradient-to-r from-violet-300 via-fuchsia-400 to-pink-400 bg-clip-text text-lg font-semibold tracking-tight text-transparent drop-shadow-[0_0_12px_rgba(232,121,249,0.55)]">
              神器优化后结果输出
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={copy}
                disabled={!output}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-zinc-950 transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40 sm:text-sm"
              >
                {copied ? (
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15V5a2 2 0 012-2h10" />
                  </svg>
                )}
                {copied ? "已复制" : "复制"}
              </button>
              <button
                onClick={download}
                disabled={!output}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 sm:text-sm"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" />
                </svg>
                下载
              </button>
            </div>
          </div>
          <pre className="min-h-[150px] max-h-[240px] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-zinc-300">
            {output || (
              <span className="text-zinc-600">
                神器优化后的专业级提示词将显示在这里（不可编辑，击右上角「复制」或「下载txt」推荐直接下载文档保证完整性）
              </span>
            )}
          </pre>
        </div>
      </div>
    </section>
  );
}
