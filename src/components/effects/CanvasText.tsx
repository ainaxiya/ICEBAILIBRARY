"use client";
import { cn } from "@/lib/utils";
import React, { useCallback, useEffect, useRef, useState } from "react";

interface CanvasTextProps {
  text: string;
  className?: string;
  backgroundClassName?: string;
  colors?: string[];
  animationDuration?: number;
  lineWidth?: number;
  lineGap?: number;
  curveIntensity?: number;
  overlay?: boolean;
}

// 真实字体度量：宽度、墨迹高、字形上升/下降、行高、宿主可用宽
interface Metrics {
  textW: number;
  inkH: number;
  ascent: number;
  lineH: number;
  boxH: number;
  avail: number;
  fontSize: number;
  font: string;
}

const EMPTY_METRICS: Metrics = {
  textW: 0,
  inkH: 0,
  ascent: 0,
  lineH: 0,
  boxH: 0,
  avail: 0,
  fontSize: 0,
  font: "",
};

function resolveColor(color: string): string {
  if (color.startsWith("var(")) {
    const varName = color.slice(4, -1).trim();
    const resolved = getComputedStyle(document.documentElement)
      .getPropertyValue(varName)
      .trim();
    return resolved || color;
  }
  return color;
}

export function CanvasText({
  text,
  className = "",
  backgroundClassName = "bg-white dark:bg-neutral-950",
  colors = ["#ff6b6b", "#4ecdc4", "#45b7d1", "#96ceb4", "#ffeaa7", "#dfe6e9"],
  animationDuration = 5,
  lineWidth = 1.5,
  lineGap = 10,
  curveIntensity = 60,
  overlay = false,
}: CanvasTextProps) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<HTMLSpanElement>(null);
  const animationRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const [bgColor, setBgColor] = useState("#0a0a0a");
  const [resolvedColors, setResolvedColors] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);

  const updateColors = useCallback(() => {
    if (bgRef.current) {
      const computed = window.getComputedStyle(bgRef.current);
      setBgColor(computed.backgroundColor);
    }
    setResolvedColors(colors.map(resolveColor));
  }, [colors]);

  useEffect(() => {
    updateColors();

    const observer = new MutationObserver(updateColors);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, [updateColors]);

  // 用画布实测字体度量：不再依赖隐藏 span 的 DOM 行高，
  // 画布高度直接由字形 ascent+descent 决定，手机上任何字体度量都不会裁切。
  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;

    const measure = () => {
      const host = outer.parentElement;
      const cs = window.getComputedStyle(outer);
      const fontSize = parseFloat(cs.fontSize) || 16;
      const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const avail = host ? Math.max(0, Math.floor(host.clientWidth)) : 0;

      const probe = document.createElement("canvas").getContext("2d");
      let textW = 0;
      let ascent = fontSize * 0.88;
      let descent = fontSize * 0.22;
      if (probe) {
        probe.font = font;
        const m = probe.measureText(text);
        textW = m.width;
        const fbA = m.fontBoundingBoxAscent;
        const fbD = m.fontBoundingBoxDescent;
        // 浏览器墨迹度量异常（缺失或明显偏小）时回退到字体盒度量
        ascent =
          Number.isFinite(m.actualBoundingBoxAscent) && m.actualBoundingBoxAscent > fontSize * 0.5
            ? m.actualBoundingBoxAscent
            : Number.isFinite(fbA)
              ? fbA
              : fontSize * 0.88;
        descent =
          Number.isFinite(m.actualBoundingBoxDescent) && m.actualBoundingBoxDescent > fontSize * 0.08
            ? m.actualBoundingBoxDescent
            : Number.isFinite(fbD)
              ? fbD
              : fontSize * 0.22;
      }
      if (!textW) textW = fontSize * text.length;

      let lineH = parseFloat(cs.lineHeight);
      if (!Number.isFinite(lineH) || lineH <= 0) lineH = fontSize * 1.2;

      const inkH = Math.ceil(ascent + descent);
      // 上下各留至少 8px / 0.25em 的实测余量
      const gap = Math.max(8, Math.ceil(fontSize * 0.25));
      const boxH = Math.ceil(Math.max(inkH + gap * 2, lineH));

      setMetrics((prev) => {
        const next: Metrics = {
          textW: Math.ceil(textW),
          inkH,
          ascent,
          lineH,
          boxH,
          avail,
          fontSize,
          font,
        };
        const same =
          prev.textW === next.textW &&
          prev.inkH === next.inkH &&
          Math.abs(prev.ascent - next.ascent) < 0.5 &&
          prev.lineH === next.lineH &&
          prev.boxH === next.boxH &&
          prev.avail === next.avail &&
          prev.font === next.font;
        return same ? prev : next;
      });
    };

    measure();
    const host = outer.parentElement;
    const ro = new ResizeObserver(measure);
    if (host) ro.observe(host);
    window.addEventListener("resize", measure);
    if (document.fonts?.ready) document.fonts.ready.then(measure).catch(() => {});

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [text]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !metrics.textW || !metrics.font || resolvedColors.length === 0)
      return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const { textW, boxH, inkH, ascent, avail, font } = metrics;
    const dpr = window.devicePixelRatio || 1;
    // 超宽时等比缩小，画布与 CSS 尺寸同步缩放
    const ratio = !overlay && avail > 0 && textW > avail ? avail / textW : 1;

    canvas.width = Math.max(1, Math.ceil(textW * ratio * dpr));
    canvas.height = Math.max(1, Math.ceil(boxH * ratio * dpr));

    // 墨迹在 boxH 内垂直居中：上下余量由实测 ascent/descent 决定
    const baseline = (boxH - inkH) / 2 + ascent;
    const numLines = Math.floor(boxH / lineGap) + 10;
    startTimeRef.current = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = (currentTime - startTimeRef.current) / 1000;
      const phase = (elapsed / animationDuration) * Math.PI * 2;

      ctx.setTransform(dpr * ratio, 0, 0, dpr * ratio, 0, 0);
      ctx.clearRect(0, 0, textW, boxH);

      ctx.globalCompositeOperation = "source-over";
      ctx.font = font;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      ctx.fillStyle = "#000";
      ctx.fillText(text, 0, baseline);

      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, textW, boxH);

      ctx.globalCompositeOperation = "source-atop";
      for (let i = 0; i < numLines; i++) {
        const y = i * lineGap;

        const curve1 = Math.sin(phase) * curveIntensity;
        const curve2 = Math.sin(phase + 0.5) * curveIntensity * 0.6;

        const colorIndex = i % resolvedColors.length;
        ctx.strokeStyle = resolvedColors[colorIndex];
        ctx.lineWidth = lineWidth;

        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(
          textW * 0.33,
          y + curve1,
          textW * 0.66,
          y + curve2,
          textW,
          y,
        );
        ctx.stroke();
      }

      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [
    text,
    metrics,
    bgColor,
    resolvedColors,
    animationDuration,
    lineWidth,
    lineGap,
    curveIntensity,
    overlay,
  ]);

  const ratio =
    !overlay && metrics.avail > 0 && metrics.textW > metrics.avail
      ? metrics.avail / metrics.textW
      : 1;
  const boxW = Math.ceil(metrics.textW * ratio);
  const boxH = Math.ceil(metrics.boxH * ratio);
  // 画布比行盒高出的部分用负外边距抵消，页面排版高度保持不变
  const overhang = Math.max(0, Math.ceil(((metrics.boxH - metrics.lineH) * ratio) / 2));

  return (
    <span
      ref={outerRef}
      className={cn(
        overlay ? "absolute inset-0" : "relative block mx-auto",
        className,
      )}
      style={
        overlay
          ? undefined
          : {
              width: boxW || undefined,
              height: boxH || undefined,
              marginTop: overhang ? -overhang : undefined,
              marginBottom: overhang ? -overhang : undefined,
            }
      }
    >
      <span
        ref={bgRef}
        className={cn(
          "pointer-events-none absolute h-0 w-0 opacity-0",
          backgroundClassName,
        )}
        aria-hidden="true"
      />
      {/* 首帧（未测量完成）用不可见文本撑住布局，避免标题塌陷 */}
      {!metrics.textW && <span className="invisible">{text}</span>}
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute left-0 top-0"
        style={{ width: "100%", height: "100%" }}
        aria-label={text}
        role="img"
      />
    </span>
  );
}
