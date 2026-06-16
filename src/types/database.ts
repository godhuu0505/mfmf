// DB スキーマに対応する型定義 (supabase/migrations/*.sql と同期)
// 将来 `supabase gen types typescript` で自動生成に置き換え可能。

// 記録元: 保育園 / おうち(両親)
export type RecordSource = "daycare" | "home";

export const RECORD_SOURCES: RecordSource[] = ["daycare", "home"];

export const SOURCE_LABEL: Record<RecordSource, string> = {
  daycare: "保育園",
  home: "おうち",
};

export function toSource(value: unknown): RecordSource {
  return value === "home" ? "home" : "daycare";
}

export type DaycareRecord = {
  id: string;
  owner_id: string;
  record_date: string; // YYYY-MM-DD
  source: RecordSource;
  author: string;
  weight_kg: number | null;
  body: string;
  created_at: string;
  updated_at: string;
};

export type RecordPhoto = {
  id: string;
  record_id: string;
  storage_path: string;
  created_at: string;
};

// 一覧表示用: 記録 + 先頭写真のサムネ
export type RecordWithPhotos = DaycareRecord & {
  record_photos: RecordPhoto[];
};

export const PHOTO_BUCKET = "daycare-photos";
