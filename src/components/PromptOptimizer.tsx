"use client";

import { SITE_HOST } from "@/lib/site-config";
import { nanoid } from "nanoid";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
// ─── 神器·全能提示词优化器（首页工具区，替换原 banner）───
// 排版：统计条（单行一块）→ 大标题（一行）→ 英文名 → 介绍 → 输入框（按钮内嵌）→ 图标行 → 输出框（SKILL.md 样式，顶栏带复制/下载）

type Props = {
  siteName: string;
  promptCount: number;
  skillCount: number;
  // 使用记录来源：home=首页神器区 / shenqi=单页工具页（/shenqi）
  source?: "home" | "shenqi";
  // 神器滚动文字：多条宣传语无缝上下滚动（后台「网站设置」可配；空数组用默认六条）
  rotatingLines?: string[];
};

// 默认六条滚动宣传语（后台未配置时使用，与 src/lib/settings.ts DEFAULT_ROTATING_LINES 一致）
const DEFAULT_LINES = [
  "把你的任意大白话瞬间重构为视频 设计 编程 写作 音乐 办公 营销 金融等全行业提示词",
  "你是完全新手小白也没问题，问题也可以在这直接提，直接给你教程",
  "神器的功能不等于一般聊天AI，神器只专注于把新手一句话想法优化大师级可行方案",
  "各行各业的专业术语太多，少了术语AI执行效果差强人意，神器给你补上缺口",
  "你完全不懂？没关系，你仅有一点点想法？没关系，神器给你完善成最优方案",
  "想做AI视频？AI设计？又不懂步骤，直接问神器，神器给你保姆级教学+预算成本",
];

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

export default function PromptOptimizer({ siteName, promptCount, skillCount, source = "home", rotatingLines = [] }: Props) {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  // 流式输出时始终跟随最新文字；输出完成后不再主动滚动。
  useEffect(() => {
    const outputEl = outputRef.current;
    if (outputEl) outputEl.scrollTop = outputEl.scrollHeight;
  }, [output]);

  // 宣传语逐条播放：一条快速滚入 → 停留 8 秒 → 滚出下一条，循环
  const lines = rotatingLines.length ? rotatingLines : DEFAULT_LINES;
  const [lineIdx, setLineIdx] = useState(0);
  useEffect(() => {
    if (lines.length <= 1) return;
    const t = setInterval(() => setLineIdx((i) => (i + 1) % lines.length), 8000);
    return () => clearInterval(t);
  }, [lines.length]);

  const optimize = async () => {
    const text = input.trim();
    if (!text) {
      setError("请先输入你想做的事，或者想要的东西");
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
    const content = `【本文件由冰山AI资料库 ${SITE_HOST} 用提示词优化神器生成,此行非正文请忽略】\n\n${output}`;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const noid = nanoid(18);

    a.href = url;
    a.download = `PromptOptimizer-${noid}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section id="shenqi" className="relative mb-10 overflow-hidden rounded-3xl border border-blue-400/20">
      {/* 神器背景图（65%透明度；按设备切换横版/竖版） */}
      <div className="shenqi-bg absolute inset-0" style={{ opacity: 0.65 }} />

      <div className="relative px-4 py-8 text-center sm:px-8 sm:py-12">
        {/* 第一行：统计条（单块单行，手机端不换行） */}
        <div className="flex justify-center">
          <span className="inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1.5 text-xs font-medium text-cyan-100 backdrop-blur sm:gap-1.5 sm:px-4 sm:text-sm">
            <b className="font-bold text-white">{siteName}</b>
            <span className="text-cyan-300/50">·</span>
            <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 5a2 2 0 012-2h9l5 5v11a2 2 0 01-2 2H6a2 2 0 01-2-2z" />
              <path d="M14 3v5h5" />
            </svg>
            已存 <b className="font-bold text-white">{promptCount.toLocaleString()}</b> 提示词
            <span className="text-cyan-300/50">·</span>
            <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 2l8 4.5v9L12 20l-8-4.5v-9zM12 11l8-4.5M12 11L4 6.5M12 11v9" />
            </svg>
            已存 <b className="font-bold text-white">{skillCount.toLocaleString()}</b> 技能
          </span>
        </div>

        {/* 第二行：大标题（一行显示完） */}
        <h1 className="mt-6 whitespace-nowrap text-[26px] font-black tracking-tight text-white sm:text-5xl lg:text-6xl">
          <span className="bg-gradient-to-r from-cyan-300 via-sky-400 to-blue-400 bg-clip-text text-transparent">
            神器
          </span>
          <span className="mx-1.5 text-lg font-light text-cyan-200/70 sm:mx-3 sm:text-4xl">·</span>
          全能提示词优化器
        </h1>

        {/* 第三行：英文 */}
        <p className="mt-2.5 whitespace-nowrap text-xs font-bold text-sky-400 sm:text-2xl">
          Master Prompt Optimizer
        </p>

        {/* 补充介绍：宣传语逐条播放（一条快速滚入 → 停留 8 秒 → 下一条；后台可配，默认六条） */}
        <div className="mx-auto mt-3 h-7 max-w-4xl overflow-hidden px-2 text-xs leading-relaxed text-cyan-100/75 sm:h-8 sm:text-sm">
          <p key={lineIdx} className="marquee-enter truncate sm:whitespace-nowrap" title={lines[lineIdx]}>
            {lines[lineIdx]}
          </p>
        </div>

        {/* 第四行：长条蓝光输入框 + 图片化机械按钮 */}
        <div className="mx-auto mt-1 w-full max-w-4xl">
          <div className="optimizer-input-shell relative rounded-[28px] border px-4 py-1.5 pr-[142px] shadow-[0_14px_42px_-18px_rgba(0,12,42,0.9)] transition duration-200 sm:rounded-[34px] sm:px-7 sm:py-2 sm:pr-[206px]">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={2}
              placeholder="请先输入你想做的事，或者想要的东西"
              aria-label="请先输入你想做的事,再来..."
              className="min-h-[76px] w-full resize-y bg-transparent py-4 text-left text-base leading-relaxed text-white outline-none placeholder:text-slate-300/75 focus:placeholder:text-slate-300/60 sm:min-h-[88px] sm:py-5 sm:text-lg"
            />
            <button
              type="button"
              onClick={optimize}
              disabled={loading}
              aria-busy={loading}
              className="optimizer-button group absolute right-[-5px] top-1/2 z-10 flex h-[92px] w-[142px] items-center justify-center text-white transition duration-150 disabled:cursor-not-allowed sm:right-[-8px] sm:h-[126px] sm:w-[204px]"
            >
              <span aria-hidden="true" className="optimizer-button-skin absolute inset-0" />
              <span className="relative z-10 flex items-center gap-2 text-base font-bold drop-shadow-[0_1px_4px_rgba(0,20,70,0.9)] transition-colors group-active:text-cyan-100 sm:gap-3 sm:text-2xl">
                {loading ? (
                  <>
                    <svg className="h-5 w-5 animate-spin sm:h-7 sm:w-7" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    <span className="metal-gradient metal-text">优化中…</span>
                  </>
                ) : (
                  <>
                    <span aria-hidden="true" className="metal-gradient metal-icon h-6 w-6 sm:h-8 sm:w-8" />
                    <span className="metal-gradient metal-text">优化</span>
                  </>
                )}
              </span>
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
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-cyan-50/85 backdrop-blur transition hover:border-cyan-300/40 hover:bg-white/10 sm:text-xs"
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
            <span className="inline-flex min-w-0 items-center gap-px whitespace-nowrap">
              <Image
                src="/site-assets/shu.webp"
                alt=""
                aria-hidden="true"
                width={36}
                height={36}
                className="h-8 w-8 shrink-0 object-contain drop-shadow-[0_0_8px_rgba(251,146,60,0.35)] sm:h-9 sm:w-9"
              />
              {/* 神器输出 GIF：占位只占顶栏一行高（布局不乱），76/82px 画布垂直居中——
                  画布四周透明留白作缓冲，字底不压线，动画帧火星偶尔微出顶线 */}
              <span className="relative inline-flex h-9 w-[76px] shrink-0 items-center justify-center sm:w-[86px]">
                <Image
                  src="/site-assets/shenqi.gif"
                  alt="神器输出"
                  width={418}
                  height={418}
                  className="pointer-events-none absolute left-1/2 top-1/2 z-20 h-[76px] w-[76px] max-w-none -translate-x-1/2 -translate-y-[calc(50%+3px)] select-none sm:h-[82px] sm:w-[82px]"
                />
              </span>
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
          <pre ref={outputRef} className="min-h-[150px] max-h-[240px] overflow-auto whitespace-pre-wrap break-words p-4 font-sans text-xs font-normal leading-relaxed text-white">
            {output || (
              <span className="text-zinc-600">
                神器优化后的专业级提示词将显示在这里（击右上角「复制」或「下载txt」推荐直接下载文档保证完整性）
              </span>
            )}
          </pre>
        </div>
      </div>
    </section>
  );
}
