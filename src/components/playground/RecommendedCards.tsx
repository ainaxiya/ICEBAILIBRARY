import Link from "next/link";
import PromptCard from "@/components/PromptCard";
import SkillCard from "@/components/SkillCard";
import { type Locale } from "@/lib/i18n";
import RecommendRefresh from "./RecommendRefresh";
import PlaygroundCoverFallback from "./PlaygroundCoverFallback";

// ─── 冰山实验场「推荐试一试」 ───
// 直接复用首页的提示词卡片 / 技能卡片模板（不另做一套视觉）。
// 随机规则：精选池中随机 6 条提示词 + 6 个技能，同一批内不重复；
// 「换一批」通过 ?r=<时间戳> 换随机种子重新渲染（见 RecommendRefresh）。
// 快捷入口：卡片下方「在实验场试用」带参跳转（?use=prompt-<id> / skill-<id>），
// 由页面服务端取正文后塞进对话框，省去先看点详情页再复制的一步。

type PromptData = Parameters<typeof PromptCard>[0]["p"];
type SkillData = Parameters<typeof SkillCard>[0]["s"];

function TryLink({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="mt-1.5 flex items-center justify-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs font-medium text-emerald-300 transition hover:border-emerald-400/60 hover:bg-emerald-500/10"
    >
      ⚡ 在实验场试用
    </Link>
  );
}

export default function RecommendedCards({
  prompts,
  skills,
  locale = "zh",
}: {
  prompts: PromptData[];
  skills: SkillData[];
  locale?: Locale;
}) {
  return (
    <section className="mt-14">
      {/* 区块标题（沿用首页「眉题 + 渐变细线」的排版语言） */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <span className="h-px w-8 bg-gradient-to-r from-transparent to-emerald-400/60 sm:w-12" />
            <span className="text-xs font-semibold uppercase tracking-[0.35em] text-emerald-300/80 sm:text-xs">
              Try These
            </span>
          </div>
          <h2 className="mt-1.5 text-2xl font-black tracking-tight text-zinc-50 sm:text-3xl">
            推荐试一试
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            随机精选 6 条提示词 + 6 个技能，点开即用
          </p>
        </div>
        <RecommendRefresh />
      </div>

      {/* 精选提示词 6 条（首页卡片模板） */}
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-300">
          📄 精选提示词 {prompts.length}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {prompts.map((p) => (
          <div key={`p-${p.id}`} className="flex flex-col">
            <PlaygroundCoverFallback>
              <PromptCard p={p} locale={locale} />
            </PlaygroundCoverFallback>
            <TryLink href={`/playground?use=prompt-${p.id}`} />
          </div>
        ))}
      </div>
      {prompts.length === 0 && (
        <p className="py-8 text-center text-sm text-zinc-600">暂无精选提示词</p>
      )}

      {/* 精选技能 6 个（首页卡片模板） */}
      <div className="mb-2 mt-8 flex items-center gap-2">
        <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-300">
          🧩 精选技能 {skills.length}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {skills.map((s) => (
          <div key={`s-${s.id}`} className="flex flex-col">
            <SkillCard s={s} locale={locale} />
            <TryLink href={`/playground?use=skill-${s.id}`} />
          </div>
        ))}
      </div>
      {skills.length === 0 && (
        <p className="py-8 text-center text-sm text-zinc-600">暂无精选技能</p>
      )}
    </section>
  );
}
