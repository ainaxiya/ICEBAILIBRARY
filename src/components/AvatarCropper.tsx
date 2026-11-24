"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ─── 自研头像裁剪（替代 react-photo-editor）───
// 正方形取景框 / 拖拽平移（1.5 倍速）/ 滚轮 + 双指捏合缩放 / 大图自动按 cover 适配；
// 打开期间给 body 打 data-crop-open 标记，会员中心抽屉手势据此屏蔽，避免裁剪拖动误触菜单。

const OUT = 512; // 输出尺寸
const SPEED = 1.5; // 拖拽位移倍速
const MIN_SCALE = 1;
const MAX_SCALE = 8;

type PointerPos = { x: number; y: number };

export default function AvatarCropper({
  file,
  onCancel,
  onSaved,
}: {
  file: File;
  onCancel: () => void;
  onSaved: (blob: Blob) => void;
}) {
  const viewRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const urlRef = useRef<string>("");
  const stateRef = useRef({ scale: 1, tx: 0, ty: 0 }); // scale 相对 cover 基准；tx/ty 为图片中心相对取景框中心的偏移
  const pointers = useRef<Map<number, PointerPos>>(new Map());
  const dragRef = useRef<PointerPos | null>(null);
  const pinchRef = useRef<{ dist: number } | null>(null);
  const [url, setUrl] = useState("");
  const [baseK, setBaseK] = useState(0); // cover 基准：1 个 CSS 像素对应的原图像素比例
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // 打开期间标记 body，抽屉手势据此屏蔽
  useEffect(() => {
    document.body.dataset.cropOpen = "1";
    return () => {
      delete document.body.dataset.cropOpen;
    };
  }, []);

  // 文件 → ObjectURL
  useEffect(() => {
    const u = URL.createObjectURL(file);
    urlRef.current = u;
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const clamp = useCallback((s: number, x: number, y: number) => {
    const view = viewRef.current;
    const img = imgRef.current;
    if (!view || !img) return { scale: s, tx: x, ty: y };
    const V = view.clientWidth;
    const k0 = Math.max(V / img.naturalWidth, V / img.naturalHeight);
    const scale2 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
    const W = img.naturalWidth * k0 * scale2;
    const H = img.naturalHeight * k0 * scale2;
    const mx = Math.max(0, (W - V) / 2);
    const my = Math.max(0, (H - V) / 2);
    return {
      scale: scale2,
      tx: Math.min(mx, Math.max(-mx, x)),
      ty: Math.min(my, Math.max(-my, y)),
    };
  }, []);

  const apply = useCallback(
    (s: number, x: number, y: number) => {
      const next = clamp(s, x, y);
      stateRef.current = next;
      setScale(next.scale);
      setTx(next.tx);
      setTy(next.ty);
    },
    [clamp]
  );

  const zoomAt = (factor: number) => {
    const { scale: s } = stateRef.current;
    apply(s * factor, stateRef.current.tx, stateRef.current.ty);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    viewRef.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) dragRef.current = { x: e.clientX, y: e.clientY };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
      dragRef.current = null;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const { scale: s, tx: x, ty: y } = stateRef.current;

    if (pointers.current.size === 1 && dragRef.current) {
      const dx = (e.clientX - dragRef.current.x) * SPEED;
      const dy = (e.clientY - dragRef.current.y) * SPEED;
      dragRef.current = { x: e.clientX, y: e.clientY };
      apply(s, x + dx, y + dy);
      return;
    }

    if (pointers.current.size === 2 && pinchRef.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const ratio = dist / (pinchRef.current.dist || dist || 1);
      pinchRef.current = { dist };
      apply(s * ratio, x, y);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchRef.current = null;
    if (pointers.current.size === 1) {
      const [p] = [...pointers.current.values()];
      dragRef.current = { x: p.x, y: p.y };
    } else if (pointers.current.size === 0) {
      dragRef.current = null;
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY * 0.002));
  };

  const doSave = async () => {
    const view = viewRef.current;
    const img = imgRef.current;
    if (!view || !img || saving) return;
    setSaving(true);
    setErr("");
    try {
      const V = view.clientWidth;
      const k0 = Math.max(V / img.naturalWidth, V / img.naturalHeight);
      const { scale: s, tx: x, ty: y } = stateRef.current;
      const k = k0 * s;
      const W = img.naturalWidth * k;
      const H = img.naturalHeight * k;
      // 取景框左上角在显示图内的坐标 = 图左上角到框左上角的距离（正向取值）
      // 图左上角位于 (V/2 + tx - W/2, V/2 + ty - H/2)，框左上角为 (0,0)
      const srcW = V / k;
      const sx = Math.min(Math.max(0, (W / 2 - V / 2 - x) / k), img.naturalWidth - srcW);
      const sy = Math.min(Math.max(0, (H / 2 - V / 2 - y) / k), img.naturalHeight - srcW);
      const canvas = document.createElement("canvas");
      canvas.width = OUT;
      canvas.height = OUT;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas");
      ctx.drawImage(img, sx, sy, srcW, srcW, 0, 0, OUT, OUT);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", 0.9));
      if (!blob) throw new Error("blob");
      onSaved(blob);
    } catch {
      setErr("生成头像失败，请重试");
      setSaving(false);
    }
  };

  const imgLoaded = (e: React.SyntheticEvent<HTMLImageElement>) => {
    imgRef.current = e.currentTarget;
    const view = viewRef.current;
    if (view) {
      const V = view.clientWidth || 1;
      setBaseK(Math.max(V / e.currentTarget.naturalWidth, V / e.currentTarget.naturalHeight));
    }
    // 初始按 cover 铺满（大图自动缩到取景框内）
    apply(1, 0, 0);
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 p-4"
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
    >
      <div className="flex w-full max-w-[26rem] flex-col items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
        <p className="text-sm font-medium text-zinc-200">调整头像</p>
        <p className="-mt-3 text-xs text-zinc-500">拖动移动 · 双指捏合或滚轮缩放</p>

        <div
          ref={viewRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          className="relative aspect-square w-[min(86vw,21rem)] cursor-move touch-none select-none overflow-hidden rounded-2xl bg-zinc-900 ring-1 ring-zinc-700"
        >
          {url && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={url}
              alt="头像裁剪预览"
              draggable={false}
              onLoad={imgLoaded}
              className="pointer-events-none absolute left-1/2 top-1/2 max-w-none"
              style={{ transform: `translate(-50%, -50%) translate(${tx}px, ${ty}px) scale(${(baseK || 1) * scale})` }}
            />
          )}
          <span className="pointer-events-none absolute inset-3 rounded-xl border border-dashed border-white/20" />
        </div>

        {err && <p className="text-xs text-rose-400">{err}</p>}

        <div className="flex w-full items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => zoomAt(1 / 1.25)}
            aria-label="缩小"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-zinc-700 text-lg text-zinc-300 hover:border-emerald-500 hover:text-emerald-300"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => zoomAt(1.25)}
            aria-label="放大"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-zinc-700 text-lg text-zinc-300 hover:border-emerald-500 hover:text-emerald-300"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => apply(1, 0, 0)}
            className="h-10 rounded-full border border-zinc-700 px-4 text-sm text-zinc-300 hover:border-zinc-500 hover:text-zinc-200"
          >
            重置
          </button>
        </div>

        <div className="flex w-full gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-11 flex-1 rounded-xl border border-zinc-700 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={doSave}
            disabled={saving}
            className="h-11 flex-1 rounded-xl bg-emerald-500 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            {saving ? "处理中…" : "保存头像"}
          </button>
        </div>
      </div>
    </div>
  );
}
