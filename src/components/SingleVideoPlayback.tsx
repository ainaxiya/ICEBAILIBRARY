"use client";

import { useEffect } from "react";

/**
 * 同页视频单播放互斥：任一 <video> 开始播放时，暂停其它正在播放的视频。
 * 挂载在详情页根部即可覆盖顶部画廊与各分段的视频（capture 阶段捕获不冒泡的 play 事件）。
 */
export default function SingleVideoPlayback() {
  useEffect(() => {
    const onPlay = (e: Event) => {
      const current = e.target as HTMLVideoElement | null;
      if (!current || current.tagName !== "VIDEO") return;
      document.querySelectorAll("video").forEach((v) => {
        if (v !== current && !v.paused) v.pause();
      });
    };
    document.addEventListener("play", onPlay, true);
    return () => document.removeEventListener("play", onPlay, true);
  }, []);
  return null;
}
