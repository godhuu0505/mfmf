"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PHOTO_BUCKET, toSource } from "@/types/database";
import { isPathForRecord } from "@/lib/storagePath";

// フォームから記録メタデータ（記録元・記入者・体重）を取り出す。
function parseRecordFields(formData: FormData) {
  const record_date = String(formData.get("record_date") || "");
  const body = String(formData.get("body") || "");
  const source = toSource(formData.get("source"));
  const author = String(formData.get("author") || "").trim();

  const rawWeight = String(formData.get("weight_kg") || "").trim();
  const parsedWeight = rawWeight === "" ? null : Number(rawWeight);
  const weight_kg =
    parsedWeight !== null && Number.isFinite(parsedWeight) && parsedWeight > 0
      ? parsedWeight
      : null;

  return { record_date, body, source, author, weight_kg };
}

// pet_id を取り出し、本人所有のペットのみ受理する（横取り防止の防御）。
// 未指定・不正・他人のペットは null。
async function resolvePetId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ownerId: string,
  formData: FormData,
): Promise<string | null> {
  const petId = String(formData.get("pet_id") || "").trim();
  if (!UUID_RE.test(petId)) return null;

  const { data } = await supabase
    .from("pets")
    .select("id")
    .eq("id", petId)
    .eq("owner_id", ownerId)
    .maybeSingle();

  return data ? petId : null;
}

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
  // {owner_id}/{record_id}/... 配下のパスのみ受理（防御的サニタイズ）。
  const valid = paths.filter((p) => isPathForRecord(p, ownerId, recordId));
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
  const fields = parseRecordFields(formData);
  const pet_id = await resolvePetId(supabase, user.id, formData);

  const { error } = await supabase
    .from("daycare_records")
    .insert({ id: recordId, owner_id: user.id, ...fields, pet_id });

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

  const fields = parseRecordFields(formData);
  const pet_id = await resolvePetId(supabase, user.id, formData);

  const { error } = await supabase
    .from("daycare_records")
    .update({ ...fields, pet_id })
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
