"use client";

// 会员详情独立页：TAB 分区（会员信息 / 积分明细 / 使用记录 / 充值订单 / 产物列表 / 发布记录 / 评论记录）
// TAB 写入 URL hash，刷新后保持；各列表服务端分页 + 统一时间区间筛选。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import OptionDropdown from "@/components/OptionDropdown";
import UserAvatar from "@/components/UserAvatar";
import RegionCascade from "@/components/RegionCascade";
import Pagination from "@/components/Pagination";
import { LOCALES, TIMEZONES, type RegionValue } from "@/lib/regions";
import { adminFetch } from "@/lib/admin-fetch";

type DetailUser = {
  id: number;
  username: string;
  email: string | null;
  phone: string | null;
  nickname: string | null;
  avatar: string | null;
  bio: string | null;
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
  membershipLevel: string;
  membership?: { code: string; name: string; isSystem: boolean } | null;
  registerIp: string | null;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdAt: string;
  _count: { prompts: number; apiKeys: number };
};

type LedgerItem = {
  id: string;
  changeAmount: number;
  balanceAfter: number;
  reason: string;
  refType: string | null;
  refId: string | null;
  source: string | null;
  createdAt: string;
};

type UsageItem = {
  id: number;
  channel: string;
  keyPrefix: string | null;
  modelSnapshot: string;
  promptTokens: number;
  outputTokens: number;
  paidCredits: number;
  status: string;
  latencyMs: number | null;
  requestId: string;
  createdAt: string;
};

type OrderItem = {
  id: number;
  orderNo: string;
  packCode: string;
  amountCents: number;
  credits: number;
  bonusCredits: number;
  channel: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
};

type AssetItem = {
  id: string;
  typeLabel: string;
  fileName: string;
  sizeBytes: number;
  status: string;
  createdAt: string;
};

type PromptItem = {
  id: number;
  title: string;
  category: string | null;
  type: string;
  status: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  createdAt: string;
};

type CommentItem = {
  id: number;
  content: string;
  targetType: string;
  targetId: number;
  status: string;
  createdAt: string;
  prompt: { id: number; title: string | null } | null;
};

const TABS = [
  { key: "info", label: "会员信息" },
  { key: "ledger", label: "积分明细" },
  { key: "usage", label: "使用记录" },
  { key: "orders", label: "充值订单" },
  { key: "assets", label: "产物列表" },
  { key: "prompts", label: "发布记录" },
  { key: "comments", label: "评论记录" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

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

const LEDGER_REASON: Record<string, string> = {
  grant: "发放/充值",
  consume: "消费",
  refund: "退款",
  admin_adjust: "管理员调账",
};
const USAGE_STATUS: Record<string, string> = { success: "成功", failed: "失败", blocked: "拦截" };
const ORDER_STATUS: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  failed: "失败",
  closed: "已关闭",
};
const ORDER_CHANNEL: Record<string, string> = { alipay: "支付宝", wechat: "微信", wxpay: "微信", manual: "人工" };
const PROMPT_STATUS: Record<string, string> = {
  published: "已发布",
  pending: "待审核",
  rejected: "已拒绝",
  draft: "草稿",
};
const PROMPT_TYPE: Record<string, string> = { text: "文本", image: "图片", video: "视频", audio: "音频" };
const COMMENT_STATUS: Record<string, string> = { published: "正常", hidden: "已隐藏", deleted: "已删除" };
const ASSET_STATUS: Record<string, string> = { ready: "可用", pending: "处理中", failed: "失败", expired: "已过期" };

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : "—");
const fmtBytes = (n: number) => {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};
const inputCls =
  "max-w-full rounded-lg border border-zinc-700 bg-zinc-950/80 px-3 py-2 text-sm outline-none focus:border-indigo-500";
const labelCls = "mb-1 block text-xs text-zinc-400";
const cardCls = "rounded-xl border border-zinc-700 bg-zinc-900/40 p-4";
const cardTitleCls = "mb-3 text-sm font-semibold text-zinc-200";
const thCls = "whitespace-nowrap border-b border-zinc-800 px-3 py-2.5 text-left text-sm font-semibold text-white";
const tdCls = "px-3 py-2.5 text-sm";
const rangeInputCls =
  "rounded-lg border border-zinc-700 bg-zinc-950/80 px-2.5 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500";
const btnPrimary =
  "rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50";

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-3.2-6.9" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

// ─── 统一时间区间控件 + 服务端分页 hook ───
type Range = { from: string; to: string };

type RangeControl = {
  draft: Range;
  setDraft: Dispatch<SetStateAction<Range>>;
  search: () => void;
  reset: () => void;
};

type Paged<T> = RangeControl & {
  rows: T[];
  total: number;
  page: number;
  loading: boolean;
  error: string;
  goPage: (p: number) => void;
};

function usePaged<T>(
  endpoint: string,
  params: Record<string, string | number>,
  rowsKey: string,
  active: boolean
): Paged<T> {
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Range>({ from: "", to: "" });
  const [applied, setApplied] = useState<Range>({ from: "", to: "" });
  const reqId = useRef(0);
  const loadedRef = useRef(false);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const load = useCallback(
    async (p: number, range: Range) => {
      const my = ++reqId.current;
      setLoading(true);
      setError("");
      try {
        const sp = new URLSearchParams();
        for (const [k, v] of Object.entries(paramsRef.current)) {
          if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
        }
        sp.set("page", String(p));
        if (range.from) sp.set("dateFrom", range.from);
        if (range.to) sp.set("dateTo", range.to);
        const r = await fetch(`${endpoint}?${sp.toString()}`).catch(() => null);
        const d = r && r.ok ? await r.json().catch(() => null) : null;
        if (my !== reqId.current) return;
        if (!d) {
          setError("加载失败，请稍后重试");
          setLoading(false);
          return;
        }
        const list = Array.isArray(d[rowsKey]) ? (d[rowsKey] as T[]) : [];
        setRows(list);
        setTotal(Number(d.total || 0));
        setPage(p);
        setLoading(false);
      } catch {
        if (my === reqId.current) {
          setError("加载失败，请稍后重试");
          setLoading(false);
        }
      }
    },
    [endpoint, rowsKey]
  );

  useEffect(() => {
    if (active && !loadedRef.current) {
      loadedRef.current = true;
      load(1, { from: "", to: "" });
    }
  }, [active, load]);

  const search = useCallback(() => {
    setApplied(draft);
    load(1, draft);
  }, [draft, load]);

  const reset = useCallback(() => {
    const empty = { from: "", to: "" };
    setDraft(empty);
    setApplied(empty);
    load(1, empty);
  }, [load]);

  const goPage = useCallback(
    (p: number) => {
      load(p, applied);
    },
    [applied, load]
  );

  return { rows, total, page, loading, error, draft, setDraft, search, reset, goPage };
}

function DateRangeBar({ st }: { st: RangeControl }) {
  return (
    <div className="mb-3 flex flex-wrap items-end gap-2">
      <label className="text-xs text-zinc-400">
        <span className="mb-1 block">起始日期</span>
        <input
          type="date"
          className={rangeInputCls}
          value={st.draft.from}
          onChange={(e) => st.setDraft((d) => ({ ...d, from: e.target.value }))}
        />
      </label>
      <label className="text-xs text-zinc-400">
        <span className="mb-1 block">结束日期</span>
        <input
          type="date"
          className={rangeInputCls}
          value={st.draft.to}
          onChange={(e) => st.setDraft((d) => ({ ...d, to: e.target.value }))}
        />
      </label>
      <button
        type="button"
        onClick={st.search}
        className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
      >
        查询
      </button>
      <button
        type="button"
        onClick={st.reset}
        className="rounded-lg border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:border-zinc-500"
      >
        重置
      </button>
    </div>
  );
}

function ListSection<T>({
  title,
  st,
  pageSize,
  head,
  renderRow,
  emptyText,
}: {
  title: string;
  st: Paged<T>;
  pageSize: number;
  head: ReactNode;
  renderRow: (row: T) => ReactNode;
  emptyText: string;
}) {
  const totalPages = Math.max(1, Math.ceil(st.total / pageSize));
  return (
    <section className={cardCls}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className={cardTitleCls + " mb-0"}>{title}</h2>
        <span className="text-xs text-zinc-400">共 {st.total} 条</span>
      </div>
      <DateRangeBar st={st} />
      {st.loading ? (
        <div className="py-8 text-center text-xs text-zinc-500">加载中…</div>
      ) : st.error ? (
        <div className="py-8 text-center text-xs text-rose-300">{st.error}</div>
      ) : st.rows.length === 0 ? (
        <div className="py-8 text-center text-xs text-zinc-500">{emptyText}</div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/50">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr>{head}</tr>
              </thead>
              <tbody className="text-zinc-300">
                {st.rows.map((row, i) => (
                  <tr key={i} className="border-t border-zinc-800/60 transition-colors hover:bg-zinc-800/40">
                    {renderRow(row)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={st.page} totalPages={totalPages} onPage={st.goPage} />
        </>
      )}
    </section>
  );
}

export default function UserDetail({ userId }: { userId: number }) {
  const router = useRouter();
  const [user, setUser] = useState<DetailUser | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [tab, setTab] = useState<TabKey>("info");
  const [f, setF] = useState({
    nickname: "",
    email: "",
    phone: "",
    bio: "",
    avatar: "",
    wechat: "",
    qq: "",
    telegram: "",
    birthday: "",
    gender: "",
    region: { countryCode: "", province: "", city: "", district: "" } as RegionValue,
    address: "",
    postalCode: "",
    website: "",
    locale: "",
    timezone: "",
    status: "active",
    allowPublish: true,
    commentBanned: false,
    membershipLevel: "",
  });
  const [levels, setLevels] = useState<{ code: string; name: string }[]>([]);
  const [newPassword, setNewPassword] = useState("");
  const [busyKey, setBusyKey] = useState<"" | "account" | "level" | "flags" | "pwd">("");
  const [err, setErr] = useState("");
  const [tip, setTip] = useState("");

  // 积分
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [canOverride, setCanOverride] = useState(false);
  const [adjMode, setAdjMode] = useState<"increase" | "deduct" | "set">("increase");
  const [adjAmount, setAdjAmount] = useState("");
  const [adjNote, setAdjNote] = useState("");
  const [adjBusy, setAdjBusy] = useState(false);

  // TAB hash 保持（与实验场 TAB 同一套做法）
  useEffect(() => {
    const h = window.location.hash.replace(/^#/, "");
    if (TABS.some((t) => t.key === h)) setTab(h as TabKey);
  }, []);
  const switchTab = (key: TabKey) => {
    setTab(key);
    window.history.replaceState(null, "", `#${key}`);
  };

  // 各栏服务端分页列表
  const ledger = usePaged<LedgerItem>("/api/admin/credits/ledger", { userId, pageSize: 20 }, "items", tab === "ledger");
  const usage = usePaged<UsageItem>("/api/admin/usage/records", { userId, pageSize: 20 }, "items", tab === "usage");
  const orders = usePaged<OrderItem>("/api/admin/pay/orders", { userId, pageSize: 20 }, "items", tab === "orders");
  const assets = usePaged<AssetItem>(`/api/admin/users/${userId}/assets`, { pageSize: 20 }, "assets", tab === "assets");
  const prompts = usePaged<PromptItem>("/api/admin/prompts", { userId }, "list", tab === "prompts");
  const comments = usePaged<CommentItem>("/api/admin/comments", { userId }, "list", tab === "comments");

  const back = () => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push("/guanli-7k2m9x/users");
  };

  const loadBalance = useCallback(async () => {
    const r = await fetch(`/api/admin/users/${userId}/credits`).catch(() => null);
    if (!r || !r.ok) return;
    const d = await r.json().catch(() => ({}));
    if (typeof d.balance === "number") setBalance(d.balance);
    setCanOverride(Boolean(d.canOverride));
  }, [userId]);

  // 只重拉余额，不动其它栏数据
  const reloadBalance = useCallback(async () => {
    setBalanceLoading(true);
    await loadBalance();
    setBalanceLoading(false);
    setTip("余额已刷新");
  }, [loadBalance]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await fetch(`/api/admin/users/${userId}`).catch(() => null);
      const d = await r?.json().catch(() => ({}));
      if (!alive) return;
      if (!r || !r.ok || !d?.user) {
        setLoadErr(d?.error || "会员不存在或无权访问");
        return;
      }
      const u = d.user as DetailUser;
      setUser(u);
      setF({
        nickname: u.nickname || "",
        email: u.email || "",
        phone: u.phone || "",
        bio: u.bio || "",
        avatar: u.avatar || "",
        wechat: u.wechat || "",
        qq: u.qq || "",
        telegram: u.telegram || "",
        birthday: u.birthday ? u.birthday.slice(0, 10) : "",
        gender: u.gender || "",
        region: {
          countryCode: u.countryCode || "",
          province: u.province || "",
          city: u.city || "",
          district: u.district || "",
        },
        address: u.address || "",
        postalCode: u.postalCode || "",
        website: u.website || "",
        locale: u.locale || "",
        timezone: u.timezone || "",
        status: u.status,
        allowPublish: u.allowPublish,
        commentBanned: u.commentBanned,
        membershipLevel: u.membershipLevel,
      });
    })();
    return () => {
      alive = false;
    };
  }, [userId]);

  useEffect(() => {
    loadBalance();
  }, [loadBalance]);

  useEffect(() => {
    fetch("/api/admin/membership-levels?regular=1")
      .then((r) => r.json())
      .then((d) => setLevels((d.list || []).filter((l: { isActive: boolean }) => l.isActive)))
      .catch(() => {});
  }, []);

  // 操作提示自动消失
  useEffect(() => {
    if (!tip) return;
    const t = window.setTimeout(() => setTip(""), 3000);
    return () => window.clearTimeout(t);
  }, [tip]);

  const isSystem = Boolean(user?.membership?.isSystem);

  const adjPreview = (() => {
    if (balance === null || !adjAmount.trim()) return null;
    const n = Number(adjAmount);
    if (!Number.isInteger(n) || n < 0) return { ok: false, after: balance, error: "数量必须为非负整数" };
    if (adjMode !== "set" && n === 0) return { ok: false, after: balance, error: "数量不能为 0" };
    const after = adjMode === "increase" ? balance + n : adjMode === "deduct" ? balance - n : n;
    if (after < 0) return { ok: false, after, error: "扣减后余额不能为负" };
    return { ok: true, after, error: "" };
  })();

  const adjustCredits = async () => {
    setErr("");
    if (!adjPreview) {
      setErr("请填写调整数量");
      return;
    }
    if (!adjPreview.ok) {
      setErr(adjPreview.error);
      return;
    }
    if (!adjNote.trim()) {
      setErr("请填写调整原因/备注");
      return;
    }
    const modeText = adjMode === "increase" ? "增加" : adjMode === "deduct" ? "扣减" : "覆盖为";
    if (
      !confirm(
        `确认${modeText} ${adjAmount} 积分？\n调整前：${balance}\n调整后：${adjPreview.after}\n备注：${adjNote.trim()}`
      )
    ) {
      return;
    }
    setAdjBusy(true);
    try {
      const r = await adminFetch(`/api/admin/users/${userId}/credits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: adjMode, amount: Number(adjAmount), note: adjNote.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "调整失败");
        return;
      }
      alert(`积分调整成功\n调整前：${d.before}\n调整后：${d.after}（${d.delta >= 0 ? "+" : ""}${d.delta}）`);
      setAdjAmount("");
      setAdjNote("");
      loadBalance();
      // 积分流水只属于明细栏：调整后刷新该栏数据，不影响其它栏
      ledger.goPage(1);
    } finally {
      setAdjBusy(false);
    }
  };

  const avatarFileRef = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const onAvatarPicked = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) {
      setErr("头像仅支持图片且不能超过 5MB");
      return;
    }
    setErr("");
    setAvatarBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch(`/api/admin/users/${userId}/avatar/upload`, { method: "POST", body: form });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "头像上传失败");
        return;
      }
      setF((prev) => ({ ...prev, avatar: d.url }));
    } catch {
      setErr("头像上传失败，请重试");
    } finally {
      setAvatarBusy(false);
    }
  };

  // 按块保存：每次只提交本块字段
  const patchBlock = async (body: Record<string, unknown>, okText: string) => {
    setErr("");
    setTip("");
    const r = await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(d.error || "操作失败");
      return false;
    }
    setTip(okText);
    return true;
  };

  const refreshUser = useCallback(async () => {
    const r = await fetch(`/api/admin/users/${userId}`).catch(() => null);
    const d = r && r.ok ? await r.json().catch(() => ({})) : null;
    if (d?.user) setUser(d.user as DetailUser);
  }, [userId]);

  // 保存本栏（会员信息 TAB）：账号资料 + 会员等级 + 账号状态与权限
  const saveInfoTab = async () => {
    if (isSystem) return;
    setBusyKey("account");
    const { region } = f;
    const ok = await patchBlock(
      {
        nickname: f.nickname,
        email: f.email,
        phone: f.phone,
        bio: f.bio,
        avatar: f.avatar,
        wechat: f.wechat,
        qq: f.qq,
        telegram: f.telegram,
        birthday: f.birthday,
        gender: f.gender,
        countryCode: region.countryCode,
        province: region.province,
        city: region.city,
        district: region.district,
        address: f.address,
        postalCode: f.postalCode,
        website: f.website,
        locale: f.locale,
        timezone: f.timezone,
        membershipLevel: f.membershipLevel,
        status: f.status,
        allowPublish: f.allowPublish,
        commentBanned: f.commentBanned,
      },
      "会员信息已保存"
    );
    if (ok) await refreshUser();
    setBusyKey("");
  };

  const resetPwd = async () => {
    if (newPassword.length < 6) {
      setErr("新密码至少 6 位");
      return;
    }
    setBusyKey("pwd");
    const ok = await patchBlock({ newPassword }, "密码已重置");
    setBusyKey("");
    if (ok) setNewPassword("");
  };

  const del = async () => {
    if (
      !confirm(
        `确认删除会员「${user?.username}」？\n\n删除后：\n· 该会员的提示词、评论、产物等内容全部保留\n· 内容作者处显示为「已注销」\n· 该账号将无法登录，操作不可撤销\n\n确认继续？`
      )
    ) {
      return;
    }
    const r = await adminFetch(`/api/admin/users/${userId}`, { method: "DELETE" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(d.error || "删除失败");
      return;
    }
    back();
  };

  if (loadErr) {
    return (
      <div className="space-y-4">
        <button onClick={back} className="text-sm text-zinc-400 hover:text-zinc-200">
          返回列表
        </button>
        <div className="rounded-xl border border-rose-800/60 bg-rose-950/20 p-6 text-sm text-rose-300">{loadErr}</div>
      </div>
    );
  }

  if (!user) {
    return <div className="py-20 text-center text-sm text-zinc-500">加载中…</div>;
  }

  return (
    <div className="space-y-5 pb-16">
      {/* 顶部操作条 */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={saveInfoTab}
          disabled={busyKey !== "" || isSystem}
          title="保存会员信息（账号资料 / 会员等级 / 账号状态与权限）"
          className={btnPrimary}
        >
          {busyKey === "account" ? "保存中…" : "保存"}
        </button>
        <button onClick={back} className="text-sm text-zinc-400 hover:text-zinc-200">
          返回列表
        </button>
        <h1 className="text-xl font-bold text-zinc-100">会员详情 · {user.username}</h1>
        {isSystem && (
          <span className="rounded bg-amber-950/60 px-2 py-0.5 text-xs text-amber-400">系统等级（只读）</span>
        )}
        <span
          className={
            "rounded px-2 py-0.5 text-xs " +
            (user.status === "active" ? "bg-emerald-950/60 text-emerald-300" : "bg-rose-950/60 text-rose-300")
          }
        >
          {user.status === "active" ? "有效" : "禁止"}
        </span>
        <button
          type="button"
          onClick={del}
          disabled={isSystem}
          title="删除后该会员的提示词、评论、产物等内容保留，作者显示为「已注销」；账号将无法登录，操作不可撤销"
          className="ml-auto shrink-0 rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-red-500 disabled:opacity-40"
        >
          删除该会员
        </button>
      </div>

      {/* TAB 导航 */}
      <div className="flex flex-wrap gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900/60 p-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchTab(t.key)}
            className={
              "rounded-lg px-3 py-1.5 text-sm transition " +
              (tab === t.key
                ? "bg-indigo-600 font-medium text-white"
                : "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {err && (
        <div className="rounded-lg border border-rose-800/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">{err}</div>
      )}

      {/* ─── 1. 会员信息 ─── */}
      {tab === "info" && (
        <div className="space-y-5">
          {tip && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-800/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
              <span>{tip}</span>
              <button type="button" onClick={() => setTip("")} className="text-emerald-400/80 hover:text-emerald-200">
                关闭
              </button>
            </div>
          )}

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
            {/* 会员等级 */}
            <section className="p-4">
              <h2 className={cardTitleCls}>会员等级</h2>
            {isSystem ? (
              <p className="text-sm text-amber-400/90">{user.membership?.name || user.membershipLevel}（系统等级，只读）</p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <select
                  className={inputCls + " w-full sm:w-[240px]"}
                  value={f.membershipLevel}
                  onChange={(e) => setF({ ...f, membershipLevel: e.target.value })}
                >
                  {levels.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name}
                    </option>
                  ))}
                  {!levels.some((l) => l.code === f.membershipLevel) && (
                    <option value={f.membershipLevel}>{user.membership?.name || f.membershipLevel}</option>
                  )}
                </select>
                <Link href="/guanli-7k2m9x/users?scope=all" className="text-xs text-zinc-400 hover:text-zinc-200">
                  等级管理在列表页
                </Link>
              </div>
            )}
          </section>

          {/* 积分与调整：余额大字橙色 + 只刷余额 */}
          <section className="border-t border-zinc-800 p-4">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className={cardTitleCls + " mb-0"}>积分与调整</h2>
                <p className="mt-1 text-xs text-zinc-400">点「确认调整」即时生效，只影响本会员积分与积分明细。</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-400">当前余额</span>
                <span className="text-3xl font-bold leading-none tabular-nums text-orange-400">
                  {balance === null ? "—" : balance}
                </span>
                <button
                  type="button"
                  onClick={reloadBalance}
                  disabled={balanceLoading}
                  aria-label="刷新余额"
                  title="刷新余额"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-orange-700/60 text-orange-300 transition hover:bg-orange-950/40 disabled:opacity-50"
                >
                  <RefreshIcon className={balanceLoading ? "animate-spin" : undefined} />
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
                <div>
                  <label className={labelCls}>模式</label>
                  <select
                    className={inputCls + " w-full sm:w-[140px]"}
                    value={adjMode}
                    onChange={(e) => setAdjMode(e.target.value as "increase" | "deduct" | "set")}
                  >
                    <option value="increase">增加</option>
                    <option value="deduct">扣减</option>
                    {canOverride && <option value="set">覆盖</option>}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>{adjMode === "set" ? "目标余额" : "调整数量"}</label>
                  <input
                    className={inputCls + " w-full sm:w-[160px]"}
                    type="number"
                    step={1}
                    min={0}
                    value={adjAmount}
                    onChange={(e) => setAdjAmount(e.target.value)}
                    placeholder="非负整数"
                  />
                </div>
              </div>
              <div>
                <label className={labelCls}>备注/原因（必填，≤200 字）</label>
                <input
                  className={inputCls + " w-full sm:w-[360px]"}
                  value={adjNote}
                  onChange={(e) => setAdjNote(e.target.value)}
                  placeholder="如：活动赠送 / 违规扣减"
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs">
                  {adjPreview ? (
                    adjPreview.ok ? (
                      <span className="text-zinc-400">
                        调整前 <b className="text-zinc-200">{balance}</b> → 调整后{" "}
                        <b className="text-orange-300">{adjPreview.after}</b>
                      </span>
                    ) : (
                      <span className="text-red-400">{adjPreview.error}</span>
                    )
                  ) : (
                    <span className="text-zinc-400">填写数量后显示调整前后预览</span>
                  )}
                </div>
                <button
                  onClick={adjustCredits}
                  disabled={adjBusy || !adjAmount.trim() || !adjNote.trim() || !adjPreview?.ok}
                  className="shrink-0 rounded-lg border border-indigo-700/60 px-4 py-2 text-sm text-indigo-300 hover:bg-indigo-900/30 disabled:opacity-40"
                >
                  {adjBusy ? "调整中…" : "确认调整"}
                </button>
              </div>
            </div>
          </section>

          <section className="border-t border-zinc-800 p-4">
            <h2 className={cardTitleCls}>账号状态与权限</h2>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
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
              <div>
                <label className={labelCls}>评论权限</label>
                <OptionDropdown
                  value={f.commentBanned ? "no" : "yes"}
                  options={COMMENT_OPTS}
                  onChange={(v) => setF({ ...f, commentBanned: v === "no" })}
                  size="md"
                />
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-y-1.5 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3 text-xs text-zinc-400 min-[560px]:grid-cols-3">
              <span>注册时间：{fmt(user.createdAt)}</span>
              <span>注册 IP：{user.registerIp || "—"}</span>
              <span>最后登录：{fmt(user.lastLoginAt)}</span>
              <span>登录 IP：{user.lastLoginIp || "—"}</span>
              <span>提示词数：{user._count?.prompts ?? 0}</span>
              <span>API Key：{user._count?.apiKeys ?? 0}</span>
            </div>
            <h3 className="mb-3 mt-4 text-xs font-semibold text-zinc-300">重置密码</h3>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className={inputCls + " w-full sm:w-[280px]"}
                type="text"
                value={newPassword}
                disabled={isSystem}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="输入新密码（至少 6 位）"
              />
              <button
                onClick={resetPwd}
                disabled={!newPassword || isSystem || busyKey !== ""}
                className="shrink-0 rounded-lg border border-amber-700/60 px-4 py-2 text-sm text-amber-300 hover:bg-amber-900/30 disabled:opacity-40"
              >
                {busyKey === "pwd" ? "重置中…" : "重置密码"}
              </button>
            </div>
          </section>

          {/* 账号信息 */}
          <section className="border-t border-zinc-800 p-4">
            <h2 className={cardTitleCls}>账号信息</h2>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
              <div>
                <label className={labelCls}>账号（不可修改）</label>
                <input className={inputCls + " w-full sm:w-[260px] opacity-60"} value={user.username} disabled readOnly />
              </div>
              <div>
                <label className={labelCls}>昵称</label>
                <input
                  className={inputCls + " w-full sm:w-[240px]"}
                  disabled={isSystem}
                  value={f.nickname}
                  onChange={(e) => setF({ ...f, nickname: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls}>手机号</label>
                <input
                  className={inputCls + " w-full sm:w-[200px]"}
                  disabled={isSystem}
                  value={f.phone}
                  onChange={(e) => setF({ ...f, phone: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls}>邮箱</label>
                <input
                  className={inputCls + " w-full sm:w-[300px]"}
                  disabled={isSystem}
                  value={f.email}
                  onChange={(e) => setF({ ...f, email: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls}>头像</label>
                <div className="flex flex-wrap items-center gap-3">
                  <UserAvatar src={f.avatar || null} name={f.nickname || user.username} size={52} />
                  <button
                    type="button"
                    onClick={() => avatarFileRef.current?.click()}
                    disabled={avatarBusy || isSystem}
                    className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500 disabled:opacity-50"
                  >
                    {avatarBusy ? "上传中…" : "上传/更换头像"}
                  </button>
                  <input ref={avatarFileRef} type="file" accept="image/*" className="hidden" onChange={onAvatarPicked} />
                  {f.avatar && (
                    <button
                      type="button"
                      onClick={() => setF((prev) => ({ ...prev, avatar: "" }))}
                      disabled={isSystem}
                      className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-400 transition hover:bg-zinc-700 disabled:opacity-50"
                    >
                      移除
                    </button>
                  )}
                </div>
                <p className="mt-1 text-xs text-zinc-400">仅支持图片，≤5MB；上传后立即生效</p>
              </div>
              <div>
                <label className={labelCls}>简介</label>
                <textarea
                  className={inputCls + " w-full sm:w-[480px]"}
                  rows={2}
                  disabled={isSystem}
                  value={f.bio}
                  onChange={(e) => setF({ ...f, bio: e.target.value })}
                />
              </div>
            </div>
            <h3 className="mb-3 mt-4 text-xs font-semibold text-zinc-300">联系方式 / 个人档案</h3>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
              <div>
                <label className={labelCls}>微信</label>
                <input className={inputCls + " w-full sm:w-[200px]"} disabled={isSystem} value={f.wechat} onChange={(e) => setF({ ...f, wechat: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>QQ</label>
                <input className={inputCls + " w-full sm:w-[200px]"} disabled={isSystem} value={f.qq} onChange={(e) => setF({ ...f, qq: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Telegram</label>
                <input className={inputCls + " w-full sm:w-[220px]"} disabled={isSystem} value={f.telegram} onChange={(e) => setF({ ...f, telegram: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>国家 / 省州 / 城市 / 区</label>
                <RegionCascade value={f.region} onChange={(region) => setF((prev) => ({ ...prev, region }))} fixed />
              </div>
              <div>
                <label className={labelCls}>详细地址</label>
                <input className={inputCls + " w-full sm:w-[420px]"} maxLength={200} disabled={isSystem} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>邮编</label>
                <input className={inputCls + " w-full sm:w-[140px]"} maxLength={20} disabled={isSystem} value={f.postalCode} onChange={(e) => setF({ ...f, postalCode: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>个人网站</label>
                <input className={inputCls + " w-full sm:w-[320px]"} maxLength={200} placeholder="https://" disabled={isSystem} value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>语言偏好</label>
                <select className={inputCls + " w-full sm:w-[180px]"} disabled={isSystem} value={f.locale} onChange={(e) => setF({ ...f, locale: e.target.value })}>
                  <option value="">未设置</option>
                  {LOCALES.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>时区</label>
                <select className={inputCls + " w-full sm:w-[220px]"} disabled={isSystem} value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
                  <option value="">未设置</option>
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>生日</label>
                <input className={inputCls + " w-full sm:w-[180px]"} type="date" disabled={isSystem} value={f.birthday} onChange={(e) => setF({ ...f, birthday: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>性别</label>
                <select className={inputCls + " w-full sm:w-[140px]"} disabled={isSystem} value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })}>
                  <option value="">未设置</option>
                  <option value="male">男</option>
                  <option value="female">女</option>
                  <option value="other">其他</option>
                  <option value="secret">保密</option>
                </select>
              </div>
            </div>
          </section>
          </div>
        </div>
      )}

      {/* ─── 2. 积分明细 ─── */}
      {tab === "ledger" && (
        <ListSection
          title="积分明细"
          st={ledger}
          pageSize={20}
          emptyText="暂无积分流水"
          head={
            <>
              <th className={thCls}>时间</th>
              <th className={thCls}>变动</th>
              <th className={thCls}>变动后余额</th>
              <th className={thCls}>原因</th>
              <th className={thCls}>来源</th>
            </>
          }
          renderRow={(r) => (
            <>
              <td className={tdCls + " whitespace-nowrap text-zinc-400"}>{fmt(r.createdAt)}</td>
              <td className={tdCls + " font-medium " + (r.changeAmount >= 0 ? "text-emerald-300" : "text-rose-300")}>
                {r.changeAmount > 0 ? `+${r.changeAmount}` : r.changeAmount}
              </td>
              <td className={tdCls}>{r.balanceAfter}</td>
              <td className={tdCls}>{LEDGER_REASON[r.reason] || r.reason}</td>
              <td className={tdCls + " max-w-[240px] truncate text-zinc-400"} title={r.source || ""}>
                {r.source || r.refType || "—"}
              </td>
            </>
          )}
        />
      )}

      {/* ─── 3. 使用记录 ─── */}
      {tab === "usage" && (
        <ListSection
          title="使用记录"
          st={usage}
          pageSize={20}
          emptyText="暂无使用记录"
          head={
            <>
              <th className={thCls}>时间</th>
              <th className={thCls}>模型</th>
              <th className={thCls}>通道</th>
              <th className={thCls}>状态</th>
              <th className={thCls}>Token（入/出）</th>
              <th className={thCls}>积分</th>
              <th className={thCls}>延迟</th>
            </>
          }
          renderRow={(r) => (
            <>
              <td className={tdCls + " whitespace-nowrap text-zinc-400"}>{fmt(r.createdAt)}</td>
              <td className={tdCls + " max-w-[200px] truncate"} title={r.modelSnapshot}>
                {r.modelSnapshot}
              </td>
              <td className={tdCls}>{r.channel === "apikey" ? "API Key" : "站内"}</td>
              <td className={tdCls}>{USAGE_STATUS[r.status] || r.status}</td>
              <td className={tdCls + " whitespace-nowrap text-zinc-400"}>
                {r.promptTokens} / {r.outputTokens}
              </td>
              <td className={tdCls}>{r.paidCredits}</td>
              <td className={tdCls + " whitespace-nowrap text-zinc-400"}>
                {r.latencyMs == null ? "—" : `${r.latencyMs} ms`}
              </td>
            </>
          )}
        />
      )}

      {/* ─── 4. 充值订单 ─── */}
      {tab === "orders" && (
        <ListSection
          title="充值订单"
          st={orders}
          pageSize={20}
          emptyText="暂无充值订单"
          head={
            <>
              <th className={thCls}>时间</th>
              <th className={thCls}>订单号</th>
              <th className={thCls}>套餐</th>
              <th className={thCls}>金额</th>
              <th className={thCls}>积分</th>
              <th className={thCls}>通道</th>
              <th className={thCls}>状态</th>
            </>
          }
          renderRow={(r) => (
            <>
              <td className={tdCls + " whitespace-nowrap text-zinc-400"}>{fmt(r.createdAt)}</td>
              <td className={tdCls + " font-mono text-zinc-300"}>{r.orderNo}</td>
              <td className={tdCls}>{r.packCode}</td>
              <td className={tdCls}>¥{(r.amountCents / 100).toFixed(2)}</td>
              <td className={tdCls}>
                {r.credits}
                {r.bonusCredits ? ` +赠${r.bonusCredits}` : ""}
              </td>
              <td className={tdCls}>{ORDER_CHANNEL[r.channel] || r.channel || "—"}</td>
              <td className={tdCls}>
                <span
                  className={
                    "rounded px-1.5 py-0.5 text-xs " +
                    (r.status === "paid"
                      ? "bg-emerald-950/60 text-emerald-300"
                      : r.status === "pending"
                        ? "bg-amber-950/60 text-amber-300"
                        : "bg-zinc-800 text-zinc-300")
                  }
                >
                  {ORDER_STATUS[r.status] || r.status}
                </span>
              </td>
            </>
          )}
        />
      )}

      {/* ─── 5. 产物列表 ─── */}
      {tab === "assets" && (
        <ListSection
          title="产物列表"
          st={assets}
          pageSize={20}
          emptyText="暂无生成产物"
          head={
            <>
              <th className={thCls}>时间</th>
              <th className={thCls}>类型</th>
              <th className={thCls}>文件名</th>
              <th className={thCls}>大小</th>
              <th className={thCls}>状态</th>
            </>
          }
          renderRow={(r) => (
            <>
              <td className={tdCls + " whitespace-nowrap text-zinc-400"}>{fmt(r.createdAt)}</td>
              <td className={tdCls}>{r.typeLabel}</td>
              <td className={tdCls + " max-w-[240px] truncate"} title={r.fileName}>
                {r.fileName}
              </td>
              <td className={tdCls + " whitespace-nowrap"}>{fmtBytes(r.sizeBytes)}</td>
              <td className={tdCls}>{ASSET_STATUS[r.status] || r.status}</td>
            </>
          )}
        />
      )}

      {/* ─── 6. 发布记录 ─── */}
      {tab === "prompts" && (
        <ListSection
          title="发布记录（该会员发布的提示词）"
          st={prompts}
          pageSize={30}
          emptyText="暂无发布记录"
          head={
            <>
              <th className={thCls}>时间</th>
              <th className={thCls}>标题</th>
              <th className={thCls}>分类</th>
              <th className={thCls}>类型</th>
              <th className={thCls}>状态</th>
              <th className={thCls}>浏览</th>
              <th className={thCls}>点赞</th>
              <th className={thCls}>评论</th>
            </>
          }
          renderRow={(r) => (
            <>
              <td className={tdCls + " whitespace-nowrap text-zinc-400"}>{fmt(r.createdAt)}</td>
              <td className={tdCls + " max-w-[280px] truncate"} title={r.title}>
                {r.title}
              </td>
              <td className={tdCls}>{r.category || "—"}</td>
              <td className={tdCls}>{PROMPT_TYPE[r.type] || r.type}</td>
              <td className={tdCls}>{PROMPT_STATUS[r.status] || r.status}</td>
              <td className={tdCls}>{r.viewCount}</td>
              <td className={tdCls}>{r.likeCount}</td>
              <td className={tdCls}>{r.commentCount}</td>
            </>
          )}
        />
      )}

      {/* ─── 7. 评论记录 ─── */}
      {tab === "comments" && (
        <ListSection
          title="评论记录"
          st={comments}
          pageSize={20}
          emptyText="暂无评论记录"
          head={
            <>
              <th className={thCls}>时间</th>
              <th className={thCls}>内容</th>
              <th className={thCls}>所属提示词</th>
              <th className={thCls}>状态</th>
            </>
          }
          renderRow={(r) => (
            <>
              <td className={tdCls + " whitespace-nowrap text-zinc-400"}>{fmt(r.createdAt)}</td>
              <td className={tdCls + " max-w-[360px] truncate"} title={r.content}>
                {r.content}
              </td>
              <td className={tdCls + " max-w-[240px] truncate"}>
                {r.prompt?.title || (r.targetType === "prompt" ? `#${r.targetId}` : r.targetType)}
              </td>
              <td className={tdCls}>{COMMENT_STATUS[r.status] || r.status}</td>
            </>
          )}
        />
      )}
    </div>
  );
}
