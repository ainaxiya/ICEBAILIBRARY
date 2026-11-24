"use client";

import { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import SiteVideoPlayer from "./SiteVideoPlayer";

/**
 * 富文本（作品详情）里的 <video> 由 sanitize-html 直接输出，React 无法在 HTML 字符串里插入组件。
 * 这里在挂载后把 .rich-content 内的原生 video 就地替换为统一播放器；卸载时还原，避免路由切换残留。
 */
export default function RichVideoEnhancer() {
  useEffect(() => {
    const videos = Array.from(document.querySelectorAll<HTMLVideoElement>(".rich-content video"));
    const entries: { root: Root; wrapper: HTMLDivElement; video: HTMLVideoElement; display: string }[] = [];

    for (const video of videos) {
      const src = video.currentSrc || video.src;
      if (!src) continue;

      const wrapper = document.createElement("div");
      wrapper.className = "rich-video-unified";
      const display = video.style.display;
      video.style.display = "none";
      video.after(wrapper);

      const root = createRoot(wrapper);
      root.render(
        <SiteVideoPlayer src={src} poster={video.poster || undefined} title={video.title || undefined} />
      );
      entries.push({ root, wrapper, video, display });
    }

    return () => {
      for (const e of entries) {
        e.root.unmount();
        e.wrapper.remove();
        e.video.style.display = e.display;
      }
    };
  }, []);

  return null;
}
