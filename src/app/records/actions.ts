"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PHOTO_BUCKET } from "@/types/database";

// ファイル名のサニタイズ + 衝突回避
function buildStoragePath(ownerId: string, recordId: string, fileName: string) {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${ownerId}/${recordId}/${crypto.randomUUID()}-${safe}`;
}

async function uploadPhotos(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ownerId: string,
  recordId: string,
  files: File[],
) {
  for (const file of files) {
    if (!file || file.size === 0) continue;
    const path = buildStoragePath(ownerId, recordId, file.name);
    const { error: uploadError } = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(path, file, { contentType: file.type, upsert: false });
    if (uploadError) {
      throw new Error(`写真のアップロードに失敗しました: ${uploadError.message}`);
    }
    const { error: insertError } = await supabase
      .from("record_photos")
      .insert({ record_id: recordId, storage_path: path });
    if (insertError) {
      throw new Error(`写真情報の保存に失敗しました: ${insertError.message}`);
    }
  }
}

export async function createRecord(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const record_date = String(formData.get("record_date") || "");
  const body = String(formData.get("body") || "");
  const files = formData.getAll("photos").filter((f): f is File => f instanceof File);

  const { data: record, error } = await supabase
    .from("daycare_records")
    .insert({ owner_id: user.id, record_date, body })
    .select("id")
    .single();

  if (error || !record) {
    throw new Error(`記録の作成に失敗しました: ${error?.message}`);
  }

  await uploadPhotos(supabase, user.id, record.id, files);

  revalidatePath("/");
  redirect(`/records/${record.id}`);
}

export async function updateRecord(recordId: string, formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const record_date = String(formData.get("record_date") || "");
  const body = String(formData.get("body") || "");
  const files = formData.getAll("photos").filter((f): f is File => f instanceof File);

  const { error } = await supabase
    .from("daycare_records")
    .update({ record_date, body })
    .eq("id", recordId);

  if (error) {
    throw new Error(`記録の更新に失敗しました: ${error.message}`);
  }

  await uploadPhotos(supabase, user.id, recordId, files);

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
