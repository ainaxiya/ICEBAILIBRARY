import Link from "next/link";
import { translate, type Locale } from "@/lib/i18n";
import CardCover, { TextCover, Placeholder } from "@/components/CardCover";
import { plainExcerpt } from "@/lib/excerpt";
import { getCategoryMeta } from "@/lib/category-meta";

const TYPE_KEY: Record<string, "type.video" | "type.image" | "type.audio" | "type.text"> = {
  video: "type.video",
  image: "type.image",
  audio: "type.audio",
  text: "type.text",
};

const TYPE_CLS: Record<string, string> = {
  video: "bg-sky-500/15 text-sky-300",
  image: "bg-rose-500/15 text-rose-300",
  audio: "bg-amber-500/15 text-amber-300",
  text: "bg-emerald-500/15 text-emerald-300",
};

export default function PromptCard({
  p,
  locale = "zh",
}: {
  p: {
    id: number;
    title: string;
    type: string;
    category?: string;
    tags: string[];
    sourceAuthor: string | null;
    likeCount?: number;
    viewCount?: number;
    sectionCount?: number;
    coverUrl?: string | null;
    featured?: boolean;
    description?: string | null;
    content?: string | null;
    excerpt?: string | null;
  };
  locale?: Locale;
}) {
  const tk = TYPE_KEY[p.type] || TYPE_KEY.text;
  // 无封面时的文字摘要：显式 excerpt > 简介 description > 正文提纯
  const excerptText =
    p.excerpt || p.description || (p.content ? plainExcerpt(p.content, 90) : "");
  return (
    <Link
      href={`/p/${p.id}`}
      className="brand-card group flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/70 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset] transition duration-200 hover:-translate-y-0.5 hover:border-emerald-500/60 hover:bg-zinc-900 hover:shadow-[0_14px_34px_-16px_rgba(0,0,0,0.7),0_0_0_1px_rgba(56,189,248,0.25)]"
    >
      <div className="relative aspect-video w-full overflow-hidden bg-zinc-950/60">
        {p.coverUrl ? (
          <>
            <CardCover
              src={p.coverUrl}
              title={p.title}
              fallback={excerptText ? <TextCover text={excerptText} type={p.type} /> : <Placeholder />}
            />
            <span className="absolute inset-0 bg-gradient-to-t from-zinc-950/45 via-transparent to-transparent opacity-0 transition group-hover:opacity-100" />
          </>
        ) : excerptText ? (
          <TextCover text={excerptText} type={p.type} />
        ) : (
          <Placeholder />
        )}
        {p.featured && (
          <span className="absolute right-2 top-2 rounded-md bg-emerald-500/95 px-1.5 py-0.5 text-[10px] font-bold text-zinc-950 shadow-[0_2px_10px_rgba(34,211,238,0.5)]">
            ★ 精选
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {p.category && (
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${getCategoryMeta(p.category).bg} ${getCategoryMeta(p.category).fg}`}>
              {getCategoryMeta(p.category).name[locale]}
            </span>
          )}
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${TYPE_CLS[p.type] || TYPE_CLS.text}`}>
            {translate(locale, tk)}
          </span>
          {p.sectionCount ? (
            p.sectionCount >= 100 ? (
              <span className="text-xs font-bold text-rose-400 drop-shadow-[0_0_6px_rgba(251,113,133,0.5)]">
                超详{p.sectionCount}段词
              </span>
            ) : (
              <span className="text-xs text-zinc-500">全集{p.sectionCount}段词</span>
            )
          ) : null}
        </div>
        <h3 className="mb-2 line-clamp-2 font-medium leading-snug text-zinc-100 transition group-hover:text-emerald-300">
          {p.title}
        </h3>
        <div className="mt-auto flex items-center justify-between pt-2 text-xs text-zinc-500">
          <span className="truncate">{p.sourceAuthor || translate(locale, "card.community")}</span>
          <span className="flex items-center gap-1 text-zinc-500">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
            {p.viewCount ?? 0}
          </span>
        </div>
        {p.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {p.tags.slice(0, 3).map((t) => (
              <span key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}
