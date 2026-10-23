"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, translate as t } from "@/lib/i18n-client";

export type DlButton = {
  id: number; label: string; memberOnly: boolean; sizeBytes: number | null; storageType: string;
};

function fmtSize(n: number | null): string {
  if (n == null || n <= 0) return "";
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export default function SoftwareDownloadButtons({
  softwareId, downloads, loggedIn,
}: {
  softwareId: number; downloads: DlButton[]; loggedIn: boolean;
}) {
  const locale = useLocale();
  const router = useRouter();
  const [err, setErr] = useState("");

  const go = async (dl: DlButton) => {
    setErr("");
    const url = `/api/software/${softwareId}/download?dl=${dl.id}`;
    if (dl.memberOnly && !loggedIn) {
      router.push(`/login?next=${encodeURIComponent(`/software/${softwareId}`)}`);
      return;
    }
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/software/${softwareId}`)}`);
        return;
      }
      if (r.type === "opaqueredirect" || (r.status >= 300 && r.status < 400)) {
        location.href = url;
        return;
      }
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setErr(d?.error || t(locale, "soft.dlFailed"));
        return;
      }
      location.href = url;
    } catch {
      location.href = url;
    }
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2.5">
        {downloads.map((dl, i) => (
          <button
            key={dl.id}
            type="button"
            onClick={() => go(dl)}
            className={`inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold shadow-lg transition active:scale-95 ${
              i === 0
                ? "bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-emerald-600/30 hover:from-emerald-400 hover:to-teal-400"
                : "border border-sky-600/60 bg-sky-500/10 text-sky-300 shadow-sky-900/20 hover:border-sky-500 hover:bg-sky-500/20 hover:text-sky-200"
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            {dl.label}
            {dl.sizeBytes != null && dl.sizeBytes > 0 && (
              <span className="text-xs opacity-70">{fmtSize(dl.sizeBytes)}</span>
            )}
            {dl.memberOnly && (
              <span title={t(locale, "soft.memberOnly")} className="inline-flex">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 opacity-80"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              </span>
            )}
          </button>
        ))}
      </div>
      {err && <p className="mt-2 text-sm text-rose-400">{err}</p>}
    </div>
  );
}
