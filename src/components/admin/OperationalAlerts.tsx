"use client";

import { useCallback, useEffect, useState } from "react";
import { featureLabel } from "@/lib/alert-format";
import { ALERT_TYPE_KEYS, ALERT_TYPE_LABELS } from "@/lib/admin/alert-subscription";

// ─── P6 后台：运营告警（告警列表 + 阈值配置 + 手动巡检 + 自动巡检总开关） ───

type AlertMember = { id: number; username: string; nickname: string | null };
type AlertUsage = {
  requestId: string | null;
  modelSnapshot: string;
  endpointType: string;
  status: string;
  paidCredits: string;
  createdAt: string;
};

type Alert = {
  id: number;
  alertType: string;
  level: string;
  message: string;
  payload: string;
  ackAt: string | null;
  createdAt: string;
  member?: AlertMember | null;
  usage?: AlertUsage | null;
};

type AlertPayload = {
  scene?: string;
  requestId?: string;
  username?: string | null;
  nickname?: string | null;
  model?: string | null;
  feature?: string | null;
  deducted?: string;
  paidCredits?: string;
  amount?: string;
  kind?: string;
  requestCreatedAt?: string;
};

// 当前仍在生成的告警类型：全部中文，不展示英文裸串
const TYPE_TEXT: Record<string, string> = {
  credit_pool: "积分池告警",
  gross_margin: "毛利告警",
  pay_fail: "支付异常",
  register_burst: "注册异常",
  usage_invalid: "用量记录异常",
  reconcile_failed: "对账重试耗尽",
};

// 已停用的历史类型：仅用于展示库里的旧告警（不再生成），避免英文裸串
const LEGACY_TYPE_TEXT: Record<string, string> = {
  user_burst: "用户异常消耗",
  reconcile_stuck: "账务对账异常",
};

function parsePayload(a: Alert): AlertPayload {
  try {
    return JSON.parse(a.payload || "{}") as AlertPayload;
  } catch {
    return {};
  }
}

// 历史 reconcile_stuck 的预扣卡账子场景：标题上标明「已停用」，与旧负数/重试告警区分
function legacySceneText(a: Alert): string {
  if (a.alertType !== "reconcile_stuck") return "";
  const p = parsePayload(a);
  if (p.scene === "stuck" || a.message.startsWith("预扣卡账")) return "预扣卡账";
  if (p.scene === "negative" || a.message.startsWith("用量记录异常")) return "负数用量";
  if (p.scene === "failed" || a.message.startsWith("对账单重试耗尽")) return "对账单重试耗尽";
  return "";
}

function alertTypeText(a: Alert): string {
  const base = TYPE_TEXT[a.alertType];
  if (base) return base;
  const legacy = LEGACY_TYPE_TEXT[a.alertType];
  if (legacy) {
    const scene = legacySceneText(a);
    return `${legacy}（已停用${scene ? ` · ${scene}` : ""}）`;
  }
  return "其他告警";
}

// 金额展示：带正负号与单位，并说明是预扣、实扣还是结算/退款
function amountText(a: Alert): string {
  const p = parsePayload(a);
  if (a.alertType === "reconcile_failed" && p.amount != null) {
    const n = Math.abs(Number(p.amount));
    return `${p.kind === "refund" ? "退款" : "结算"}金额 ${n.toLocaleString("zh-CN")} 分`;
  }
  if (p.paidCredits != null) {
    const n = Number(p.paidCredits);
    return `本次实扣 ${n < 0 ? "−" : "+"}${Math.abs(n).toLocaleString("zh-CN")} 分`;
  }
  if (p.deducted != null) return `预扣 −${Number(p.deducted).toLocaleString("zh-CN")} 分`;
  if (a.usage?.paidCredits != null) {
    const n = Number(a.usage.paidCredits);
    return `本次实扣 ${n < 0 ? "−" : "+"}${Math.abs(n).toLocaleString("zh-CN")} 分`;
  }
  return "";
}

// 告警行第二行：会员（可点击进会员列表）+ 模型/功能 + 金额 + 计费请求 ID
function AlertMeta({ a }: { a: Alert }) {
  const p = parsePayload(a);
  const username = p.username || a.member?.username || "";
  const nickname = p.nickname || a.member?.nickname || "";
  const model = p.model || a.usage?.modelSnapshot || "";
  const feature = p.feature || (a.usage?.endpointType ? featureLabel(a.usage.endpointType) : "");
  const money = amountText(a);

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
      {username ? (
        <a
          href={`/guanli-7k2m9x/users?q=${encodeURIComponent(username)}`}
          className="text-emerald-400 hover:underline"
          title="查看该会员资料"
        >
          {nickname ? `${nickname}（${username}）` : username}
        </a>
      ) : (
        <span>会员已注销</span>
      )}
      {model && (
        <span>
          · {model}
          {feature ? `（${feature}）` : ""}
        </span>
      )}
      {money && <span className="text-zinc-300">· {money}</span>}
      {p.requestId && (
        <span className="font-mono" title={p.requestId}>
          · {p.requestId.length > 48 ? `${p.requestId.slice(0, 48)}…` : p.requestId}
        </span>
      )}
      {p.requestCreatedAt && <span>· 发起 {fmt(p.requestCreatedAt)}</span>}
    </div>
  );
}

type AlertsConfig = {
  enabled: boolean;
  creditPoolThreshold: number;
  marginRateThreshold: number;
  payFail24hCount: number;
  registerBurstPerIp: number;
};

type CheckMetrics = {
  poolRemaining: number;
  revenueMilli7d: number;
  costMilli7d: number;
  profitMilli7d: number;
  marginRate7d: number | null;
  payFail24h: number;
  registerBurstIps: number;
};

const LEVEL_BADGE: Record<string, string> = {
  warn: "bg-amber-500/15 text-amber-300",
  critical: "bg-rose-500/15 text-rose-300",
};
const LEVEL_TEXT: Record<string, string> = {
  warn: "预警",
  critical: "严重",
};

function fmt(d: string | Date | null) {
  if (!d) return "—";
  const x = new Date(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

export default function OperationalAlerts() {
  const [items, setItems] = useState<Alert[] | null>(null);
  const [unackCount, setUnackCount] = useState(0);
  const [filter, setFilter] = useState<"all" | "unacked">("all");
  // 批量选择（告警列表复选框选中项）
  const [sel, setSel] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // 巡检结果反馈
  const [checkMsg, setCheckMsg] = useState("");
  const [metrics, setMetrics] = useState<CheckMetrics | null>(null);

  // 阈值配置（SiteSetting key="alerts_config"）
  const [cfg, setCfg] = useState<AlertsConfig | null>(null);
  const [cfgSaved, setCfgSaved] = useState(false);

  // b16：我的告警订阅（邮箱 + 类型）
  const [subEmail, setSubEmail] = useState("");
  const [subTypes, setSubTypes] = useState<string[]>([...ALERT_TYPE_KEYS]);
  const [subSaved, setSubSaved] = useState(false);

  const load = useCallback(async (f: "all" | "unacked") => {
    setItems(null);
    try {
      const r = await fetch(`/api/admin/alerts?ack=${f}`);
      const d = await r.json();
      if (r.ok) {
        setItems(d.items || []);
        setUnackCount(d.unackCount || 0);
        if (d.config) {
          setCfg(d.config);
        }
        if (d.mySubscription) {
          setSubEmail(d.mySubscription.email || "");
          setSubTypes(Array.isArray(d.mySubscription.types) ? d.mySubscription.types : [...ALERT_TYPE_KEYS]);
        }
      } else {
        setError(d.error || "加载失败");
        setItems([]);
      }
    } catch {
      setError("加载失败，请稍后重试");
      setItems([]);
    }
  }, []);

  useEffect(() => {
    load(filter);
  }, [filter, load]);

  const runCheck = async () => {
    if (busy) return;
    setBusy(true);
    setCheckMsg("");
    setError("");
    try {
      const r = await fetch("/api/admin/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check" }),
      });
      const d = await r.json();
      if (r.ok) {
        setCheckMsg(d.created?.length ? `巡检完成：新增 ${d.created.length} 条告警` : "巡检完成：未发现新问题");
        if (d.metrics) setMetrics(d.metrics);
        load(filter);
      } else {
        setError(d.error || "巡检失败");
      }
    } catch {
      setError("巡检失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const ackAlert = async (id: number) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/admin/alerts/${id}/ack`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) setError(d.error || "操作失败");
      load(filter);
    } catch {
      setError("操作失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  // ── 批量确认 / 批量删除告警 ──
  const toggleSel = (id: number) =>
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const runBatch = async (action: "ack" | "delete") => {
    if (sel.length === 0 || busy) return;
    if (action === "delete" && !confirm(`确定删除选中的 ${sel.length} 条告警吗？此操作不可恢复。`)) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/admin/alerts/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids: sel }),
      });
      const d = await r.json();
      if (r.ok) {
        setSel([]);
        load(filter);
      } else {
        setError(d.error || "操作失败");
      }
    } catch {
      setError("操作失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const saveConfig = async () => {
    if (!cfg || busy) return;
    setBusy(true);
    setCfgSaved(false);
    setError("");
    try {
      const r = await fetch("/api/admin/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "saveConfig",
          config: {
            enabled: cfg.enabled,
            creditPoolThreshold: cfg.creditPoolThreshold,
            marginRateThreshold: cfg.marginRateThreshold,
            payFail24hCount: cfg.payFail24hCount,
            registerBurstPerIp: cfg.registerBurstPerIp,
          },
        }),
      });
      const d = await r.json();
      if (r.ok) {
        setCfg(d.config);
        setCfgSaved(true);
        setTimeout(() => setCfgSaved(false), 2000);
      } else {
        setError(d.error || "保存失败");
      }
    } catch {
      setError("保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const saveSubscription = async () => {
    if (busy) return;
    setBusy(true);
    setSubSaved(false);
    setError("");
    try {
      const r = await fetch("/api/admin/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "saveSubscription", email: subEmail.trim(), alertTypes: subTypes }),
      });
      const d = await r.json();
      if (r.ok) {
        setSubEmail(d.mySubscription?.email || "");
        setSubTypes(Array.isArray(d.mySubscription?.types) ? d.mySubscription.types : [...ALERT_TYPE_KEYS]);
        setSubSaved(true);
        setTimeout(() => setSubSaved(false), 2000);
      } else {
        setError(d.error || "保存失败");
      }
    } catch {
      setError("保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const toggleSubType = (t: string) =>
    setSubTypes((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));

  const th = "px-3 py-2.5 text-left text-xs font-medium text-zinc-500";
  const td = "px-3 py-2.5 text-sm text-zinc-300";
  const inputCls =
    "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none";
  const labelCls = "mb-1 block text-xs text-zinc-500";

  return (
    <div>
      {error && <p className="mb-3 text-sm text-rose-400">{error}</p>}

      {/* 巡检工具条 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(
          [
            ["all", "全部告警"],
            ["unacked", `未确认${unackCount ? `（${unackCount}）` : ""}`],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => { setFilter(k); setSel([]); }}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              filter === k ? "bg-zinc-800 text-emerald-300" : "text-zinc-500 hover:bg-zinc-800"
            }`}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={runCheck}
          disabled={busy}
          className="ml-auto rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "检查中…" : "立即检查"}
        </button>
      </div>

      {checkMsg && <p className="mb-2 text-sm text-emerald-400">{checkMsg}</p>}
      {metrics && (
        <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-400 lg:grid-cols-4">
          <span>积分池剩余：{metrics.poolRemaining}</span>
          <span>近 7 天收入：{(metrics.revenueMilli7d / 1000).toFixed(2)} 积分</span>
          <span>近 7 天成本：{(metrics.costMilli7d / 1000).toFixed(2)} 积分</span>
          <span>
            近 7 天毛利：{(metrics.profitMilli7d / 1000).toFixed(2)} 积分
            {metrics.marginRate7d !== null && `（${(metrics.marginRate7d * 100).toFixed(1)}%）`}
          </span>
          <span>24h 支付失败订单：{metrics.payFail24h}</span>
          <span>24h 注册异常 IP：{metrics.registerBurstIps}</span>
        </div>
      )}

      {/* 批量操作条 */}
      {items != null && items.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-500">已选 {sel.length} 项</span>
          <button
            type="button"
            onClick={() => runBatch("ack")}
            disabled={busy || sel.length === 0}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-emerald-400 hover:border-emerald-500 disabled:opacity-50"
          >
            批量确认（仅消警）
          </button>
          <button
            type="button"
            onClick={() => runBatch("delete")}
            disabled={busy || sel.length === 0}
            className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-900/40 disabled:opacity-50"
          >
            批量删除
          </button>
        </div>
      )}

      <p className="mb-2 text-xs text-zinc-500">
        「确认」仅表示已人工核对并标记已阅，<span className="text-zinc-400">不会退款、补账或重试</span>
        ；需要动账请到会员余额页手动调整。测试账号（用户名以 qatest_ 开头）不参与运营告警。
      </p>

      {/* 告警列表 */}
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        {items == null ? (
          <div className="p-6 text-center text-sm text-zinc-500">加载中…</div>
        ) : items.length === 0 ? (
          <div className="p-6 text-center text-sm text-zinc-500">暂无告警</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-zinc-900/60">
                <tr>
                  <th className={th}>
                    <input
                      type="checkbox"
                      checked={items.length > 0 && items.every((a) => sel.includes(a.id))}
                      onChange={() => setSel(items.every((a) => sel.includes(a.id)) ? [] : items.map((a) => a.id))}
                    />
                  </th>
                  <th className={th}>级别</th>
                  <th className={th}>类型</th>
                  <th className={th}>内容</th>
                  <th className={th}>时间</th>
                  <th className={th}>状态</th>
                  <th className={th}>操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {items.map((a) => (
                  <tr key={a.id} className="hover:bg-zinc-900/40">
                    <td className={td}>
                      <input type="checkbox" checked={sel.includes(a.id)} onChange={() => toggleSel(a.id)} />
                    </td>
                    <td className={td}>
                      <span className={`rounded px-1.5 py-0.5 text-xs ${LEVEL_BADGE[a.level] || ""}`}>
                        {LEVEL_TEXT[a.level] || a.level}
                      </span>
                    </td>
                    <td className={`${td} text-xs`}>{alertTypeText(a)}</td>
                    <td className={`${td} max-w-[520px]`}>
                      <p className="whitespace-pre-wrap">{a.message}</p>
                      <AlertMeta a={a} />
                    </td>
                    <td className={`${td} text-xs`}>{fmt(a.createdAt)}</td>
                    <td className={`${td} text-xs`}>
                      {a.ackAt ? (
                        <span className="text-zinc-500">已确认 {fmt(a.ackAt)}</span>
                      ) : (
                        <span className="text-amber-400">未确认</span>
                      )}
                    </td>
                    <td className={td}>
                      {!a.ackAt && (
                        <button
                          type="button"
                          onClick={() => ackAlert(a.id)}
                          disabled={busy}
                          className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-emerald-400 hover:border-emerald-500 disabled:opacity-50"
                        >
                          确认（仅消警）
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        {/* 阈值配置 */}
        <div className="rounded-xl border border-zinc-800 p-5">
          <h3 className="mb-3 text-sm font-semibold text-zinc-200">告警阈值配置</h3>
          {cfg && (
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm text-zinc-200">
                <input
                  type="checkbox"
                  checked={cfg.enabled}
                  onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
                />
                开启自动巡检（cron 每小时 + 进程内对账扫描；关闭后两条自动路径都不再生成告警）
              </label>
              <div>
                <label className={labelCls}>积分池剩余阈值（全站有效积分低于该值告警；0 表示不限）</label>
                <input
                  type="number"
                  min={0}
                  value={cfg.creditPoolThreshold}
                  onChange={(e) => setCfg({ ...cfg, creditPoolThreshold: Math.max(0, parseInt(e.target.value) || 0) })}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>毛利率阈值（近 7 天低于该百分比告警；0 表示不启用）</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(cfg.marginRateThreshold * 1000) / 10}
                  onChange={(e) =>
                    setCfg({
                      ...cfg,
                      marginRateThreshold: Math.min(1, Math.max(0, (parseFloat(e.target.value) || 0) / 100)),
                    })
                  }
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>支付失败订单阈值（近 24 小时失败订单数；0 表示不限）</label>
                <input
                  type="number"
                  min={0}
                  value={cfg.payFail24hCount}
                  onChange={(e) => setCfg({ ...cfg, payFail24hCount: Math.max(0, parseInt(e.target.value) || 0) })}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>同 IP 注册阈值（近 24 小时同 IP 注册账号数；0 表示不限）</label>
                <input
                  type="number"
                  min={0}
                  value={cfg.registerBurstPerIp}
                  onChange={(e) => setCfg({ ...cfg, registerBurstPerIp: Math.max(0, parseInt(e.target.value) || 0) })}
                  className={inputCls}
                />
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={saveConfig}
            disabled={busy || !cfg}
            className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            保存阈值
          </button>
          {cfgSaved && <span className="ml-3 text-sm text-emerald-400">已保存 ✓</span>}
          <p className="mt-2 text-xs text-zinc-600">
            自动巡检 = cron（每小时）+ 进程内对账扫描（每 5 分钟），两者都受上方总开关控制；
            「立即检查」是手动巡检，不受总开关影响。所有数值阈值填 0 或留空 = 不限 / 不启用。
          </p>
        </div>

        {/* b16：我的告警订阅（按管理员分发，只有自己看得到自己的邮箱） */}
        <div className="rounded-xl border border-zinc-800 p-5">
          <h3 className="mb-3 text-sm font-semibold text-zinc-200">我的告警订阅</h3>
          <div className="space-y-3">
            <div>
              <label className={labelCls}>接收告警的邮箱（留空 = 不收邮件，仍可在本页看全部告警）</label>
              <input
                className={inputCls}
                type="email"
                value={subEmail}
                onChange={(e) => setSubEmail(e.target.value)}
                placeholder="name@example.com"
              />
            </div>
            <div>
              <label className={labelCls}>订阅类型（全选或不选 = 接收全部）</label>
              <div className="grid grid-cols-2 gap-2">
                {ALERT_TYPE_KEYS.map((t) => (
                  <label key={t} className="flex items-center gap-2 text-sm text-zinc-300">
                    <input
                      type="checkbox"
                      checked={subTypes.includes(t)}
                      onChange={() => toggleSubType(t)}
                    />
                    {ALERT_TYPE_LABELS[t]}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={saveSubscription}
            disabled={busy}
            className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            保存订阅
          </button>
          {subSaved && <span className="ml-3 text-sm text-emerald-400">已保存 ✓</span>}
          <p className="mt-2 text-xs text-zinc-600">
            命中订阅的新告警会发到上面邮箱；用量记录异常、对账重试耗尽等账务告警默认通知所有配置了邮箱的管理员。
            邮件发送失败不会影响巡检与对账，只记服务端日志。
          </p>
        </div>
      </div>
    </div>
  );
}
