"use client";

import { useEffect, useRef } from "react";

// ─── 星火粒子（对标 ui.aceternity.com/components/sparkles 的 SparklesCore）───
// 微小白粒在容器内轻盈漂移 + 随机闪烁，纯 Canvas 实现
// 配合 demo 结构使用：<Sparkles ... /> 外面盖一层 radial mask 黑色渐变收边

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  da: number;
};

export default function Sparkles({
  className = "",
  background = "transparent",
  particleColor = "#FFFFFF",
  minSize = 0.4,
  maxSize = 1,
  particleDensity = 1200,
}: {
  className?: string;
  background?: string;
  particleColor?: string;
  minSize?: number;
  maxSize?: number;
  particleDensity?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let particles: Particle[] = [];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // particleDensity 对齐 demo 的 1200：按面积换算粒子数，封顶防卡
      const count = Math.min(Math.round((rect.width * rect.height) / 320 * (particleDensity / 1200)), 400);
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * rect.width,
        y: Math.random() * rect.height,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.16,
        size: minSize + Math.random() * (maxSize - minSize),
        alpha: Math.random(),
        da: (0.004 + Math.random() * 0.014) * (Math.random() < 0.5 ? -1 : 1),
      }));
    };

    const tick = () => {
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -2) p.x = rect.width + 2;
        if (p.x > rect.width + 2) p.x = -2;
        if (p.y < -2) p.y = rect.height + 2;
        if (p.y > rect.height + 2) p.y = -2;
        p.alpha += p.da;
        if (p.alpha <= 0.08 || p.alpha >= 1) p.da *= -1;
        ctx.globalAlpha = Math.min(Math.max(p.alpha, 0.08), 1);
        ctx.fillStyle = particleColor;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(tick);
    };

    resize();
    tick();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [particleColor, minSize, maxSize, particleDensity]);

  return <canvas ref={canvasRef} className={className} style={{ background }} />;
}
