"use client";

import { useState } from "react";
import { useLocale, translate as t } from "@/lib/i18n-client";

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const locale = useLocale();
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setOk(true);
        setTimeout(() => setOk(false), 1500);
      }}
      className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-1 text-xs font-medium transition ${
        ok ? "bg-emerald-500 text-zinc-950" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
      }`}
    >
      {ok ? t(locale, "btn.copied") : label || t(locale, "btn.copy")}
    </button>
  );
}
