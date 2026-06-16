"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PHOTO_BUCKET, normalizeTagName, toSource } from "@/types/database";
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

// フォームの hidden 入力 `tag_names`（複数）からタグ名を取り出して正規化する。
// 前後空白を除去し、空・重複を除き、大小無視で一意化する。
function readTagNames(formData: FormData): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of formData.getAll("tag_names")) {
    const name = normalizeTagName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

// 記録に付与するタグを、与えられたタグ名の集合に一致するよう同期する。
// 既存タグは再利用し、未登録のタグ名は tags に作成してから record_tags を貼り直す。
async function syncRecordTags(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ownerId: string,
  recordId: string,
  tagNames: string[],
) {
  // 1. 望ましいタグ名に対応する tag id を用意する（無ければ作成）。
  const tagIds: string[] = [];
  if (tagNames.length > 0) {
    const { data: existing, error: selectError } = await supabase
      .from("tags")
      .select("id, name")
      .eq("owner_id", ownerId)
      .in("name", tagNames);
    if (selectError) {
      throw new Error(`タグの取得に失敗しました: ${selectError.message}`);
    }

    const idByName = new Map<string, string>();
    (existing ?? []).forEach((t) => idByName.set(t.name, t.id));

    const missing = tagNames.filter((n) => !idByName.has(n));
    if (missing.length > 0) {
      const { data: inserted, error: insertError } = await supabase
        .from("tags")
        .insert(missing.map((name) => ({ owner_id: ownerId, name })))
        .select("id, name");
      if (insertError) {
        throw new Error(`タグの作成に失敗しました: ${insertError.message}`);
      }
      (inserted ?? []).forEach((t) => idByName.set(t.name, t.id));
    }

    tagNames.forEach((n) => {
      const id = idByName.get(n);
      if (id) tagIds.push(id);
    });
  }

  // 2. record_tags を望ましい集合に合わせる（不要分を削除し、新規分を追加）。
  if (tagIds.length === 0) {
    const { error } = await supabase
      .from("record_tags")
      .delete()
      .eq("record_id", recordId);
    if (error) {
      throw new Error(`タグの更新に失敗しました: ${error.message}`);
    }
    return;
  }

  const { error: deleteError } = await supabase
    .from("record_tags")
    .delete()
    .eq("record_id", recordId)
    .not("tag_id", "in", `(${tagIds.join(",")})`);
  if (deleteError) {
    throw new Error(`タグの更新に失敗しました: ${deleteError.message}`);
  }

  const { error: upsertError } = await supabase
    .from("record_tags")
    .upsert(
      tagIds.map((tag_id) => ({ record_id: recordId, tag_id, owner_id: ownerId })),
      { onConflict: "record_id,tag_id", ignoreDuplicates: true },
    );
  if (upsertError) {
    throw new Error(`タグの付与に失敗しました: ${upsertError.message}`);
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

  const { error } = await supabase
    .from("daycare_records")
    .insert({ id: recordId, owner_id: user.id, ...fields });

  if (error) {
    throw new Error(`記録の作成に失敗しました: ${error.message}`);
  }

  await attachPhotoPaths(supabase, user.id, recordId, readPhotoPaths(formData));
  await syncRecordTags(supabase, user.id, recordId, readTagNames(formData));

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

  const { error } = await supabase
    .from("daycare_records")
    .update(fields)
    .eq("id", recordId);

  if (error) {
    throw new Error(`記録の更新に失敗しました: ${error.message}`);
  }

  await attachPhotoPaths(supabase, user.id, recordId, readPhotoPaths(formData));
  await syncRecordTags(supabase, user.id, recordId, readTagNames(formData));

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
