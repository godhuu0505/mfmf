"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";

export type GalleryImage = {
  id: string;
  url: string;
  /** 任意: ライトボックスのキャプション用 */
  recordId?: string;
  caption?: string;
};

type Props = {
  images: GalleryImage[];
  /** サムネのグリッド列数（Tailwind クラス） */
  gridClassName?: string;
};

// 写真サムネのグリッド + 拡大表示（ライトボックス）。
// スワイプ / 矢印キー / Esc / 背景クリックで操作できる。
// 署名付き URL は親から渡された値をそのまま表示するだけ（SW にはキャッシュしない方針を維持）。
export default function PhotoGallery({ images, gridClassName }: Props) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const touchStartX = useRef<number | null>(null);

  const close = useCallback(() => setOpenIndex(null), []);
  const show = useCallback(
    (i: number) => setOpenIndex(((i % images.length) + images.length) % images.length),
    [images.length],
  );
  const next = useCallback(() => {
    setOpenIndex((cur) =>
      cur === null ? cur : (cur + 1) % images.length,
    );
  }, [images.length]);
  const prev = useCallback(() => {
    setOpenIndex((cur) =>
      cur === null ? cur : (cur - 1 + images.length) % images.length,
    );
  }, [images.length]);

  // キーボード操作と背景スクロール抑止
  useEffect(() => {
    if (openIndex === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [openIndex, close, next, prev]);

  if (images.length === 0) return null;

  const current = openIndex !== null ? images[openIndex] : null;

  return (
    <>
      <div className={gridClassName ?? "grid grid-cols-2 gap-2 sm:grid-cols-3"}>
        {images.map((img, i) => (
          <button
            key={img.id}
            type="button"
            onClick={() => show(i)}
            className="relative aspect-square overflow-hidden rounded-xl bg-surface-muted transition hover:opacity-90"
            aria-label="写真を拡大表示"
          >
            <Image
              src={img.url}
              alt={img.caption ?? ""}
              fill
              sizes="(max-width:640px) 50vw, 200px"
              className="object-cover"
              unoptimized
            />
          </button>
        ))}
      </div>

      {current && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/90"
          role="dialog"
          aria-modal="true"
          onClick={close}
          onTouchStart={(e) => {
            touchStartX.current = e.touches[0]?.clientX ?? null;
          }}
          onTouchEnd={(e) => {
            const start = touchStartX.current;
            const end = e.changedTouches[0]?.clientX ?? null;
            touchStartX.current = null;
            if (start === null || end === null) return;
            const dx = end - start;
            if (Math.abs(dx) > 50) {
              if (dx < 0) next();
              else prev();
            }
          }}
        >
          <div className="flex items-center justify-between p-4 text-white">
            <span className="text-sm text-white/70">
              {openIndex! + 1} / {images.length}
            </span>
            <button
              type="button"
              onClick={close}
              className="rounded-full bg-surface/10 px-3 py-1 text-sm transition hover:bg-surface/20"
              aria-label="閉じる"
            >
              ✕ 閉じる
            </button>
          </div>

          <div
            className="relative flex flex-1 items-center justify-center px-2"
            onClick={(e) => e.stopPropagation()}
          >
            {images.length > 1 && (
              <button
                type="button"
                onClick={prev}
                className="absolute left-2 z-10 rounded-full bg-surface/10 p-3 text-2xl text-white transition hover:bg-surface/20"
                aria-label="前の写真"
              >
                ‹
              </button>
            )}
            <div className="relative h-full max-h-[80vh] w-full max-w-3xl">
              <Image
                src={current.url}
                alt={current.caption ?? ""}
                fill
                sizes="100vw"
                className="object-contain"
                unoptimized
              />
            </div>
            {images.length > 1 && (
              <button
                type="button"
                onClick={next}
                className="absolute right-2 z-10 rounded-full bg-surface/10 p-3 text-2xl text-white transition hover:bg-surface/20"
                aria-label="次の写真"
              >
                ›
              </button>
            )}
          </div>

          <div
            className="flex items-center justify-center gap-4 p-4 text-sm text-white/80"
            onClick={(e) => e.stopPropagation()}
          >
            {current.caption && <span>{current.caption}</span>}
            {current.recordId && (
              <Link
                href={`/records/${current.recordId}`}
                className="rounded-lg bg-surface/10 px-3 py-1 transition hover:bg-surface/20"
              >
                記録を見る →
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  );
}
