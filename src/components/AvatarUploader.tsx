"use client";

import { useRef, useState, useTransition } from "react";
import Image from "next/image";
import { ImagePlus, UserRound } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { resizeImage } from "@/lib/imageResize";
import { buildAvatarPath } from "@/lib/storagePath";
import { AVATAR_BUCKET } from "@/types/database";

type Props = {
  /** アップロード先の scope（household_id または owner_id）。Storage パス先頭に入る。 */
  scopeId: string;
  /** 現在のアバターの署名付き URL（未設定は null）。 */
  currentUrl: string | null;
  /**
   * 保存用 Server Action（bind 済み）。FormData の `avatar_path` に
   * アップロード済みパス（削除時は空文字）を入れて呼ぶ。
   */
  action: (formData: FormData) => void | Promise<void>;
  /** 画像の代替テキスト（例: ペット名）。 */
  alt: string;
  /** 見出し（省略時は「アバター画像」）。 */
  label?: string;
  /** viewer 等・変更不可のとき true（画像は表示するが操作 UI を出さない）。 */
  disabled?: boolean;
  /** プレビューの一辺 px（既定 80）。 */
  size?: number;
};

// アバター画像を「ブラウザから直接 Storage へアップロード → パスだけを Server Action へ渡す」
// パターンで扱う共通部品（record 写真と同方針。Vercel の本体上限を避ける）。
// アバターは 1 枚・長辺 512px に縮小する。
export default function AvatarUploader({
  scopeId,
  currentUrl,
  action,
  alt,
  label = "アバター画像",
  disabled = false,
  size = 80,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const working = busy || isPending;

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    // 同じファイルを選び直せるよう input をクリアする。
    e.currentTarget.value = "";
    if (!file) return;
    setError(null);
    setBusy(true);

    const supabase = createClient();
    let uploadedPath: string | null = null;
    try {
      const resized = await resizeImage(file, { maxDimension: 512, quality: 0.85 });
      const path = buildAvatarPath(scopeId, resized.name);
      const { error: uploadError } = await supabase.storage
        .from(AVATAR_BUCKET)
        .upload(path, resized, { contentType: resized.type, upsert: false });
      if (uploadError) throw uploadError;
      uploadedPath = path;

      const fd = new FormData();
      fd.set("avatar_path", path);
      startTransition(async () => {
        await action(fd);
      });
    } catch (err) {
      // Server Action 前の失敗ならアップロード済みオブジェクトはオーファンになるため取り消す。
      if (uploadedPath) {
        await supabase.storage.from(AVATAR_BUCKET).remove([uploadedPath]).catch(() => {});
      }
      const message = err instanceof Error ? err.message : String(err);
      setError(`アバターの保存に失敗しました: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  function handleRemove() {
    setError(null);
    const fd = new FormData();
    fd.set("avatar_path", ""); // 空文字 = 削除
    startTransition(async () => {
      await action(fd);
    });
  }

  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-foreground">{label}</span>
      <div className="flex items-center gap-4">
        <div
          className="relative shrink-0 overflow-hidden rounded-full bg-surface-muted ring-1 ring-border"
          style={{ width: size, height: size }}
        >
          {currentUrl ? (
            <Image
              src={currentUrl}
              alt={alt}
              fill
              sizes={`${size}px`}
              unoptimized
              className="object-cover"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-muted-foreground">
              <UserRound className="h-1/2 w-1/2" aria-hidden="true" />
            </span>
          )}
        </div>

        {!disabled && (
          <div className="flex flex-col gap-1.5">
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              disabled={working}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={working}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-surface-muted disabled:opacity-60"
            >
              <ImagePlus className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {working ? "保存中…" : currentUrl ? "画像を変更" : "画像を選ぶ"}
            </button>
            {currentUrl && (
              <button
                type="button"
                onClick={handleRemove}
                disabled={working}
                className="text-left text-xs text-red-600 transition hover:text-red-800 disabled:opacity-60"
              >
                画像を削除
              </button>
            )}
            <p className="text-xs text-muted-foreground">
              長辺 512px に縮小して保存します。
            </p>
          </div>
        )}
      </div>
      {error && (
        <p className="mt-1.5 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
