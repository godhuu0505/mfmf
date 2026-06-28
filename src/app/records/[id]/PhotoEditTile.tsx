"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import { deletePhoto } from "@/app/records/actions";

// 編集画面の写真サムネ。削除ボタン押下で即時に非表示にし、
// 裏で Server Action を呼ぶ。失敗したら復元。
export default function PhotoEditTile({
  id,
  recordId,
  url,
}: {
  id: string;
  recordId: string;
  url: string | null;
}) {
  const [removed, setRemoved] = useState(false);
  const [pending, startTransition] = useTransition();

  if (removed && !pending) return null;

  return (
    <div
      className={
        "group relative aspect-square overflow-hidden rounded-xl bg-surface-muted transition-opacity " +
        (removed || pending ? "opacity-40" : "")
      }
    >
      {url && (
        <Image
          src={url}
          alt=""
          fill
          sizes="(max-width:640px) 33vw, 200px"
          className="object-cover"
          unoptimized
        />
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setRemoved(true);
          startTransition(async () => {
            try {
              await deletePhoto(id, recordId);
            } catch (e) {
              setRemoved(false);
              alert(
                e instanceof Error ? e.message : "写真の削除に失敗しました",
              );
            }
          });
        }}
        className="absolute right-1 top-1 rounded-full bg-black/60 px-2 py-1 text-xs text-white transition hover:bg-black/80 disabled:opacity-60"
        aria-label="この写真を削除"
      >
        削除
      </button>
    </div>
  );
}
