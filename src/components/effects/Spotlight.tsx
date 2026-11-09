// ─── 聚光灯效果（对标 ui.aceternity.com/components/spotlight-new 的 <Spotlight />）───
// 只渲染灯光层（absolute 铺满相对定位的父容器），光束固定不跟随鼠标
// 用法：父容器 relative overflow-hidden，先放 <Spotlight />，内容加 relative z-10

const gradientFirst =
  "radial-gradient(68.54% 68.72% at 55.02% 31.46%, hsla(210, 100%, 85%, 0.12) 0, hsla(210, 100%, 55%, 0.04) 50%, hsla(210, 100%, 45%, 0) 80%)";
const gradientSecond =
  "radial-gradient(50% 50% at 50% 50%, hsla(210, 100%, 85%, 0.09) 0, hsla(210, 100%, 55%, 0.02) 80%, transparent 100%)";
const gradientThird =
  "radial-gradient(50% 50% at 50% 50%, hsla(210, 100%, 85%, 0.07) 0, hsla(210, 100%, 45%, 0.02) 80%, transparent 100%)";

export default function Spotlight() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* 左侧聚光灯（斜向打入） */}
      <div
        className="absolute left-[-22%] top-[-350px] h-[1380px] w-[560px] rotate-[20deg]"
        style={{ background: gradientFirst }}
      />
      {/* 右侧聚光灯（斜向打入） */}
      <div
        className="absolute right-[-22%] top-[-350px] h-[1380px] w-[560px] -rotate-[20deg]"
        style={{ background: gradientFirst }}
      />
      {/* 左右小光斑 */}
      <div
        className="absolute left-[6%] top-[-160px] h-[560px] w-[240px] rotate-[20deg]"
        style={{ background: gradientThird }}
      />
      <div
        className="absolute right-[6%] top-[-160px] h-[560px] w-[240px] -rotate-[20deg]"
        style={{ background: gradientThird }}
      />
      {/* 中央柔和补光 */}
      <div
        className="absolute left-1/2 top-[-12%] h-[520px] w-[720px] -translate-x-1/2"
        style={{ background: gradientSecond }}
      />
    </div>
  );
}
