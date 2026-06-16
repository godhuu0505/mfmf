"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PHOTO_BUCKET } from "@/types/database";
import { isOwnedStoragePath } from "@/lib/storagePath";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 写真はクライアントから Storage へ直接アップロード済み。
// ここではそのオブジェクトパスを record_photos に登録するだけ。
// Vercel の Function ボディ上限（4.5MB）を避けるため画像本体は受け取らない。
function readPhotoPaths(formData: FormData): string[] {
  return formData.getAll("photo_paths").map(String).filter(Boolean);
}

async function attachPhotoPaths(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ownerId: string,
  recordId: string,
  paths: string[],
) {
  // 本人フォルダ配下のパスのみ受理（防御的サニタイズ）。
  const valid = paths.filter((p) => isOwnedStoragePath(p, ownerId));
  if (valid.length === 0) return;

  const { error } = await supabase
    .from("record_photos")
    .insert(valid.map((storage_path) => ({ record_id: recordId, storage_path })));
  if (error) {
    throw new Error(`写真情報の保存に失敗しました: ${error.message}`);
  }
}

export async function createRecord(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // record_id はクライアント生成（Storage パス {owner_id}/{record_id}/... と一致させる）。
  const recordId = String(formData.get("record_id") || "");
  if (!UUID_RE.test(recordId)) {
    throw new Error("不正なリクエストです");
  }
  const record_date = String(formData.get("record_date") || "");
  const body = String(formData.get("body") || "");

  const { error } = await supabase
    .from("daycare_records")
    .insert({ id: recordId, owner_id: user.id, record_date, body });

  if (error) {
    throw new Error(`記録の作成に失敗しました: ${error.message}`);
  }

  await attachPhotoPaths(supabase, user.id, recordId, readPhotoPaths(formData));

  revalidatePath("/");
  redirect(`/records/${recordId}`);
}

export async function updateRecord(recordId: string, formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const record_date = String(formData.get("record_date") || "");
  const body = String(formData.get("body") || "");

  const { error } = await supabase
    .from("daycare_records")
    .update({ record_date, body })
    .eq("id", recordId);

  if (error) {
    throw new Error(`記録の更新に失敗しました: ${error.message}`);
  }

  await attachPhotoPaths(supabase, user.id, recordId, readPhotoPaths(formData));

  revalidatePath("/");
  revalidatePath(`/records/${recordId}`);
  redirect(`/records/${recordId}`);
}

export async function deletePhoto(photoId: string, recordId: string) {
  const supabase = await createClient();

  const { data: photo, error: fetchError } = await supabase
    .from("record_photos")
    .select("storage_path")
    .eq("id", photoId)
    .single();

  if (fetchError || !photo) {
    throw new Error(`写真が見つかりません: ${fetchError?.message}`);
  }

  // Storage オブジェクトを削除 (RLS でオーナーのみ削除可能)
  await supabase.storage.from(PHOTO_BUCKET).remove([photo.storage_path]);

  const { error } = await supabase
    .from("record_photos")
    .delete()
    .eq("id", photoId);

  if (error) {
    throw new Error(`写真の削除に失敗しました: ${error.message}`);
  }

  revalidatePath(`/records/${recordId}`);
}

export async function deleteRecord(recordId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // 紐づく Storage オブジェクトを先に削除 (DB 行は ON DELETE CASCADE)
  const { data: photos } = await supabase
    .from("record_photos")
    .select("storage_path")
    .eq("record_id", recordId);

  if (photos && photos.length > 0) {
    await supabase.storage
      .from(PHOTO_BUCKET)
      .remove(photos.map((p) => p.storage_path));
  }

  const { error } = await supabase
    .from("daycare_records")
    .delete()
    .eq("id", recordId);

  if (error) {
    throw new Error(`記録の削除に失敗しました: ${error.message}`);
  }

  revalidatePath("/");
  redirect("/");
}
