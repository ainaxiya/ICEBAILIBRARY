import Link from "next/link";
import PlaygroundChat, {
  type PlaygroundInitialUse,
  type PlaygroundModel,
} from "@/components/playground/PlaygroundChat";
import RecommendedCards from "@/components/playground/RecommendedCards";
import PromptCard from "@/components/PromptCard";
import SkillCard from "@/components/SkillCard";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { imageSpecFor } from "@/lib/playground/media-spec";
import { videoCapabilityFor } from "@/lib/playground/video-capability";
import { getServerLocale } from "@/lib/i18n";
import { minBalanceCreditsFor } from "@/lib/gateway/credits-gate";
import { videoDisplayPricing, videoPerSecondMemberCredits } from "@/lib/gateway/pricing";
import { getBalance } from "@/lib/credits";
import { siteUrl } from "@/lib/seo";
import { getPlaygroundMaintenance } from "@/lib/ops/maintenance";
import { getPlaygroundAvatar } from "@/lib/playground/avatar";
import { getPlaygroundSettings } from "@/lib/playground/settings";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "冰山实验场 Iceberg Playground",
  description:
    "冰山AI资料库的实验场：直接试用精选提示词与技能，自由切换模型、调整参数并连续对话。",
  alternates: { canonical: siteUrl("/playground") },
};

// ─── 冰山实验场 Iceberg Playground ───
// 定位：不是独立站，而是「冰山AI资料库」的一个功能页。
// 布局/主题/导航/footer 全部继承 (site) 路由组（SiteHeader + 页脚），
// 登录注册沿用主站账号，卡片复用首页 PromptCard / SkillCard 模板。

const PICK = 6;

// 确定性洗牌（mulberry32）：同一 ?r= 种子结果稳定，「换一批」换种子必得新组合
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(list: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

type PromptData = Parameters<typeof PromptCard>[0]["p"];
type SkillData = Parameters<typeof SkillCard>[0]["s"];

const selectPrompt = {
  id: true,
  title: true,
  type: true,
  category: true,
  tags: true,
  sourceAuthor: true,
  viewCount: true,
  likeCount: true,
  favoriteCount: true,
  commentCount: true,
  createdAt: true,
  content: true,
  description: true,
  coverUrl: true,
  featured: true,
} as const;

const selectSkill = {
  id: true,
  slug: true,
  name: true,
  summary: true,
  tags: true,
  viewCount: true,
  copyCount: true,
  commentCount: true,
  createdAt: true,
  featured: true,
  category: { select: { slug: true, name: true, nameEn: true, icon: true } },
} as const;

export default async function PlaygroundPage({
  searchParams,
}: {
  searchParams: Promise<{ r?: string; use?: string }>;
}) {
  const [locale, user, sp, maintenance, avatar, pgSettings] = await Promise.all([
    getServerLocale(),
    getCurrentUser(),
    searchParams,
    getPlaygroundMaintenance(),
    getPlaygroundAvatar(),
    getPlaygroundSettings(),
  ]);
  // pa1 实验场总开关：关闭时直达链接显示关闭提示，不渲染对话、不查推荐数据
  if (!pgSettings.enabled) {
    return (
      <div className="mx-auto max-w-xl py-20 text-center">
        <h1 className="text-2xl font-bold text-zinc-100">实验场已关闭</h1>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400">
          冰山实验场暂时关闭。你仍可以浏览提示词、AI 技能与软件资料库。
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex items-center rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition hover:border-emerald-500/50 hover:text-emerald-300"
        >
          返回首页
        </Link>
      </div>
    );
  }

  // 随机种子：?r= 存在则按其洗牌（换一批），否则每次进入页面随机
  const seedNum = Number(sp?.r);
  const seed = Number.isFinite(seedNum) && seedNum > 0 ? seedNum : Math.floor(Math.random() * 2 ** 31);

  // 精选池（与首页精选同源：published + featured）；精选不足 6 个时用热门内容补齐
  const [featuredPrompts, featuredSkills, popularPrompts, popularSkills, modelRows] =
    await Promise.all([
      db.prompt.findMany({
        where: { status: "published", featured: true },
        select: selectPrompt,
      }),
      db.skill.findMany({
        where: { status: "published", featured: true },
        select: selectSkill,
      }),
      db.prompt.findMany({
        where: { status: "published", featured: false },
        select: selectPrompt,
        orderBy: { viewCount: "desc" },
        take: 36,
      }),
      db.skill.findMany({
        where: { status: "published", featured: false },
        select: selectSkill,
        orderBy: { viewCount: "desc" },
        take: 36,
      }),
      db.aiModel.findMany({
        where: {
          status: "online",
          endpointType: { in: ["chat", "image", "video", "audio"] },
          vendor: { status: "online" },
        },
        select: {
          id: true,
          name: true,
          displayName: true,
          remark: true,
          endpointType: true,
          capabilities: true,
          advancedConfig: true,
          vendor: { select: { name: true } },
          endpoints: { where: { enabled: true }, select: { path: true } },
          pricings: {
            select: {
              id: true,
              unit: true,
              variant: true,
              inputPrice: true,
              outputPrice: true,
              memberInputPrice: true,
              memberOutputPrice: true,
              currency: true,
              fxRateE8: true,
              multiplierBps: true,
              meterBase: true,
              effectiveAt: true,
            },
          },
        },
        orderBy: [{ vendorId: "asc" }, { id: "asc" }],
      }),
    ]);

  // 精选优先，不足 6 个用热门内容补齐（保证「推荐试一试」始终是 6 + 6）
  function buildBatch<T extends { id: number }>(
    featured: T[],
    popular: T[],
    size: number,
    baseSeed: number
  ): T[] {
    const chosen = seededShuffle(featured, baseSeed).slice(0, size);
    if (chosen.length >= size) return chosen;
    const used = new Set(chosen.map((x) => x.id));
    const fill = seededShuffle(
      popular.filter((x) => !used.has(x.id)),
      baseSeed + 1
    ).slice(0, size - chosen.length);
    return [...chosen, ...fill];
  }

  const prompts: PromptData[] = buildBatch(featuredPrompts, popularPrompts, PICK, seed).map((p) => ({
    ...p,
    sectionCount: (p.content.match(/^\[\d+\]/gm) || []).length,
  }));

  const skills: SkillData[] = buildBatch(featuredSkills, popularSkills, PICK, seed);

  // ── 模型：按创作类型分组，参数以模型库 capabilities 声明为准 ──
  // 对话模型必须「有定价 + chat_completions 端点」才能结算，否则不进下拉；
  // 图/视频/音频模型保留展示，缺端点或缺定价的由前端标注「通道未就绪」。
  const KIND_ENDPOINT: Record<string, string> = {
    chat: "chat_completions",
    image: "image_generations",
    video: "video_generations",
    audio: "audio_generations",
  };
  const KIND_ORDER: Record<string, number> = { chat: 0, image: 1, video: 2, audio: 3 };

  const models: PlaygroundModel[] = modelRows
    .map((m) => {
      const kind = m.endpointType as PlaygroundModel["kind"];
      const caps = (m.capabilities ?? null) as { params?: unknown } | null;
      const paramKeys = Array.isArray(caps?.params)
        ? caps!.params.filter((x): x is string => typeof x === "string")
        : [];
      // 视频：档位价优先、档位留空回退统一秒价；展示默认 720p 或最低档位价
      const videoPerSecond =
        kind === "video" ? videoPerSecondMemberCredits(videoDisplayPricing(m)) : null;
      return {
        id: m.id,
        name: m.name,
        displayName: m.displayName,
        remark: m.remark,
        vendorName: m.vendor?.name ?? null,
        kind,
        paramKeys,
        declared: paramKeys.length > 0,
        ready:
          m.endpoints.some((e) => e.path === KIND_ENDPOINT[kind]) &&
          (kind === "video" ? videoPerSecond != null : m.pricings.length > 0),
        // 图片模型的能力档位（未实测的 2K/4K 在界面禁用，避免发出去才失败）
        imageSpec: kind === "image" ? imageSpecFor(m.name) : null,
        // 视频能力：只从模型库 advancedConfig 读取分辨率/比例/时长/素材/有声
        videoCap: kind === "video" ? videoCapabilityFor(m.name, m.advancedConfig) : null,
        // 后台填写的统一秒价（积分/秒）；null = 未定价
        videoPricePerSecond: videoPerSecond,
        // 系列准入余额门槛（如 seedance 2.0 = 5000、2.5 = 10000）
        minBalanceCredits: minBalanceCreditsFor(m),
      };
    })
    // 对话/视频模型必须有可用定价才进下拉；视频未填统一秒价时不进实验场。
    .filter((m) =>
      m.kind === "chat" || m.kind === "video" ? m.ready : true
    )
    .sort(
      (a, b) =>
        (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.id - b.id
    );

  // 快捷入口：?use=prompt-<id> / skill-<id> → 服务端取正文，由对话框自动带入
  const useRaw = typeof sp?.use === "string" ? sp.use : "";
  const matched = /^(prompt|skill)-(\d+)$/.exec(useRaw);
  let initialUse: PlaygroundInitialUse | null = null;
  if (matched) {
    const useId = Number(matched[2]);
    if (matched[1] === "prompt") {
      const p = await db.prompt.findFirst({
        where: { id: useId, status: "published" },
        select: { id: true, title: true, content: true, type: true },
      });
      if (p) {
        // 多段提示词要按 [1] [2] … 拆段带入，截断过短会把后面的段切掉，
        // 这里放宽到 20000 字（单次带入，不影响列表接口体积）。
        initialUse = {
          kind: "prompt",
          id: p.id,
          title: p.title,
          content: p.content.slice(0, 20000),
          promptType: (p.type as PlaygroundInitialUse["promptType"]) ?? "text",
        };
      }
    } else {
      const s = await db.skill.findFirst({
        where: { id: useId, status: "published" },
        select: { id: true, name: true, skillMd: true },
      });
      if (s) {
        initialUse = {
          kind: "skill",
          id: s.id,
          title: s.name,
          content: s.skillMd.slice(0, 4000),
        };
      }
    }
  }

  return (
    <div>
      {/* 室内布局与入口卡由 PlaygroundChat 客户端渲染（切类型要即时生效）；站点头部/页脚不变 */}

      {/* 对话区（未登录时引导到主站登录/注册） */}
      <PlaygroundChat
        models={models}
        loggedIn={!!user}
        initialUse={initialUse}
        balance={user ? Number(await getBalance(user.id)) : null}
        maintenance={{ enabled: maintenance.enabled, message: maintenance.message }}
        avatarUrl={avatar.url}
        avatarIsDefault={avatar.isDefault}
        guestTrial={pgSettings.guest}
        defaultModels={pgSettings.defaultModels}
        lockDefaults={pgSettings.paramPolicy.lockDefaults}
        referenceLimits={pgSettings.limits}
        uploadLimits={pgSettings.upload}
        taskCopy={pgSettings.copy}
      />

      {/* 推荐试一试：随机 6 条提示词 + 6 个技能，复用首页卡片模板 */}
      <RecommendedCards prompts={prompts} skills={skills} locale={locale} />
    </div>
  );
}
