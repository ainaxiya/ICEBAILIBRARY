"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import RichEditor from "@/components/RichEditor";

const cardCls = "rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 mb-4";
const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-indigo-500";
const labelCls = "mb-1 block text-sm text-zinc-400";

// 多线路 Base URL 行：locked=已保存（URL 锁定不可改，仅可整行删除）
interface RouteRow {
  name: string;
  url: string;
  locked: boolean;
}

// 服务端 routes → 编辑行（已保存的行 URL 全部锁定）
function toRouteRows(routes: Array<{ name?: string; url?: string }> | undefined): RouteRow[] {
  const rs = routes && routes.length ? routes : [{ name: "默认线路", url: "" }];
  return rs.map((r) => ({ name: r.name || "", url: r.url || "", locked: true }));
}

// ─── 后台 · API 文档管理面板 ───
// 「文档设置」：Base URL 多线路（每行 名称+URL，URL 保存后锁定；首条为文档 {{BASE_URL}} 值，各线路域名为 /v1 网关白名单）；
// 「编辑文档内容」：弹层载入当前 html 用 RichEditor 编辑保存（保留 {{BASE_URL}} / {{MODEL_TABLE}} 占位符可保持动态内容）；
// 「恢复默认文档」：confirm 二次确认后 PUT reset，删除自定义内容回到内置默认。
// 保存后 router.refresh() 刷新下方文档预览（ApiDocsContent 为服务端组件）。
export default function ApiDocsAdminPanel() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [html, setHtml] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [editing, setEditing] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/settings/api-docs");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "加载失败");
      setRoutes(toRouteRows(d.routes));
      setHtml(d.html || "");
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flash = (msg: string) => {
    setSaved(msg);
    setTimeout(() => setSaved(""), 2500);
  };

  // 多线路行操作：新增空行（保存前可编辑）、删除任意行、改字段
  const addRoute = () => setRoutes((rs) => [...rs, { name: "", url: "", locked: false }]);
  const removeRoute = (idx: number) => setRoutes((rs) => rs.filter((_, i) => i !== idx));
  const patchRoute = (idx: number, patch: Partial<RouteRow>) =>
    setRoutes((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  // 保存多线路 Base URL（每行：名称 + URL；首行为文档主 Base URL）
  const saveBaseUrl = async () => {
    const payload = routes
      .filter((r) => r.url.trim())
      .map((r) => ({ name: r.name.trim(), url: r.url.trim() }));
    if (!payload.length) {
      alert("请至少填写一条 Base URL");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/admin/settings/api-docs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routes: payload }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "保存失败");
      setRoutes(toRouteRows(d.routes));
      flash("文档设置已保存 ✓");
      router.refresh();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 保存正文（编辑弹层）
  const saveHtml = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/settings/api-docs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "保存失败");
      setEditing(false);
      flash("文档内容已保存 ✓");
      router.refresh();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 恢复默认文档
  const resetDoc = async () => {
    if (!confirm("确定恢复默认文档？当前自定义的 Base URL 线路配置与文档内容将被删除且不可恢复。")) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/settings/api-docs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "操作失败");
      setRoutes(toRouteRows(d.routes));
      setHtml(d.html || "");
      flash("已恢复默认文档 ✓");
      router.refresh();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* 文档设置：Base URL */}
      <div className={cardCls}>
        <h3 className="mb-1 text-sm font-medium text-zinc-300">文档设置 · Base URL 多线路</h3>
        <p className="mb-4 text-xs text-zinc-500">
          每行一条线路（名称 + URL），文档中所有示例的 Base URL 取首条线路（正文里的{" "}
          <code>{"{{BASE_URL}}"}</code> 占位符）。
        </p>
        <div className="space-y-2">
          {routes.map((r, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <div className="w-48">
                <label className={labelCls}>名称{i === 0 ? "（主线路）" : ""}</label>
                <input
                  value={r.name}
                  onChange={(e) => patchRoute(i, { name: e.target.value })}
                  placeholder="中国大陆线网关"
                  className={inputCls}
                  disabled={loading}
                />
              </div>
              <div className="min-w-72 flex-1">
                <label className={labelCls}>URL{r.locked ? "（已锁定）" : ""}</label>
                <input
                  value={r.url}
                  onChange={(e) => patchRoute(i, { url: e.target.value })}
                  placeholder="xinapi.com 或 api.xinapi.com（可一级/二级域名）"
                  className={`${inputCls} font-mono text-xs`}
                  disabled={loading || r.locked}
                />
              </div>
              <button
                type="button"
                onClick={() => removeRoute(i)}
                disabled={loading}
                className="rounded-lg border border-red-800/70 bg-red-950/40 px-3 py-2 text-sm text-red-300 hover:bg-red-900/40 disabled:opacity-50"
              >
                删除
              </button>
            </div>
          ))}
          {loading && !routes.length && <div className="text-sm text-zinc-500">加载中…</div>}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={addRoute}
            disabled={loading}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
          >
            ＋ 新增 Base URL
          </button>
          <button
            type="button"
            onClick={saveBaseUrl}
            disabled={busy || loading}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? "保存中…" : "保存"}
          </button>
          {saved && <span className="text-sm text-emerald-400">{saved}</span>}
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          每条线路的域名即 <code>/v1</code> 网关白名单域名，未配置的域名访问 <code>/v1</code>{" "}
          一律 404 静默隐藏。URL 可填一级或二级域名（如 <code>xinapi.com</code> / <code>api.xinapi.com</code>
          ），保存后锁定不可修改，如需更换请删除后新增。
        </p>
      </div>

      {/* 文档内容：编辑 / 恢复默认 */}
      <div className={cardCls}>
        <h3 className="mb-1 text-sm font-medium text-zinc-300">文档内容</h3>
        <p className="mb-4 text-xs text-zinc-500">
          编辑 API 接口文档正文（富文本）；保留 <code>{"{{BASE_URL}}"}</code> 与{" "}
          <code>{"{{MODEL_TABLE}}"}</code> 占位符可保持动态内容（Base URL 与实时在线模型目录）。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={loading}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
          >
            编辑文档内容
          </button>
          <button
            type="button"
            onClick={resetDoc}
            disabled={busy || loading}
            className="rounded-lg border border-red-800/70 bg-red-950/40 px-4 py-2 text-sm text-red-300 hover:bg-red-900/40 disabled:opacity-50"
          >
            恢复默认文档
          </button>
          {saved && <span className="text-sm text-emerald-400">{saved}</span>}
        </div>
      </div>

      {/* 正文编辑弹层 */}
      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 py-10"
        >
          <div
            className="w-full max-w-4xl rounded-2xl border border-zinc-700 bg-zinc-900 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-base font-bold text-zinc-100">编辑文档内容</h3>
              <button
                onClick={() => setEditing(false)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 transition hover:bg-zinc-700"
              >
                关闭
              </button>
            </div>
            <p className="mb-3 rounded-lg border border-emerald-800/50 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">
              提示：保留 <code>{"{{BASE_URL}}"}</code> 与 <code>{"{{MODEL_TABLE}}"}</code>{" "}
              占位符可保持动态内容（Base URL 与实时在线模型目录）；占位符会在渲染时自动替换。
            </p>
            <RichEditor
              value={html}
              onChange={setHtml}
              placeholder="输入 API 文档正文…"
              minHeight={420}
            />
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={saveHtml}
                disabled={busy}
                className="rounded-lg bg-indigo-600 px-6 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {busy ? "保存中…" : "保存"}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-5 py-2 text-sm text-zinc-300 hover:bg-zinc-700"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
