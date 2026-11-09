"use client";

import { useState } from "react";

type Bucket = {
  id: number;
  name: string;
  type: string;
  endpoint: string;
  region: string | null;
  bucket: string;
  accessKey: string;
  publicBaseUrl: string | null;
  isDefault: boolean;
  enabled: boolean;
  downloadCount?: number;
};

const emptyForm = {
  name: "", type: "minio", endpoint: "", region: "", bucket: "",
  accessKey: "", secretKey: "", publicBaseUrl: "", isDefault: false, enabled: true,
};

// 安全 JSON 解析：空响应/非 JSON 响应给出可读错误，而不是 "Unexpected end of JSON input"
async function readJson(r: Response) {
  const txt = await r.text();
  let d: any = null;
  try { d = txt ? JSON.parse(txt) : null; } catch { /* 非 JSON 响应 */ }
  if (!d) throw new Error(txt ? `服务器返回异常响应（HTTP ${r.status}）` : `服务器无响应（HTTP ${r.status}）`);
  return d;
}

export default function StorageManager({ initial }: { initial: Bucket[] }) {
  const [rows, setRows] = useState<Bucket[]>(initial);
  const [editing, setEditing] = useState<Bucket | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const flash = (kind: "ok" | "err", text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 4000);
  };

  const set = (k: keyof typeof emptyForm, v: string | boolean) =>
    setForm((f) => ({ ...f, [k]: v }));

  const openCreate = () => {
    setEditing(null);
    setForm({ ...emptyForm });
    setShowForm(true);
  };

  const openEdit = (b: Bucket) => {
    setEditing(b);
    setForm({
      name: b.name, type: b.type, endpoint: b.endpoint, region: b.region || "",
      bucket: b.bucket, accessKey: b.accessKey, secretKey: "",
      publicBaseUrl: b.publicBaseUrl || "", isDefault: b.isDefault, enabled: b.enabled,
    });
    setShowForm(true);
  };

  const testConn = async () => {
    setTesting(true);
    try {
      // 新建（或表单改了 SK）→ 直测表单配置；编辑且 SK 留空 → 用库内配置测
      const useFormConfig = !editing || form.secretKey.trim() !== "" || form.endpoint !== editing.endpoint;
      let r: Response;
      if (useFormConfig) {
        r = await fetch("/api/admin/storage/buckets/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: form.endpoint, region: form.region, bucket: form.bucket,
            accessKey: form.accessKey, secretKey: form.secretKey,
          }),
        });
      } else {
        r = await fetch(`/api/admin/storage/buckets/${editing!.id}/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: form.endpoint, region: form.region, bucket: form.bucket, accessKey: form.accessKey,
          }),
        });
      }
      const d = await readJson(r);
      if (d.ok) flash("ok", `连接成功${d.sampleKeys?.length ? `，桶内已有 ${d.sampleKeys.length} 个对象` : "（空桶）"}`);
      else flash("err", `连接失败：${d.error || "未知错误"}`);
    } catch (e) {
      flash("err", `连接失败：${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    if (!form.name.trim() || !form.endpoint.trim() || !form.bucket.trim() || !form.accessKey.trim()) {
      flash("err", "名称/端点/桶名/AccessKey 均为必填");
      return;
    }
    if (!editing && !form.secretKey.trim()) {
      flash("err", "新建必须填写 SecretKey");
      return;
    }
    setBusy(true);
    try {
      const payload = { ...form, region: form.region.trim() || null, publicBaseUrl: form.publicBaseUrl.trim() || null };
      if (editing) {
        const r = await fetch(`/api/admin/storage/buckets/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const d = await readJson(r);
        if (!r.ok) throw new Error(d.error || "保存失败");
        setRows((prev) =>
          prev.map((b) =>
            b.id === editing.id
              ? { ...b, ...payload, region: payload.region, publicBaseUrl: payload.publicBaseUrl }
              : payload.isDefault ? { ...b, isDefault: false } : b
          )
        );
        flash("ok", "已更新");
      } else {
        const r = await fetch("/api/admin/storage/buckets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const d = await readJson(r);
        if (!r.ok) throw new Error(d.error || "创建失败");
        setRows((prev) => [
          ...(payload.isDefault ? prev.map((b) => ({ ...b, isDefault: false })) : prev),
          {
            id: d.id, name: payload.name, type: payload.type, endpoint: payload.endpoint,
            region: payload.region, bucket: payload.bucket, accessKey: payload.accessKey,
            publicBaseUrl: payload.publicBaseUrl, isDefault: payload.isDefault,
            enabled: payload.enabled, downloadCount: 0,
          },
        ]);
        flash("ok", "已创建");
      }
      setShowForm(false);
    } catch (e) {
      flash("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (b: Bucket) => {
    if (!confirm(`确定删除存储桶「${b.name}」吗？\n已被软件下载引用时无法删除。`)) return;
    try {
      const r = await fetch(`/api/admin/storage/buckets/${b.id}`, { method: "DELETE" });
      const d = await readJson(r);
      if (!r.ok) throw new Error(d.error || "删除失败");
      setRows((prev) => prev.filter((x) => x.id !== b.id));
      flash("ok", "已删除");
    } catch (e) {
      flash("err", (e as Error).message);
    }
  };

  const inputCls = "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500";
  const labelCls = "mb-1 block text-xs text-zinc-400";

  return (
    <div>
      {msg && (
        <div className={`mb-3 rounded-lg px-3 py-2 text-sm ${msg.kind === "ok" ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}>
          {msg.text}
        </div>
      )}

      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-zinc-400">共 {rows.length} 个存储桶</p>
        <button type="button" onClick={openCreate} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500">
          + 新增存储桶
        </button>
      </div>

      {showForm && (
        <div className="mb-5 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="mb-3 text-sm font-medium">{editing ? `编辑存储桶「${editing.name}」` : "新增存储桶"}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls}>备注名 *</label>
              <input value={form.name} onChange={(e) => set("name", e.target.value)} className={inputCls} placeholder="如：MinIO主桶" />
            </div>
            <div>
              <label className={labelCls}>类型</label>
              <select value={form.type} onChange={(e) => set("type", e.target.value)} className={inputCls}>
                <option value="minio">MinIO</option>
                <option value="s3">Amazon S3 / 兼容</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Endpoint *</label>
              <input
                value={form.endpoint}
                onChange={(e) => set("endpoint", e.target.value)}
                className={inputCls}
                placeholder={form.type === "s3" ? "https://s3.ap-southeast-1.amazonaws.com" : "https://minio.example.com"}
              />
              {form.type === "s3" && (
                <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">
                  亚马逊 S3 需填区域端点：https://s3.&lt;区域&gt;.amazonaws.com（如 s3.ap-southeast-1），不能填 amazonaws.com
                </p>
              )}
            </div>
            <div>
              <label className={labelCls}>Region（S3 必填，MinIO 可空）</label>
              <input value={form.region} onChange={(e) => set("region", e.target.value)} className={inputCls} placeholder="us-east-1" />
            </div>
            <div>
              <label className={labelCls}>Bucket 名 *</label>
              <input value={form.bucket} onChange={(e) => set("bucket", e.target.value)} className={inputCls} placeholder="iceberg-soft" />
            </div>
            <div>
              <label className={labelCls}>公开读 CDN 域名（可选）</label>
              <input value={form.publicBaseUrl} onChange={(e) => set("publicBaseUrl", e.target.value)} className={inputCls} placeholder="https://cdn.example.com" />
            </div>
            <div>
              <label className={labelCls}>AccessKey *</label>
              <input value={form.accessKey} onChange={(e) => set("accessKey", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>SecretKey {editing ? "（留空 = 不修改）" : "*"}</label>
              <input type="password" value={form.secretKey} onChange={(e) => set("secretKey", e.target.value)} className={inputCls} placeholder={editing ? "已加密保存，不回显" : ""} autoComplete="new-password" />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-zinc-300">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={form.isDefault} onChange={(e) => set("isDefault", e.target.checked)} />
              设为默认桶
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
              启用
            </label>
          </div>
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={submit} disabled={busy} className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50">
              {busy ? "保存中..." : "保存"}
            </button>
            <button type="button" onClick={testConn} disabled={testing} className="rounded-lg border border-sky-700 px-4 py-1.5 text-sm text-sky-300 hover:bg-sky-900/40 disabled:opacity-50">
              {testing ? "测试中..." : "测试连接"}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">
              取消
            </button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <th className="px-4 py-3">备注名</th>
              <th className="px-4 py-3">类型</th>
              <th className="px-4 py-3">Endpoint / Bucket</th>
              <th className="px-4 py-3 w-20">引用数</th>
              <th className="px-4 py-3 w-28">状态</th>
              <th className="px-4 py-3 w-32 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-zinc-600">
                  暂无存储桶，点击右上角「新增存储桶」开始配置
                </td>
              </tr>
            )}
            {rows.map((b) => (
              <tr key={b.id} className="hover:bg-zinc-800/30">
                <td className="px-4 py-3 font-medium text-zinc-100">
                  {b.name}
                  {b.isDefault && (
                    <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400">默认</span>
                  )}
                </td>
                <td className="px-4 py-3 text-zinc-400">{b.type === "s3" ? "S3" : "MinIO"}</td>
                <td className="px-4 py-3 text-zinc-400">
                  <div className="max-w-xs truncate" title={`${b.endpoint}/${b.bucket}`}>
                    {b.endpoint}<span className="text-zinc-600">/</span><span className="text-zinc-300">{b.bucket}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">{b.downloadCount ?? 0}</span>
                </td>
                <td className="px-4 py-3">
                  {b.enabled ? (
                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-400">启用</span>
                  ) : (
                    <span className="rounded bg-zinc-700/50 px-1.5 py-0.5 text-xs text-zinc-500">停用</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <button type="button" onClick={() => openEdit(b)} className="mr-2 text-sky-400 hover:underline">编辑</button>
                  <button type="button" onClick={() => remove(b)} className="text-rose-400 hover:underline">删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
