"use client";

// 用户管理（前台会员）：搜索、新建、等级调整、快速启禁用/发布权限、批量操作；详情走独立页
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import OptionDropdown from "@/components/OptionDropdown";
import Pagination from "@/components/Pagination";
import UserAvatar from "@/components/UserAvatar";
import MembershipLevelManager from "@/components/admin/MembershipLevelManager";
import { adminFetch } from "@/lib/admin-fetch";

type Row = {
  id: number;
  username: string;
  email: string | null;
  phone: string | null;
  nickname: string | null;
  avatar: string | null;
  bio: string | null;
  // v0.96 会员资料扩展字段（联系方式/个人档案）
  wechat: string | null;
  qq: string | null;
  telegram: string | null;
  birthday: string | null;
  gender: string | null;
  nationality: string | null;
  countryCode: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  address: string | null;
  postalCode: string | null;
  website: string | null;
  locale: string | null;
  timezone: string | null;
  status: string;
  allowPublish: boolean;
  commentBanned: boolean;
  // 账号等级（普通等级，可在行内直接调整）
  membershipLevel: string;
  membership?: { code: string; name: string; isSystem: boolean } | null;
  registerIp: string | null;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdAt: string;
  _count: { prompts: number; apiKeys: number };
};

const STATUS_OPTS = [
  { value: "active", label: "有效", tone: "green" as const },
  { value: "banned", label: "禁止", tone: "red" as const },
];
const PUBLISH_OPTS = [
  { value: "yes", label: "允许发布", tone: "green" as const },
  { value: "no", label: "禁止发布", tone: "amber" as const },
];
const COMMENT_OPTS = [
  { value: "yes", label: "允许评论", tone: "green" as const },
  { value: "no", label: "禁言", tone: "red" as const },
];

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : "—");
const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-950/80 px-3 py-2 text-sm outline-none focus:border-indigo-500";
const labelCls = "mb-1 block text-xs text-zinc-400";

export default function UserManager() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  // 表格勾选（批量操作）与批量请求进行中标记
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  // 可授予的普通等级（系统等级不展示）
  const [levels, setLevels] = useState<{ code: string; name: string }[]>([]);
  const [showLevels, setShowLevels] = useState(false);
  // 列表范围：全部 / 普通会员 / 系统账号（默认全部，保证没有任何行不可见）
  const [scope, setScope] = useState<"all" | "regular" | "system">("all");
  const [scopeCounts, setScopeCounts] = useState({ all: 0, regular: 0, system: 0 });
  const [levelCounts, setLevelCounts] = useState<
    { code: string; name: string; isSystem: boolean; isActive: boolean; count: number }[]
  >([]);

  useEffect(() => {
    fetch("/api/admin/membership-levels?regular=1")
      .then((r) => r.json())
      .then((d) => setLevels((d.list || []).filter((l: { isActive: boolean }) => l.isActive)))
      .catch(() => {});
  }, []);

  // 运营告警里的会员链接：/guanli-7k2m9x/users?q=<账号名>，进入后自动带入搜索；
  // 同时恢复筛选与分页（详情页返回时保留现场）。
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const urlQ = sp.get("q");
    if (urlQ) setQ(urlQ);
    const urlPage = parseInt(sp.get("page") || "", 10);
    if (Number.isInteger(urlPage) && urlPage > 0) setPage(urlPage);
    const urlScope = sp.get("scope");
    if (urlScope === "all" || urlScope === "regular" || urlScope === "system") setScope(urlScope);
  }, []);

  // 把当前筛选/分页同步到地址栏（首次渲染跳过，避免覆盖已恢复的 query）
  const urlSynced = useRef(false);
  useEffect(() => {
    if (!urlSynced.current) {
      urlSynced.current = true;
      return;
    }
    const ps = new URLSearchParams();
    if (q) ps.set("q", q);
    if (page > 1) ps.set("page", String(page));
    if (scope !== "all") ps.set("scope", scope);
    const qs = ps.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, [q, page, scope]);

  const load = useCallback(async () => {
    const ps = new URLSearchParams({ page: String(page), scope });
    if (q) ps.set("q", q);
    const r = await fetch("/api/admin/users?" + ps.toString()).then((x) => x.json());
    setRows(r.list || []);
    setTotal(r.total || 0);
    setScopeCounts(r.scopeCounts || { all: 0, regular: 0, system: 0 });
    setLevelCounts(r.levelCounts || []);
    // 列表刷新后清空勾选，避免残留已变更/已删除的 id
    setSelected(new Set());
  }, [page, q, scope]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = async (id: number, data: Record<string, unknown>) => {
    const r = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      alert(d.error || "操作失败");
      load();
      return true;
    }
    return false;
  };

  // 当前页勾选状态（全选/半选依据）
  const pageSelectedCount = rows.filter((u) => selected.has(u.id)).length;
  const allSelected = rows.length > 0 && pageSelectedCount === rows.length;

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) rows.forEach((u) => next.delete(u.id));
      else rows.forEach((u) => next.add(u.id));
      return next;
    });
  };

  // 批量操作：调批量接口，完成后刷新列表
  const batch = async (action: "status" | "allowPublish" | "commentBanned" | "delete", value?: boolean | string) => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (action === "delete") {
      if (!confirm(`确认删除选中的 ${ids.length} 个会员？仅删除名下无提示词的账号，有提示词的将跳过。`)) return;
    }
    setBatchBusy(true);
    try {
      const r = await adminFetch("/api/admin/users/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, value, ids }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(d.error || "批量操作失败");
        return;
      }
      if (d.skipped) {
        alert(`批量删除完成：成功 ${d.affected} 个，跳过 ${d.skipped} 个（有提示词或非会员账号）`);
      }
      load();
    } finally {
      setBatchBusy(false);
    }
  };

  const totalPages = Math.ceil(total / 30);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            load();
          }}
          className="flex gap-2"
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="账号 / 昵称 / 邮箱 / 手机号搜索…"
            className="min-w-[160px] flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 sm:min-w-[220px]"
          />
          <button className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">
            查询
          </button>
        </form>
        <div className="flex gap-2">
          <button
            onClick={() => setShowLevels(true)}
            className="rounded-lg border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:border-indigo-600 hover:text-indigo-300"
          >
            等级管理
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
          >
            + 新建会员
          </button>
        </div>
      </div>

      {/* 范围切换 + 各等级行数：全部视图确保没有任何 User 行不可见 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(
          [
            { key: "all", label: "全部", count: scopeCounts.all },
            { key: "regular", label: "普通会员", count: scopeCounts.regular },
            { key: "system", label: "系统账号", count: scopeCounts.system },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setScope(t.key);
              setPage(1);
            }}
            className={
              "rounded-lg px-3 py-1.5 text-xs " +
              (scope === t.key
                ? "bg-indigo-600 text-white"
                : "border border-zinc-700 text-zinc-400 hover:text-zinc-200")
            }
          >
            {t.label} {t.count}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {levelCounts.map((l) => (
            <span
              key={l.code}
              className="rounded-full border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 text-xs text-zinc-400"
              title={`${l.code}${l.isSystem ? "（系统等级）" : ""}${l.isActive ? "" : "（已停用）"}`}
            >
              {l.name} <b className="text-zinc-200">{l.count}</b>
            </span>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-zinc-900/70 text-left text-xs text-zinc-500">
            <tr>
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  // 全选/半选（当前页部分勾选时显示半选态）
                  ref={(el) => {
                    if (el) el.indeterminate = pageSelectedCount > 0 && !allSelected;
                  }}
                  checked={allSelected}
                  onChange={toggleAll}
                  className="h-4 w-4 accent-indigo-500"
                  aria-label="全选当前页"
                />
              </th>
              <th className="px-4 py-3">账号</th>
              <th className="px-4 py-3">昵称</th>
              <th className="px-4 py-3">等级</th>
              <th className="px-4 py-3">邮箱</th>
              <th className="px-4 py-3">手机号</th>
              <th className="px-4 py-3">发布权限</th>
              <th className="px-4 py-3">评论</th>
              <th className="px-4 py-3">状态</th>
              <th className="px-4 py-3">提示词</th>
              <th className="px-4 py-3">KEY 数</th>
              <th className="px-4 py-3">注册时间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              const sys = Boolean(u.membership?.isSystem);
              return (
              <tr
                key={u.id}
                onClick={() => {
                  if (!sys) router.push(`/guanli-7k2m9x/users/${u.id}`);
                }}
                className={
                  "border-t border-zinc-800/70 " +
                  (sys ? "bg-zinc-950/40" : "cursor-pointer hover:bg-zinc-900/40")
                }
              >
                <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(u.id)}
                    onChange={() => toggleOne(u.id)}
                    disabled={sys}
                    className="h-4 w-4 accent-indigo-500 disabled:opacity-30"
                    aria-label={`选择 ${u.username}`}
                  />
                </td>
                <td className="px-4 py-2.5 font-medium text-zinc-200">
                  <span className="flex items-center gap-2">
                    <UserAvatar src={u.avatar} name={u.username} size={26} />
                    {u.username}
                    {sys && (
                      <span className="rounded bg-amber-950/60 px-1.5 py-0.5 text-xs text-amber-400">
                        系统等级
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-zinc-400">{u.nickname || "—"}</td>
                <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                  {sys ? (
                    <span className="text-xs text-amber-400/80">{u.membership?.name || u.membershipLevel}（只读）</span>
                  ) : (
                    <OptionDropdown
                      value={u.membershipLevel}
                      options={levels.map((l) => ({ value: l.code, label: l.name }))}
                      onChange={(v) => patch(u.id, { membershipLevel: v })}
                    />
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-500">{u.email || "—"}</td>
                <td className="px-4 py-2.5 text-xs text-zinc-500">{u.phone || "—"}</td>
                <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <OptionDropdown
                    value={u.allowPublish ? "yes" : "no"}
                    options={PUBLISH_OPTS}
                    onChange={(v) => patch(u.id, { allowPublish: v === "yes" })}
                  />
                </td>
                <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <OptionDropdown
                    value={u.commentBanned ? "no" : "yes"}
                    options={COMMENT_OPTS}
                    onChange={(v) => patch(u.id, { commentBanned: v === "no" })}
                  />
                </td>
                <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <OptionDropdown
                    value={u.status}
                    options={STATUS_OPTS}
                    onChange={(v) => patch(u.id, { status: v })}
                  />
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-400">{u._count?.prompts ?? 0}</td>
                <td className="px-4 py-2.5 text-xs text-zinc-400">{u._count?.apiKeys ?? 0}</td>
                <td className="px-4 py-2.5 text-xs text-zinc-500">{fmt(u.createdAt)}</td>
              </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={12} className="px-4 py-10 text-center text-sm text-zinc-600">
                  暂无数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPage={(n) => setPage(n)} />

      {/* 批量操作条：勾选后浮出 */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-2xl border border-zinc-700 bg-zinc-900/95 px-4 py-3 shadow-2xl">
          <span className="mr-1 text-xs text-zinc-400">已选 {selected.size} 项</span>
          <button
            onClick={() => batch("status", "active")}
            disabled={batchBusy}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
          >
            启用
          </button>
          <button
            onClick={() => batch("status", "banned")}
            disabled={batchBusy}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
          >
            禁用
          </button>
          <button
            onClick={() => batch("allowPublish", true)}
            disabled={batchBusy}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
          >
            允许发布
          </button>
          <button
            onClick={() => batch("allowPublish", false)}
            disabled={batchBusy}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
          >
            禁止发布
          </button>
          <button
            onClick={() => batch("commentBanned", false)}
            disabled={batchBusy}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
          >
            允许评论
          </button>
          <button
            onClick={() => batch("commentBanned", true)}
            disabled={batchBusy}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
          >
            禁言
          </button>
          <button
            onClick={() => batch("delete")}
            disabled={batchBusy}
            className="rounded-lg border border-rose-800/70 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-950/40 disabled:opacity-40"
          >
            批量删除
          </button>
          <button
            onClick={() => setSelected(new Set())}
            disabled={batchBusy}
            className="rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-40"
          >
            取消
          </button>
        </div>
      )}

      {showLevels && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4 py-10">
          <div className="mx-auto w-full max-w-6xl rounded-2xl border border-zinc-800 bg-[#0f1630] p-4 shadow-2xl sm:p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-bold text-zinc-100">等级管理</h2>
              <button
                onClick={() => {
                  setShowLevels(false);
                  load();
                }}
                className="text-zinc-500 hover:text-zinc-200"
              >
                ✕
              </button>
            </div>
            <MembershipLevelManager />
          </div>
        </div>
      )}
      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onDone={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 py-10">
      <div
        className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-[#0f1630] p-4 shadow-2xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-zinc-100">{title}</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CreateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    username: "",
    password: "",
    nickname: "",
    email: "",
    phone: "",
    status: "active",
    allowPublish: true,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    setBusy(true);
    try {
      const r = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(f),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "创建失败");
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title="新建会员" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>账号（唯一，3-20 位字母数字下划线）</label>
          <input className={inputCls} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>初始密码（至少 6 位）</label>
          <input className={inputCls} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </div>
        <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
          <div>
            <label className={labelCls}>昵称</label>
            <input className={inputCls} value={f.nickname} onChange={(e) => setF({ ...f, nickname: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>手机号</label>
            <input className={inputCls} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </div>
        </div>
        <div>
          <label className={labelCls}>邮箱</label>
          <input className={inputCls} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </div>
        <div className="flex gap-6">
          <div>
            <label className={labelCls}>账户状态</label>
            <OptionDropdown value={f.status} options={STATUS_OPTS} onChange={(v) => setF({ ...f, status: v })} size="md" />
          </div>
          <div>
            <label className={labelCls}>发布权限</label>
            <OptionDropdown
              value={f.allowPublish ? "yes" : "no"}
              options={PUBLISH_OPTS}
              onChange={(v) => setF({ ...f, allowPublish: v === "yes" })}
              size="md"
            />
          </div>
        </div>
        {err && <p className="text-xs text-rose-400">{err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800">取消</button>
          <button
            onClick={submit}
            disabled={busy || !f.username || !f.password}
            className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? "提交中…" : "创建"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
