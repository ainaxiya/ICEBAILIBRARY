"use client";

import { useState } from "react";

type SiteData = {
  siteName: string;
  siteNameEn: string;
  siteDescription: string;
  searchKeywords: string;
  footerText: string;
  logoIcon: string;
  favicon: string;
  appIcon: string;
  optimizerApiKey: string;
  optimizerModel: string;
  optimizerPrompt: string;
  friendLinks: string;
  meiliSyncSeconds: number;
  // 神器滚动文字播放：每行一条宣传语（前端神器区无缝上下滚动）
  rotatingLines: string; // 表单内用换行分隔的字符串
};

type SitemapResult = {
  id: "google" | "bing";
  name: string;
  ok: boolean;
  httpStatus: number;
  message: string;
  durationMs: number;
};

type SitemapRecord = {
  at: string;
  sitemapUrl: string;
  sitemapCheck?: { ok: boolean; httpStatus: number; urlCount: number; message: string };
  results: SitemapResult[];
};

// 外部传入的初始值：rotatingLines 为数组（后端持久化格式）
type SiteInitial = Omit<SiteData, "rotatingLines"> & { rotatingLines: string[] | string };

type Props = {
  initial: SiteInitial;
  sitemapUrl: string;
  lastSitemapSubmit: SitemapRecord | null;
};

const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-indigo-500";
const labelCls = "mb-1 block text-sm text-zinc-400";
const cardCls = "rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 mb-4";

const UPLOAD_FILES = [
  { key: "logoIcon" as const, filename: "logo-icon-120.png", label: "站点 LOGO", hint: "120×120 PNG" },
  { key: "favicon" as const, filename: "favicon.ico", label: "Favicon", hint: "ICO / PNG" },
  { key: "appIcon" as const, filename: "app-icon.png", label: "App 图标", hint: "512×512 PNG" },
];

export default function SiteSettingsForm({ initial, sitemapUrl, lastSitemapSubmit }: Props) {
  // rotatingLines 存储为数组（后端），表单编辑用字符串（每行一条）
  const [f, setF] = useState<SiteData>({
    ...initial,
    rotatingLines: Array.isArray(initial.rotatingLines)
      ? initial.rotatingLines.join("\n")
      : String(initial.rotatingLines || ""),
  });
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [sitemapRecord, setSitemapRecord] = useState<SitemapRecord | null>(lastSitemapSubmit);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const set = (k: keyof SiteData, v: any) => setF({ ...f, [k]: v });

  const submitSitemap = async (engine: "google" | "bing" | "all") => {
    setSubmitting(engine);
    try {
      const r = await fetch("/api/admin/settings/sitemap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "提交失败");
      setSitemapRecord({
        at: d.at,
        sitemapUrl: d.sitemapUrl,
        sitemapCheck: d.sitemapCheck,
        results: d.results || [],
      });
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSubmitting(null);
    }
  };

  const copySitemap = async () => {
    try {
      await navigator.clipboard.writeText(sitemapUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      alert("复制失败，请手动复制：" + sitemapUrl);
    }
  };

  const testOptimizer = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch("/api/admin/settings/optimizer-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: f.optimizerApiKey }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || d.message || "连接失败");
      setTestResult({ ok: !!d.ok, msg: d.message || (d.ok ? "连接成功" : "连接失败") });
    } catch (e) {
      setTestResult({ ok: false, msg: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const save = async (override?: Partial<SiteData>) => {
    const data: SiteData = { ...f, ...override };
    setBusy(true);
    try {
      // rotatingLines 以 textarea 字符串存储，保存时按行拆分为数组（空→空数组=前端用默认六条）
      const payload: any = {
        ...data,
        rotatingLines: data.rotatingLines
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean),
      };
      const r = await fetch("/api/admin/settings/site", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || "保存失败");
      }
      setOk(true);
      setTimeout(() => setOk(false), 2000);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 浏览器侧实际加载一次图片 URL，杜绝"接口 200 但文件 404"的假成功
  const probeImage = (url: string) =>
    new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve();
      img.onerror = () =>
        reject(new Error("文件已保存到服务器，但返回的图片地址无法访问（HTTP 404），请重新部署后再试"));
      img.src = url;
    });

  const upload = async (key: "logoIcon" | "favicon" | "appIcon", filename: string, file: File, maxMB = 2) => {
    setUploading(key);
    try {
      if (file.size > maxMB * 1024 * 1024) {
        alert(`文件大小不能超过 ${maxMB}MB`);
        return;
      }
      const fd = new FormData();
      fd.append("file", file);
      fd.append("filename", filename);
      const r = await fetch("/api/admin/settings/upload", { method: "POST", body: fd });
      // 容错：服务端异常时可能返回空响应体或 HTML（如 Nginx 413），不能直接 r.json()
      const text = await r.text();
      let d: any = null;
      try {
        d = text ? JSON.parse(text) : null;
      } catch {
        d = null;
      }
      if (!r.ok || !d) {
        const hint =
          r.status === 413
            ? "文件超过 Nginx 上传限制（需调大 client_max_body_size）"
            : !text
              ? `服务器无响应（HTTP ${r.status}），可能是 public 目录无写入权限`
              : text.slice(0, 200);
        throw new Error(d?.error || hint || "上传失败");
      }
      // 先验证 URL 真的可访问，再更新表单并自动持久化（无需再手动点保存）
      await probeImage(d.url);
      const next = { ...f, [key]: d.url } as SiteData;
      setF(next);
      await save(next);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setUploading(null);
    }
  };

  return (
    <div className="max-w-3xl">
      {/* 基本信息 */}
      <div className={cardCls}>
        <h3 className="mb-4 text-sm font-medium text-zinc-300">基本信息</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>网站名称</label>
            <input
              value={f.siteName}
              onChange={(e) => set("siteName", e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>英文名称</label>
            <input
              value={f.siteNameEn}
              onChange={(e) => set("siteNameEn", e.target.value)}
              className={inputCls}
            />
          </div>
        </div>
        <div className="mt-4">
          <label className={labelCls}>网站介绍</label>
          <textarea
            value={f.siteDescription}
            onChange={(e) => set("siteDescription", e.target.value)}
            rows={3}
            className={inputCls}
            placeholder="用于 SEO description 与首页展示"
          />
        </div>
        <div className="mt-4">
          <label className={labelCls}>搜索关键字</label>
          <input
            value={f.searchKeywords}
            onChange={(e) => set("searchKeywords", e.target.value)}
            className={inputCls}
            placeholder="逗号分隔，如：AI提示词,ChatGPT,文生图"
          />
        </div>
        <div className="mt-4">
          <label className={labelCls}>页脚文字</label>
          <input
            value={f.footerText}
            onChange={(e) => set("footerText", e.target.value)}
            className={inputCls}
          />
        </div>
      </div>

      {/* 搜索同步 */}
      <div className={cardCls}>
        <h3 className="mb-1 text-sm font-medium text-zinc-300">搜索索引（Meilisearch）</h3>
        <p className="mb-4 text-xs text-zinc-500">
          后台常驻同步进程会按此间隔把已发布提示词的增删改增量推送到 Meilisearch；保存后下一个轮询周期生效。
        </p>
        <div className="flex items-end gap-3">
          <div className="w-40">
            <label className={labelCls}>自动同步间隔（秒）</label>
            <input
              type="number"
              min={0}
              max={86400}
              value={f.meiliSyncSeconds ?? 30}
              onChange={(e) =>
                set("meiliSyncSeconds", Math.max(0, Math.min(86400, parseInt(e.target.value) || 0)))
              }
              className={inputCls}
            />
          </div>
          <div className="pb-2 text-xs text-zinc-500">
            建议 10~60 秒；<span className="text-amber-300">填 0 关闭自动同步</span>（仅保留手动重建索引）
          </div>
        </div>
      </div>

      {/* 图标上传 */}
      <div className={cardCls}>
        <h3 className="mb-4 text-sm font-medium text-zinc-300">站点图标</h3>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          {UPLOAD_FILES.map((u) => {
            const url = f[u.key];
            const isFavicon = u.key === "favicon";
            return (
              <div key={u.key} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
                <label className="mb-2 block text-xs text-zinc-400">{u.label}</label>
                <div className="mb-2 flex h-20 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
                  {url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={url}
                      alt={u.label}
                      className={isFavicon ? "h-8 w-8" : "max-h-16 max-w-full"}
                    />
                  ) : (
                    <span className="text-xs text-zinc-600">未上传</span>
                  )}
                </div>
                <p className="mb-2 text-xs text-zinc-500">{u.hint}</p>
                <input
                  type="file"
                  accept={isFavicon ? ".ico,.png,image/*" : "image/png,image/webp"}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) upload(u.key, u.filename, file);
                    e.target.value = "";
                  }}
                  className="hidden"
                  id={`upload-${u.key}`}
                />
                <label
                  htmlFor={`upload-${u.key}`}
                  className="block cursor-pointer rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-center text-xs text-zinc-300 hover:bg-zinc-700"
                >
                  {uploading === u.key ? "上传中…" : url ? "替换文件" : "选择上传"}
                </label>
                {url && (
                  <p className="mt-1.5 truncate text-center text-xs text-emerald-400">{url}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 神器·全能提示词优化器 */}
      <div className={cardCls}>
        <h3 className="mb-1 text-sm font-medium text-zinc-300">神器·全能提示词优化器</h3>
        <p className="mb-4 text-xs text-zinc-500">
          首页优化器工具调用 DeepSeek 模型，按内置技能文档把用户的大白话重构为专业级提示词。仅需填写 API Key，其余为默认配置。
        </p>
        <div className="space-y-4">
          <div>
            <label className={labelCls}>API 接口（OpenAI 兼容）</label>
            <input value="https://api.deepseek.com" readOnly className={`${inputCls} cursor-default opacity-70`} />
          </div>
          <div>
            <label className={labelCls}>API 接口（Anthropic 兼容）</label>
            <input value="https://api.deepseek.com/anthropic" readOnly className={`${inputCls} cursor-default opacity-70`} />
          </div>
          <div>
            <label className={labelCls}>模型</label>
            <input value={f.optimizerModel || "deepseek-flash"} readOnly className={`${inputCls} cursor-default opacity-70`} />
          </div>
          <div>
            <label className={labelCls}>API Key</label>
            <input
              type="password"
              value={f.optimizerApiKey}
              onChange={(e) => set("optimizerApiKey", e.target.value)}
              className={inputCls}
              placeholder="sk-…（留空则使用服务器环境变量 DEEPSEEK_API_KEY）"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={testOptimizer}
              disabled={testing}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
            >
              {testing ? "测试中…" : "连接测试"}
            </button>
            {testResult && (
              <span className={testResult.ok ? "text-sm text-emerald-400" : "text-sm text-amber-400"}>
                {testResult.msg}
              </span>
            )}
          </div>
          <div>
            <label className={labelCls}>神器滚动文字播放</label>
            <p className="mb-2 text-xs text-zinc-500">
              首页与神器单页工具区的多条宣传语，将无缝上下滚动展示。每行一条；留空则使用内置默认六条；保存后前台立即生效。
            </p>
            <textarea
              value={f.rotatingLines}
              onChange={(e) => set("rotatingLines", e.target.value)}
              rows={6}
              placeholder={"每行一条宣传语，例如：\n把你的任意大白话瞬间重构为视频 设计 编程 写作 音乐 办公 营销 金融等全行业提示词\n想做AI视频？AI设计？又不懂步骤，直接问神器，神器给你保姆级教学+预算成本"}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>优化技能文档（System Prompt）</label>
            <p className="mb-2 text-xs text-zinc-500">
              优化器调用模型时的技能文档，可随时修改更新。留空则使用内置 PromptOptimizer v2.0（8 领域专家知识库 + 负向清单）；填写后立即覆盖内置文档。
            </p>
            <textarea
              value={f.optimizerPrompt}
              onChange={(e) => set("optimizerPrompt", e.target.value)}
              rows={12}
              className={`${inputCls} font-mono text-xs leading-relaxed`}
              placeholder={"留空 = 使用内置 PromptOptimizer v2.0 技能文档\n\n如需自定义，直接粘贴完整的 System Prompt（Markdown 格式），保存后立即生效"}
            />
            <p className="mt-1.5 text-xs text-zinc-500">
              当前生效：{f.optimizerPrompt.trim() ? `自定义文档（${f.optimizerPrompt.trim().length} 字符）` : "内置 PromptOptimizer v2.0"}　
              <button
                type="button"
                onClick={() => set("optimizerPrompt", "")}
                className="text-amber-400 underline underline-offset-2 hover:text-amber-300"
              >
                恢复内置默认（清空此框并保存）
              </button>
            </p>
          </div>
        </div>
      </div>

      {/* 友情链接 */}
      <div className={cardCls}>
        <h3 className="mb-1 text-sm font-medium text-zinc-300">友情链接</h3>
        <p className="mb-4 text-xs text-zinc-500">
          每行一条，格式「名称|URL」（仅 http/https），前台页脚版权上方显示一排小字，最多取前 20 条。
        </p>
        <textarea
          value={f.friendLinks}
          onChange={(e) => set("friendLinks", e.target.value)}
          rows={4}
          className={inputCls}
          placeholder={"示例：\n完整提示词|https://www.wango8.com\nAI导航|https://example.com"}
        />
      </div>

      {/* Sitemaps 提交 */}
      <div className={cardCls}>
        <h3 className="mb-1 text-sm font-medium text-zinc-300">Sitemaps（搜索引擎提交）</h3>
        <p className="mb-4 text-xs text-zinc-500">
          站点已自动生成 sitemap.xml，并在 robots.txt 中声明。点击下方按钮把 sitemap 地址推送给搜索引擎。
        </p>

        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
          <span className="text-xs text-zinc-500">Sitemap 地址</span>
          <a
            href={sitemapUrl}
            target="_blank"
            rel="noreferrer"
            className="break-all text-xs text-indigo-400 hover:text-indigo-300"
          >
            {sitemapUrl}
          </a>
          <button
            type="button"
            onClick={copySitemap}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            {copied ? "已复制 ✓" : "复制"}
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => submitSitemap("google")}
            disabled={!!submitting}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {submitting === "google" ? "提交中…" : "提交到 Google"}
          </button>
          <button
            type="button"
            onClick={() => submitSitemap("bing")}
            disabled={!!submitting}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
          >
            {submitting === "bing" ? "提交中…" : "提交到 Bing"}
          </button>
          <button
            type="button"
            onClick={() => submitSitemap("all")}
            disabled={!!submitting}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
          >
            {submitting === "all" ? "提交中…" : "全部提交"}
          </button>
        </div>

        <p className="mt-3 text-xs text-zinc-500">
          Google 已于 2023 年停止 sitemap ping 接口（返回 404 属正常）。真实生效方式：
          <a
            href="https://search.google.com/search-console/sitemaps"
            target="_blank"
            rel="noreferrer"
            className="mx-1 text-indigo-400 hover:text-indigo-300"
          >
            Search Console → Sitemaps
          </a>
          里粘贴上面的地址手动提交。
        </p>

        {sitemapRecord && (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-zinc-400">
                上次提交：{new Date(sitemapRecord.at).toLocaleString("zh-CN")}
              </span>
              {sitemapRecord.sitemapCheck && (
                <span
                  className={
                    sitemapRecord.sitemapCheck.ok
                      ? "text-xs text-emerald-400"
                      : "text-xs text-amber-400"
                  }
                >
                  {sitemapRecord.sitemapCheck.message}
                </span>
              )}
            </div>
            <ul className="space-y-1.5">
              {sitemapRecord.results.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start gap-2 text-xs">
                  <span
                    className={
                      r.ok
                        ? "rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-400"
                        : "rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-400"
                    }
                  >
                    {r.name} · HTTP {r.httpStatus || "—"}
                  </span>
                  <span className="flex-1 text-zinc-400">{r.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* 保存按钮 */}
      <div className="mb-6">
        <button
          onClick={() => save()}
          disabled={busy}
          className="rounded-lg bg-indigo-600 px-6 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? "保存中…" : "保存设置"}
        </button>
        {ok && <span className="ml-3 text-sm text-emerald-400">已保存 ✓</span>}
      </div>
    </div>
  );
}
