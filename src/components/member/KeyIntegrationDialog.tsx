"use client";

import { useEffect, useState } from "react";
import {
  CLIENT_INTEGRATIONS,
  clientEndpoint,
  renderClientStep,
} from "@/lib/client-integrations";

// b3：Key 行「接入」弹层 —— Base URL 复制 + 各客户端手动配置步骤
// 说明：这些客户端均未提供可靠的官方深链，统一给出手动填写步骤，不编造导入方式。
export default function KeyIntegrationDialog({
  apiKey,
  onClose,
}: {
  apiKey: { id: number; keyPrefix: string; name: string | null };
  onClose: () => void;
}) {
  const [origin, setOrigin] = useState("");
  const [clientId, setClientId] = useState(CLIENT_INTEGRATIONS[0].id);
  const [copied, setCopied] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const base = origin ? `${origin}/v1` : "";
  const client = CLIENT_INTEGRATIONS.find((c) => c.id === clientId) ?? CLIENT_INTEGRATIONS[0];
  const endpoint = clientEndpoint(client, base || "https://你的站点/v1");
  const vars = { base: base || "https://你的站点/v1", endpoint };

  async function copy(value: string, tag: string) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(tag);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      /* 剪贴板不可用时保留文本供手动复制 */
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="客户端接入配置"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="关闭"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/60"
      />
      <div className="relative flex max-h-[86vh] w-full max-w-2xl flex-col rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-800 px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-100">客户端接入配置</h3>
            <p className="mt-1 text-xs text-zinc-500">
              用于 {apiKey.name ? `${apiKey.name} · ` : ""}
              <span className="font-mono text-zinc-400">{apiKey.keyPrefix}…</span>
              ，密钥请使用创建时保存的明文
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 rounded-lg px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* Base URL */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5">
            <div className="text-xs text-zinc-500">OpenAI 兼容 Base URL</div>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all font-mono text-xs text-emerald-300">
                {base || "加载中…"}
              </code>
              <button
                type="button"
                onClick={() => copy(base, "base")}
                disabled={!base}
                className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-600 disabled:cursor-not-allowed disabled:text-zinc-600"
              >
                {copied === "base" ? "已复制" : "复制"}
              </button>
            </div>
          </div>

          {/* 客户端切换 */}
          <div className="mt-4 flex flex-wrap gap-2">
            {CLIENT_INTEGRATIONS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setClientId(c.id)}
                className={`rounded-full px-3 py-1 text-xs transition ${
                  c.id === clientId
                    ? "bg-emerald-500/15 font-medium text-emerald-300"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>

          {/* 当前客户端配置 */}
          <div className="mt-3 rounded-xl border border-zinc-800 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium text-zinc-200">{client.name}</div>
                <div className="mt-0.5 text-xs text-zinc-500">{client.platform}</div>
              </div>
              <a
                href={client.homepage}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-400 hover:underline"
              >
                官网 / 下载 ›
              </a>
            </div>

            <div className="mt-3 rounded-lg bg-zinc-950 px-3 py-2">
              <div className="text-xs text-zinc-500">{client.addressLabel}</div>
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all font-mono text-xs text-emerald-300">
                  {endpoint}
                </code>
                <button
                  type="button"
                  onClick={() => copy(endpoint, "endpoint")}
                  disabled={!base}
                  className="shrink-0 rounded-lg border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:border-zinc-600 disabled:cursor-not-allowed disabled:text-zinc-600"
                >
                  {copied === "endpoint" ? "已复制" : "复制"}
                </button>
              </div>
            </div>

            <ol className="mt-3 space-y-1.5">
              {client.steps.map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-zinc-300">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs text-zinc-400">
                    {i + 1}
                  </span>
                  <span className="min-w-0 break-all">{renderClientStep(s, vars)}</span>
                </li>
              ))}
            </ol>

            {client.note && (
              <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
                {renderClientStep(client.note, vars)}
              </p>
            )}
          </div>

          <p className="mt-3 text-xs leading-relaxed text-zinc-500">
            以上客户端均支持自定义 OpenAI 兼容地址与 API Key，按步骤手动填写即可；未提供官方深链，不提供伪造的一键导入。
          </p>
        </div>

        <div className="border-t border-zinc-800 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
