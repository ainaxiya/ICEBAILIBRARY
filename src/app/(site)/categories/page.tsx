import Link from "next/link";
import { db } from "@/lib/db";
import CategoryIcon from "@/components/CategoryIcon";
import { getCategoryMeta } from "@/lib/category-meta";
import { getServerLocale } from "@/lib/i18n";
import { breadcrumbJsonLd, siteUrl } from "@/lib/seo";
import BackgroundGradient from "@/components/effects/BackgroundGradient";
import { CanvasText } from "@/components/effects/CanvasText";

export const dynamic = "force-dynamic";

export const metadata = { title: "提示词分类浏览" };

// v0.93 分类页改版：用户重新设计的 webp 图标（1-15 分类 / 16-19 创作类型）
// 按分类名映射（库中 Category.slug 即中文名），同时兼容 2 字母短码 slug
const CAT_ICON_FILE: Record<string, number> = {
  视频创作: 1,
  音频创作: 2,
  图片创作: 3,
  编程开发: 4,
  游戏设计: 5,
  网站开发: 6,
  办公写作: 7,
  网络安全: 8,
  科学物理: 9,
  金融理财: 10,
  破甲提示词: 11,
  AI智能体: 12,
  人生管理: 13,
  内容创作: 14,
  教育学习: 15,
  // 兼容 2 字母短码 slug
  sp: 1,
  yp: 2,
  tp: 3,
  bc: 4,
  yx: 5,
  wz: 6,
  bg: 7,
  wa: 8,
  kx: 9,
  jr: 10,
  pj: 11,
  zn: 12,
  life: 13,
  content: 14,
  edu: 15,
};
const TYPE_ICON_FILE: Record<string, number> = {
  text: 16, // 文本创作
  image: 17, // 文生图
  video: 18, // 文生视频
  audio: 19, // 文生音频
};

// 创作类型元信息（与详情页 /type 列表页保持一致）
const TYPE_META: Record<string, { zh: string; en: string; desc: { zh: string; en: string } }> = {
  text: {
    zh: "文本创作",
    en: "Text",
    desc: { zh: "写作、对话、代码、角色设定等纯文本提示词", en: "Pure text prompts for writing, chat, code, roles" },
  },
  image: {
    zh: "文生图",
    en: "Image",
    desc: { zh: "Midjourney、SD、即梦等 AI 绘画提示词", en: "AI art prompts for Midjourney, SD, Jimeng, etc." },
  },
  video: {
    zh: "文生视频",
    en: "Video",
    desc: { zh: "即梦、可灵、Runway 等 AI 视频生成提示词", en: "AI video prompts for Jimeng, Kling, Runway, etc." },
  },
  audio: {
    zh: "文生音频",
    en: "Audio",
    desc: { zh: "音乐、配音、音效等 AI 音频生成提示词", en: "AI audio prompts for music, voice, SFX" },
  },
};
const TYPE_ORDER = ["text", "image", "video", "audio"];

// ── 波浪纹理参数（v0.93 加密版）：密线全蓝高饱和，白色仅留隐约发丝分割线 ──
const WAVE = {
  lineWidth: 1.2,
  lineGap: 1.5,
  backgroundClassName: "bg-white",
  colors: [
    "rgba(0, 130, 255, 1)",
    "rgba(0, 150, 255, 0.95)",
    "rgba(0, 115, 255, 1)",
    "rgba(0, 165, 255, 0.95)",
    "rgba(0, 140, 255, 1)",
    "rgba(0, 125, 255, 0.95)",
    "rgba(0, 155, 255, 1)",
    "rgba(0, 135, 255, 0.95)",
    "rgba(0, 120, 255, 1)",
    "rgba(0, 145, 255, 0.95)",
  ],
  animationDuration: 20,
};

function CatIcon({ name, slug, className }: { name?: string; slug: string; className?: string }) {
  const file = (name ? CAT_ICON_FILE[name] : undefined) ?? CAT_ICON_FILE[slug];
  if (file) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={`/icons/cat/${file}.webp`} alt="" className={className} />;
  }
  return <CategoryIcon icon={getCategoryMeta(slug).icon} className={className} />;
}

export default async function CategoriesPage() {
  const locale = await getServerLocale();

  const [cats, groups, typeGroups, total] = await Promise.all([
    db.category.findMany({ orderBy: { sort: "asc" } }),
    db.prompt.groupBy({
      by: ["category"],
      where: { status: "published" },
      _count: { _all: true },
    }),
    db.prompt.groupBy({
      by: ["type"],
      where: { status: "published" },
      _count: { _all: true },
    }),
    db.prompt.count({ where: { status: "published" } }),
  ]);
  const counts = new Map(groups.map((g) => [g.category, g._count._all]));
  const typeCounts = new Map(typeGroups.map((g) => [g.type, g._count._all]));

  return (
    <div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: breadcrumbJsonLd([
            { name: "首页", item: siteUrl() },
            { name: "提示词分类浏览", item: siteUrl("/categories") },
          ]),
        }}
      />

      {/* ── Hero：大字 CanvasText 动态纹理字效（超宽自动等比缩放，手机端不再裁切）；副标题为纯文本（无动画）── */}
      <div className="px-4 py-16 text-center">
        <h1 className="font-spotlight text-3xl font-bold tracking-tight sm:text-4xl md:text-7xl">
          <CanvasText text="按提示词分类浏览" {...WAVE} />
        </h1>
        {/* 手机端：两行统一 12px 纯白；桌面端保留原 Inter 大字副标题 */}
        <p className="mt-6 max-w-3xl text-center mx-auto text-xs font-normal leading-relaxed text-white sm:font-spotlight sm:text-2xl sm:font-semibold sm:text-zinc-50">
          超多免费 AI 提示词库覆盖图像、视频、开发、安全
        </p>
        <p className="mt-2 max-w-3xl text-center mx-auto text-xs font-normal leading-relaxed text-white sm:font-spotlight sm:text-2xl sm:font-semibold sm:text-zinc-50">
          整合全球优质AI提示词行业解决方案
        </p>
        <p className="mt-7 text-center">
          <span className="inline-block rounded-full border border-zinc-600/70 bg-zinc-800/40 px-5 py-1.5 text-xs text-zinc-400 sm:font-spotlight sm:text-sm sm:text-zinc-300">
            已存{total.toLocaleString("en-US")}条提示词
          </span>
        </p>
      </div>

      {/* ── 15 分类卡片：渐变流动边框（v0.93；手机一排 2 个，PC 不变）── */}
      <div className="grid grid-cols-2 gap-3 sm:gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {cats.map((c) => {
          const meta = getCategoryMeta(c.slug);
          const n = counts.get(c.slug) || 0;
          const name = locale === "zh" ? c.name : c.nameEn;
          const desc = meta.desc[locale];
          return (
            <BackgroundGradient key={c.id}>
              <Link
                href={`/category/${encodeURIComponent(c.slug)}`}
                className="flex min-h-[190px] flex-col p-3 sm:min-h-[240px] sm:p-6"
              >
                {/* 大图标居中（带投影） */}
                <span className="mb-5 flex h-24 w-24 items-center justify-center self-center sm:h-40 sm:w-40">
                  <CatIcon name={c.name} slug={c.slug} className="h-24 w-24 object-contain drop-shadow-[0_8px_22px_rgba(0,0,0,0.55)] sm:h-40 sm:w-40" />
                </span>
                <h2 className="mb-1.5 text-center text-base font-semibold text-zinc-100 drop-shadow-[0_2px_10px_rgba(0,0,0,0.65)] transition group-hover:text-orange-400 group-hover:drop-shadow-[0_0_16px_rgba(251,146,60,0.7)] sm:text-2xl">
                  {name}
                </h2>
                <p className="mb-4 line-clamp-2 flex-1 text-xs leading-relaxed text-zinc-400 sm:text-xs">{desc}</p>
                <div className="flex items-end justify-between">
                  <span className="text-xs text-zinc-500 sm:text-xs">{n.toLocaleString("en-US")} 条提示词</span>
                  <span className="rounded-full border border-zinc-700 bg-zinc-800/70 px-2.5 py-1 text-xs text-zinc-300 transition group-hover:border-orange-400/70 group-hover:bg-orange-500/15 group-hover:text-orange-400 sm:px-3.5 sm:py-1.5 sm:text-xs">
                    查看全部
                  </span>
                </div>
              </Link>
            </BackgroundGradient>
          );
        })}
      </div>

      {/* ── 按创作类型浏览：大字 CanvasText 字效 + 纯文本说明（无动画）── */}
      <div className="mt-16">
        <h2 className="text-center font-spotlight text-3xl font-bold tracking-tight sm:text-4xl md:text-7xl">
          <CanvasText text="按创作类型浏览" {...WAVE} />
        </h2>
        <p className="mb-6 mt-6 text-center text-base">
          4 种创作类型，快速找到你想要的提示词形式
        </p>
        <div className="relative grid grid-cols-2 gap-3 px-4 sm:gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {TYPE_ORDER.map((type) => {
            const meta = TYPE_META[type];
            const n = typeCounts.get(type) || 0;
            const name = locale === "zh" ? meta.zh : meta.en;
            const desc = meta.desc[locale];
            return (
              <BackgroundGradient key={type}>
                <Link href={`/type/${type}`} className="flex min-h-[190px] flex-col p-3 sm:min-h-[240px] sm:p-6">
                  {/* 大图标居中（带投影，与分类卡一致） */}
                  <span className="mb-5 flex h-24 w-24 items-center justify-center self-center sm:h-40 sm:w-40">
                    <img
                      src={`/icons/cat/${TYPE_ICON_FILE[type]}.webp`}
                      alt=""
                      className="h-24 w-24 object-contain drop-shadow-[0_8px_22px_rgba(0,0,0,0.55)] sm:h-40 sm:w-40"
                    />
                  </span>
                  <h3 className="mb-1.5 text-center text-base font-semibold text-zinc-100 drop-shadow-[0_2px_10px_rgba(0,0,0,0.65)] transition group-hover:text-orange-400 group-hover:drop-shadow-[0_0_16px_rgba(251,146,60,0.7)] sm:text-2xl">
                    {name}
                  </h3>
                  <p className="mb-4 line-clamp-2 flex-1 text-xs leading-relaxed text-zinc-400 sm:text-xs">{desc}</p>
                  <div className="flex items-end justify-between">
                    <span className="text-xs text-zinc-500 sm:text-xs">{n.toLocaleString("en-US")} 条提示词</span>
                    <span className="rounded-full border border-zinc-700 bg-zinc-800/70 px-2.5 py-1 text-xs text-zinc-300 transition group-hover:border-orange-400/70 group-hover:bg-orange-500/15 group-hover:text-orange-400 sm:px-3.5 sm:py-1.5 sm:text-xs">
                      查看全部
                    </span>
                  </div>
                </Link>
              </BackgroundGradient>
            );
          })}
        </div>
      </div>
    </div>
  );
}
