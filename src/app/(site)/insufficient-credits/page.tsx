import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getBalance } from "@/lib/credits";

export const dynamic = "force-dynamic";

export const metadata = { title: "积分不足", robots: { index: false, follow: false } };

// 只接受站内路径，防止 next 被用来做开放重定向
function safeNext(raw: string | string[] | undefined, fallback: string): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return fallback;
  if (!v.startsWith("/") || v.startsWith("//")) return fallback;
  return v;
}

function safeNeed(raw: string | string[] | undefined): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

// 设计稿素材（PNG 已转 WebP，透明通道保留，静态直出不做二次压缩）
const ASSET = "/site-assets/points-page";

// 充值积分的作用：4 条，图标全部复用设计稿同档素材
const BENEFITS = [
  { icon: "huangguan", title: "解锁全部模型", desc: "高清视频模型全线开放" },
  { icon: "jinbidui", title: "批量充值更划算", desc: "大额充值赠送更多" },
  { icon: "rili", title: "积分长期有效", desc: "充值积分不设有效期" },
  { icon: "gougou", title: "即时到账可用", desc: "支付成功即可生成" },
];

export default async function InsufficientCreditsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const next = safeNext(sp.next, "/playground");
  const need = safeNeed(sp.need);

  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/insufficient-credits?next=${encodeURIComponent(next)}`)}`);
  }

  const balance = Number(await getBalance(user.id));
  const gap = need != null ? Math.max(0, need - balance) : null;
  const rechargeHref = `/recharge?next=${encodeURIComponent(next)}`;

  return (
    <div className="mx-auto max-w-6xl">
      <section className="glow-line-sky relative isolate overflow-hidden rounded-[28px] border border-[rgba(56,189,248,0.22)] bg-[#071031]">
        {/* 冰山背景：居中放大 130%，超出部分由卡片裁掉 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`${ASSET}/beijingtu.webp`}
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full scale-[1.3] object-cover object-center opacity-75"
        />
        {/* 压暗叠层，保证右侧文字可读 */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#050b24]/55 via-[#061033]/45 to-[#061033]/80" />

        <div className="relative flex flex-col md:flex-row md:items-stretch">
          {/* 人物插画：左缘出血裁切，桌面端底部被下方「作用」卡片盖住 */}
          <div className="md:w-[54%] md:shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`${ASSET}/lihuahua.webp`}
              alt=""
              aria-hidden
              className="block w-[132%] max-w-none -ml-[26%] md:-mb-5 md:-ml-[10%] md:w-[110%]"
            />
          </div>

          {/* 主体信息 */}
          <div className="relative z-10 flex-1 px-5 pb-6 pt-4 sm:px-8 md:flex md:flex-col md:justify-center md:py-10 md:pl-3 md:pr-10">
            <div className="flex items-center justify-center gap-3 md:justify-start">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${ASSET}/jinbi.webp`} alt="" aria-hidden className="h-12 w-12 md:h-14 md:w-14" />
              <h1 className="title-gradient text-[34px] font-bold leading-none tracking-wide sm:text-[38px] md:text-[52px]">
                积分不足
              </h1>
            </div>
            <p className="mt-3 text-center text-sm leading-6 text-zinc-200 [text-shadow:0_1px_10px_rgba(6,13,42,0.9)] md:text-left md:text-base">
              抱歉，您的积分余额不足，无法使用该功能。
            </p>

            {/* 当前积分框：宽度与下方两个按钮合计一致 */}
            <dl className="glow-line-sky mt-5 grid grid-cols-3 divide-x divide-[rgba(56,189,248,0.16)] overflow-hidden rounded-2xl border border-[rgba(56,189,248,0.28)] bg-white/[0.06] py-3.5 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-1 px-2 text-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${ASSET}/jinbi.webp`} alt="" aria-hidden className="h-5 w-5" />
                <dt className="text-xs text-zinc-400">当前积分</dt>
                <dd className="text-lg font-bold text-white md:text-xl">{balance}</dd>
              </div>
              <div className="flex flex-col items-center gap-1 px-2 text-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${ASSET}/jinbi.webp`} alt="" aria-hidden className="h-5 w-5" />
                <dt className="text-xs text-zinc-400">所需积分</dt>
                <dd className="text-lg font-bold text-white md:text-xl">{need != null ? need : "—"}</dd>
              </div>
              <div className="flex flex-col items-center gap-1 px-2 text-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${ASSET}/jinbidui.webp`} alt="" aria-hidden className="h-5 w-5" />
                <dt className="text-xs text-zinc-400">还差</dt>
                <dd className="text-lg font-bold text-amber-300 md:text-xl">{gap != null ? gap : "—"}</dd>
              </div>
            </dl>

            <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
              <Link
                href={rechargeHref}
                className="glow-line-sky inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-[rgba(56,189,248,0.45)] bg-gradient-to-r from-[#2b6df6] to-[#38d9f0] px-6 py-3 text-sm font-semibold text-white transition hover:brightness-110"
              >
                <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4 fill-current">
                  <path d="M13 2 4.5 13.2h5.2L10 22l8.6-11.4h-5.4L13 2Z" />
                </svg>
                立即充值积分
              </Link>
              <Link
                href="/credit-rules"
                className="glow-line-sky inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-[rgba(56,189,248,0.32)] bg-white/[0.06] px-6 py-3 text-sm font-medium text-zinc-100 backdrop-blur-sm transition hover:border-[rgba(56,189,248,0.55)] hover:bg-white/[0.1] hover:text-white"
              >
                查看积分规则
              </Link>
            </div>

            {/* 返回上页：小按钮，水平居中 */}
            <div className="mt-4 flex justify-center">
              <Link
                href={next}
                className="glow-line-sky inline-flex items-center justify-center rounded-lg border border-[rgba(56,189,248,0.32)] bg-[rgba(56,189,248,0.10)] px-4 py-1.5 text-xs text-royal-200 transition hover:bg-[rgba(56,189,248,0.18)] hover:text-white"
              >
                返回上页
              </Link>
            </div>
          </div>
        </div>

        {/* 充值积分的作用：独立外框 + 内部条目分割线 */}
        <div className="relative z-20 px-4 pb-5 sm:px-6 md:-mt-6 md:pb-6">
          <div className="glow-line-sky overflow-hidden rounded-2xl border border-[rgba(56,189,248,0.28)] bg-[#081130]/95 backdrop-blur-md">
            <div className="flex flex-col sm:flex-row sm:items-stretch">
              <p className="shrink-0 border-b border-[rgba(56,189,248,0.14)] px-4 py-3 text-sm font-semibold text-white sm:flex sm:items-center sm:border-b-0 sm:border-r sm:py-0 sm:pr-4">
                充值积分的作用：
              </p>
              <div className="grid flex-1 grid-cols-2 sm:grid-cols-4">
                {BENEFITS.map((b, i) => (
                  <div
                    key={b.title}
                    className={[
                      "flex flex-col items-center gap-1.5 border-[rgba(56,189,248,0.14)] px-2 py-3 text-center",
                      "sm:flex-row sm:items-center sm:gap-2.5 sm:px-3 sm:py-3.5 sm:text-left",
                      i % 2 === 1 ? "border-l" : "",
                      i >= 2 ? "border-t" : "",
                      "sm:border-t-0",
                      i > 0 ? "sm:border-l" : "sm:border-l-0",
                    ].join(" ")}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`${ASSET}/${b.icon}.webp`} alt="" aria-hidden className="h-8 w-8 shrink-0 object-contain md:h-9 md:w-9" />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium leading-tight text-white sm:text-[13px]">{b.title}</span>
                      <span className="mt-0.5 block text-xs leading-tight text-zinc-300 sm:text-xs">{b.desc}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
