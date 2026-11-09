"use client";

// 用户管理（前台会员）：搜索、新建、详情全字段修改、重置密码、积分调整、快捷启禁用/发布权限、批量操作、删除
import { useCallback, useEffect, useState } from "react";
import OptionDropdown from "@/components/OptionDropdown";
import Pagination from "@/components/Pagination";

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
  status: string;
  allowPublish: boolean;
  commentBanned: boolean;
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
const GENDER_TEXT: Record<string, string> = {
  male: "男",
  female: "女",
  other: "其他",
  secret: "保密",
};
const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-950/80 px-3 py-2 text-sm outline-none focus:border-indigo-500";
const labelCls = "mb-1 block text-xs text-zinc-400";

export default function UserManager() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [editing, setEditing] = useState<Row | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  // 表格勾选（批量操作）与批量请求进行中标记
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

  const load = useCallback(async () => {
    const ps = new URLSearchParams({ page: String(page) });
    if (q) ps.set("q", q);
    const r = await fetch("/api/admin/users?" + ps.toString()).then((x) => x.json());
    setRows(r.list || []);
    setTotal(r.total || 0);
    // 列表刷新后清空勾选，避免残留已变更/已删除的 id
    setSelected(new Set());
  }, [page, q]);

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
      const r = await fetch("/api/admin/users/batch", {
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
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
        >
          + 新建会员
        </button>
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
            {rows.map((u) => (
              <tr
                key={u.id}
                onClick={() => setEditing(u)}
                className="cursor-pointer border-t border-zinc-800/70 hover:bg-zinc-900/40"
              >
                <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(u.id)}
                    onChange={() => toggleOne(u.id)}
                    className="h-4 w-4 accent-indigo-500"
                    aria-label={`选择 ${u.username}`}
                  />
                </td>
                <td className="px-4 py-2.5 font-medium text-zinc-200">{u.username}</td>
                <td className="px-4 py-2.5 text-zinc-400">{u.nickname || "—"}</td>
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
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-10 text-center text-sm text-zinc-600">
                  暂无会员
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

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onDone={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
      {editing && (
        <EditModal
          user={rows.find((x) => x.id === editing.id) || editing}
          onClose={() => setEditing(null)}
          onChanged={load}
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

function EditModal({
  user,
  onClose,
  onChanged,
}: {
  user: Row;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [f, setF] = useState({
    nickname: user.nickname || "",
    email: user.email || "",
    phone: user.phone || "",
    bio: user.bio || "",
    avatar: user.avatar || "",
    wechat: user.wechat || "",
    qq: user.qq || "",
    telegram: user.telegram || "",
    birthday: user.birthday ? user.birthday.slice(0, 10) : "",
    gender: user.gender || "",
    nationality: user.nationality || "",
    status: user.status,
    allowPublish: user.allowPublish,
    commentBanned: user.commentBanned,
  });
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // ── 积分调整 ──
  const [balance, setBalance] = useState<number | null>(null);
  const [adjAmount, setAdjAmount] = useState("");
  const [adjNote, setAdjNote] = useState("");
  const [adjBusy, setAdjBusy] = useState(false);

  // 进入弹层时拉取当前积分余额
  const loadBalance = useCallback(async () => {
    const r = await fetch(`/api/admin/users/${user.id}/credits`).catch(() => null);
    if (!r || !r.ok) return;
    const d = await r.json().catch(() => ({}));
    if (typeof d.balance === "number") setBalance(d.balance);
  }, [user.id]);

  useEffect(() => {
    loadBalance();
  }, [loadBalance]);

  // 确认调整：正数入账 / 负数扣减
  const adjustCredits = async () => {
    setErr("");
    const amount = Number(adjAmount);
    if (!adjAmount.trim() || !Number.isInteger(amount) || amount === 0) {
      setErr("调整数量必须为非 0 整数（负数为扣减）");
      return;
    }
    if (!adjNote.trim()) {
      setErr("请填写调整原因/备注");
      return;
    }
    setAdjBusy(true);
    try {
      const r = await fetch(`/api/admin/users/${user.id}/credits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, note: adjNote.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "调整失败");
        return;
      }
      alert(`积分调整成功，当前余额：${d.balance}`);
      setAdjAmount("");
      setAdjNote("");
      loadBalance();
    } finally {
      setAdjBusy(false);
    }
  };

  const doPatch = async (body: Record<string, unknown>) => {
    setErr("");
    const r = await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(d.error || "操作失败");
      return false;
    }
    return true;
  };

  const save = async () => {
    setBusy(true);
    const ok = await doPatch(f);
    setBusy(false);
    if (ok) {
      onChanged();
      onClose();
    }
  };

  const resetPwd = async () => {
    if (newPassword.length < 6) {
      setErr("新密码至少 6 位");
      return;
    }
    const ok = await doPatch({ newPassword });
    if (ok) {
      alert("密码已重置");
      setNewPassword("");
    }
  };

  const del = async () => {
    if (!confirm(`确认删除会员「${user.username}」？该账号无提示词时才可删除。`)) return;
    const r = await fetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(d.error || "删除失败");
      return;
    }
    onChanged();
    onClose();
  };

  return (
    <ModalShell title={`会员详情 · ${user.username}`} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>账号（不可修改）</label>
          <input className={inputCls + " opacity-60"} value={user.username} disabled readOnly />
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
        <div>
          <label className={labelCls}>头像 URL</label>
          <input className={inputCls} value={f.avatar} onChange={(e) => setF({ ...f, avatar: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>简介</label>
          <textarea
            className={inputCls}
            rows={2}
            value={f.bio}
            onChange={(e) => setF({ ...f, bio: e.target.value })}
          />
        </div>

        {/* v0.96 个人档案：联系方式 + 生日/性别/国籍（与前台会员中心资料对齐） */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 text-xs font-medium text-zinc-400">联系方式 / 个人档案</div>
          <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
            <div>
              <label className={labelCls}>微信</label>
              <input className={inputCls} value={f.wechat} onChange={(e) => setF({ ...f, wechat: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>QQ</label>
              <input className={inputCls} value={f.qq} onChange={(e) => setF({ ...f, qq: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Telegram</label>
              <input className={inputCls} value={f.telegram} onChange={(e) => setF({ ...f, telegram: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>国籍</label>
              <input className={inputCls} value={f.nationality} onChange={(e) => setF({ ...f, nationality: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>生日</label>
              <input
                className={inputCls}
                type="date"
                value={f.birthday}
                onChange={(e) => setF({ ...f, birthday: e.target.value })}
              />
            </div>
            <div>
              <label className={labelCls}>性别</label>
              <select
                className={inputCls}
                value={f.gender}
                onChange={(e) => setF({ ...f, gender: e.target.value })}
              >
                <option value="">未设置</option>
                <option value="male">男</option>
                <option value="female">女</option>
                <option value="other">其他</option>
                <option value="secret">保密</option>
              </select>
            </div>
          </div>
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
        <div>
          <label className={labelCls}>评论权限</label>
          <OptionDropdown
            value={f.commentBanned ? "no" : "yes"}
            options={COMMENT_OPTS}
            onChange={(v) => setF({ ...f, commentBanned: v === "no" })}
            size="md"
          />
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-500">
          <div className="grid grid-cols-2 gap-y-1.5">
            <span>注册时间：{fmt(user.createdAt)}</span>
            <span>注册 IP：{user.registerIp || "—"}</span>
            <span>最后登录：{fmt(user.lastLoginAt)}</span>
            <span>登录 IP：{user.lastLoginIp || "—"}</span>
            <span>性别：{user.gender ? GENDER_TEXT[user.gender] || user.gender : "—"}</span>
            <span>生日：{user.birthday ? user.birthday.slice(0, 10) : "—"}</span>
          </div>
        </div>

        {/* 积分调整（放在重置密码上方） */}
        <div className="border-t border-zinc-800 pt-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs text-zinc-400">积分调整</span>
            <span className="text-xs text-zinc-400">
              当前余额：
              <b className="text-indigo-300">{balance === null ? "加载中…" : balance}</b>
            </span>
          </div>
          <div className="grid grid-cols-[120px_1fr_auto] items-end gap-2">
            <div>
              <label className={labelCls}>调整数量</label>
              <input
                className={inputCls}
                type="number"
                step={1}
                value={adjAmount}
                onChange={(e) => setAdjAmount(e.target.value)}
                placeholder="可负数"
              />
            </div>
            <div>
              <label className={labelCls}>备注/原因（≤200 字）</label>
              <input
                className={inputCls}
                value={adjNote}
                onChange={(e) => setAdjNote(e.target.value)}
                placeholder="如：活动赠送 / 违规扣减"
              />
            </div>
            <button
              onClick={adjustCredits}
              disabled={adjBusy || !adjAmount.trim() || !adjNote.trim()}
              className="shrink-0 rounded-lg border border-indigo-700/60 px-4 py-2 text-sm text-indigo-300 hover:bg-indigo-900/30 disabled:opacity-40"
            >
              {adjBusy ? "调整中…" : "确认调整"}
            </button>
          </div>
        </div>

        <div className="border-t border-zinc-800 pt-3">
          <label className={labelCls}>重置密码（留空则不修改）</label>
          <div className="flex gap-2">
            <input
              className={inputCls}
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="输入新密码"
            />
            <button
              onClick={resetPwd}
              disabled={!newPassword}
              className="shrink-0 rounded-lg border border-amber-700/60 px-4 py-2 text-sm text-amber-300 hover:bg-amber-900/30 disabled:opacity-40"
            >
              重置密码
            </button>
          </div>
        </div>

        {err && <p className="text-xs text-rose-400">{err}</p>}

        <div className="flex items-center justify-between pt-2">
          <button onClick={del} className="rounded-lg border border-rose-800/70 px-4 py-2 text-sm text-rose-300 hover:bg-rose-950/40">
            删除该会员
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800">关闭</button>
            <button
              onClick={save}
              disabled={busy}
              className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {busy ? "保存中…" : "保存修改"}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
