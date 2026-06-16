// DB スキーマに対応する型定義 (supabase/migrations/0001_init.sql と同期)
// 将来 `supabase gen types typescript` で自動生成に置き換え可能。

export type DaycareRecord = {
  id: string;
  owner_id: string;
  record_date: string; // YYYY-MM-DD
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
