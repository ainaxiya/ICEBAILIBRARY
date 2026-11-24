"use client";

import { useEffect, useState } from "react";
import { MediaPlayer, MediaProvider } from "@vidstack/react";
import { DefaultVideoLayout, defaultLayoutIcons } from "@vidstack/react/player/layouts/default";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import "./site-video-player.css";

type Props = {
  src: string;
  poster?: string | null;
  title?: string;
  /** 播放器宽高比，默认 16:9；竖屏素材可传 "9 / 16" */
  aspectRatio?: string;
  className?: string;
};

/**
 * 全站统一视频播放器（Vidstack，本地打包，不走 CDN）。
 * - 站内小窗：点「小窗」把播放器固定到右下角，右上角显示单色 LOGO + icebai.com；
 *   浏览器原生画中画只渲染视频帧、DOM 叠层进不去，所以品牌角标用站内小窗实现。
 * - 原生画中画按钮隐藏，避免出两个口径。
 */
export default function SiteVideoPlayer({ src, poster, title, aspectRatio = "16 / 9", className = "" }: Props) {
  const [floating, setFloating] = useState(false);

  useEffect(() => {
    if (!floating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFloating(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [floating]);

  return (
    <div
      className={`svp-holder ${floating ? "is-floating" : ""} ${className}`}
      style={{ ["--svp-ratio" as string]: aspectRatio }}
    >
      <div className={floating ? "svp-float" : "svp-inner"}>
        <MediaPlayer
          src={src}
          poster={poster || undefined}
          title={title || "视频"}
          playsInline
          className="svp-player"
          style={{ aspectRatio }}
        >
          <MediaProvider />
          <DefaultVideoLayout icons={defaultLayoutIcons} noAudioGain />
        </MediaPlayer>

        {floating && (
          <div className="svp-watermark" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/site-assets/video-watermark-logo.png" alt="" />
            <span>icebai.com</span>
          </div>
        )}

        <button
          type="button"
          className="svp-toggle"
          aria-pressed={floating}
          onClick={() => setFloating((v) => !v)}
          title={floating ? "还原到页面（Esc）" : "小窗播放"}
        >
          {floating ? "还原" : "小窗"}
        </button>
      </div>
    </div>
  );
}
