import AuthForm from "./AuthForm";

// 桌面端左侧介绍区的四项能力（纯静态展示，不参与任何业务逻辑）
const FEATURES: { icon: "tools" | "doc" | "layers" | "flask"; title: string; desc: string }[] = [
  { icon: "tools", title: "AI工具精选", desc: "稳定可用 · 人工实测" },
  { icon: "doc", title: "深度提示词", desc: "结构清晰 · 直接复制" },
  { icon: "layers", title: "AI技能库", desc: "下载即用 · 高效验证" },
  { icon: "flask", title: "AI实验场", desc: "模型体验 · 创意验证" },
];

function FeatureIcon({ name }: { name: "tools" | "doc" | "layers" | "flask" }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "h-6 w-6",
  };
  switch (name) {
    case "tools":
      return (
        <svg {...common}>
          <path d="M14.5 6.5a4 4 0 1 0 5 5L21 13l-8 8-2-2-6-6a4 4 0 1 1 5-5l4.5 4.5z" />
        </svg>
      );
    case "doc":
      return (
        <svg {...common}>
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
        </svg>
      );
    case "layers":
      return (
        <svg {...common}>
          <path d="M12 3l9 5-9 5-9-5 9-5z" />
          <path d="M3 13l9 5 9-5" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M10 3h4M10 3v6l-5.5 9.2A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.8L14 9V3" />
          <path d="M7.5 15h9" />
        </svg>
      );
  }
}

/**
 * 登录 / 注册页中间区：
 * - 站点页头、页脚由 (site) 布局提供，这里只负责中间这块通栏视觉
 * - 背景按断点切换：<md 手机竖图，>=md PC 横图，均为 object-cover 不拉伸
 * - 桌面展示左侧品牌介绍，移动端只保留表单卡片
 */
export default function AuthShell({
  mode,
  siteName,
  logoIcon,
}: {
  mode: "login" | "register";
  siteName?: string;
  logoIcon?: string;
}) {
  return (
    <div className="auth-page relative isolate overflow-hidden bg-[#060f26]">
      {/* 移动端背景（竖图） */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/site-assets/auth/login-mobile.webp"
        alt=""
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full object-cover object-center md:hidden"
      />
      {/* 桌面端背景（横图） */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/site-assets/auth/login-pc.webp"
        alt=""
        aria-hidden
        className="pointer-events-none absolute inset-0 hidden h-full w-full object-cover object-center md:block"
      />
      {/* 压暗遮罩：保证文字与表单可读，移动端底部更暗以托住卡片 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(4,10,28,0.55)_0%,rgba(4,10,28,0.30)_38%,rgba(4,10,28,0.86)_100%)]"
      />

      <div className="relative mx-auto flex w-full max-w-6xl flex-col justify-center px-4 pb-24 pt-6 md:pb-10 md:pt-8 lg:min-h-[calc(100svh-9.5rem)]">
        <div className="grid w-full gap-10 lg:grid-cols-[minmax(0,1fr)_420px]">
          {/* 桌面端品牌介绍：移动端整块不渲染 */}
          <div className="hidden lg:block">
            <span className="inline-flex items-center mt-5 gap-1.5 rounded-full border border-[rgba(70,144,255,0.7)] bg-white/[0.06] px-3.5 py-1.5 text-[13px] font-medium text-sky-300 backdrop-blur-sm">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                <path d="M12 2l1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6L12 2z" />
              </svg>
              聚合 AI 效率平台 icebai.com
            </span>

            <p className="mt-5 text-[46px] font-extra leading-[1.12] tracking-tight text-white xl:text-[52px]">
              <span className="text-gold-gradient">{siteName}</span>
            </p>
<span className="inline-flex items-center gap-1.5 mt-4 max-w-xl text-[16px] rounded-[10px] font-semi leading-relaxed text-white/90  bg-white/6 px-3.5 py-4 backdrop-blur-[2px]">
            <p className="">
              是专为自媒体、AI视频创作、电商卖家及办公族打造的AI效率平台
              <br />
              我们坚持人工实测，严选收录稳定可用的AI工具
              <br />
              并提供包含适用模型标注、结构可直接复制的深度AI提示词
              <br />
              以及下载即用的AI技能库，助力个人与企业降本增效
              
            </p>
            </span>

            <div className="mt-62 grid max-w-2xl grid-cols-4 gap-3">
              {FEATURES.map((f) => (
                <div
                  key={f.title}
                  className="rounded-2xl border border-[rgba(70,144,255,0.7)] bg-[#071031]/45 px-2.5 py-4 text-center backdrop-blur-md"
                >
                  <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-[rgba(70,144,255,0.7)] text-sky-300">
                    <FeatureIcon name={f.icon} />
                  </span>
                  <p className="mt-2.5 text-[14px] font-semibold text-white">{f.title}</p>
                  <p className="mt-1 text-xs leading-snug text-sky-300">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* 表单卡片：移动端居中独占，桌面端落在右列 */}
          <div className="flex justify-center lg:justify-end">
            <AuthForm mode={mode} siteName={siteName} logoIcon={logoIcon} />
          </div>
        </div>
      </div>
    </div>
  );
}
