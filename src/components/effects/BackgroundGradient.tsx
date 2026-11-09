"use client";

// ─── 渐变流动边框卡片（对标 ui.aceternity.com/components/background-gradient）───
// 旋转 conic 渐变描边 + hover 辉光，纯 CSS 实现（bg-spin 关键帧在 globals.css）

export default function BackgroundGradient({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`group relative rounded-[18px] p-[1.5px] transition-shadow duration-300 hover:shadow-[0_0_36px_rgba(249,115,22,0.32),0_0_56px_rgba(168,85,247,0.28)] ${className}`}
    >
      {/* 旋转渐变描边层：默认天蓝→深紫，hover 切换橙→紫发光 */}
      <div aria-hidden className="absolute inset-0 overflow-hidden rounded-[18px]">
        <div
          className="absolute inset-[-150%] animate-[bg-spin_6s_linear_infinite] opacity-55 transition-opacity duration-300 group-hover:opacity-0"
          style={{
            background:
              "conic-gradient(from 0deg, #38bdf8, #60a5fa, #7c3aed, #4c1d95, #7c3aed, #38bdf8)",
          }}
        />
        <div
          className="absolute inset-[-150%] animate-[bg-spin_6s_linear_infinite] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          style={{
            background:
              "conic-gradient(from 0deg, #f97316, #fb923c, #c026d3, #a855f7, #7c3aed, #f97316)",
          }}
        />
      </div>
      {/* 卡片内容 */}
      <div className="relative h-full rounded-[16.5px] bg-zinc-900">{children}</div>
    </div>
  );
}
