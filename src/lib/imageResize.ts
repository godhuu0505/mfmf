// アップロード前にブラウザ側で画像を縮小・再圧縮するユーティリティ。
// Storage 使用量と通信量を抑え、表示も軽くする。

export type ResizeOptions = {
  /** 長辺の最大ピクセル数 */
  maxDimension?: number;
  /** 出力品質 0..1 */
  quality?: number;
  /** 出力 MIME タイプ */
  mimeType?: string;
};

const DEFAULTS: Required<ResizeOptions> = {
  maxDimension: 1600,
  quality: 0.8,
  mimeType: "image/jpeg",
};

function replaceExtension(name: string, mimeType: string): string {
  const ext = mimeType === "image/webp" ? "webp" : "jpg";
  const base = name.replace(/\.[^./\\]+$/, "");
  return `${base}.${ext}`;
}

// 1枚をリサイズ・圧縮して新しい File を返す。
// 画像でない / デコード不可 / 圧縮で大きくなる場合は元の File をそのまま返す。
export async function resizeImage(
  file: File,
  options: ResizeOptions = {},
): Promise<File> {
  const { maxDimension, quality, mimeType } = { ...DEFAULTS, ...options };

  // 画像以外、または再エンコードで劣化・破綻するものはスキップ
  if (!file.type.startsWith("image/")) return file;
  if (file.type === "image/gif" || file.type === "image/svg+xml") return file;
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
    return file;
  }

  // EXIF の向きを反映してデコード
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  }).catch(() => null);
  if (!bitmap) return file;

  try {
    const { width, height } = bitmap;
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mimeType, quality),
    );
    if (!blob) return file;

    // 縮小しておらず、かつ圧縮後の方が大きいなら元を採用
    if (scale === 1 && blob.size >= file.size) return file;

    return new File([blob], replaceExtension(file.name, mimeType), {
      type: mimeType,
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close?.();
  }
}

// 複数枚をまとめて処理する。
export async function resizeImages(
  files: File[],
  options?: ResizeOptions,
): Promise<File[]> {
  const out: File[] = [];
  for (const f of files) {
    out.push(await resizeImage(f, options));
  }
  return out;
}
