"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PHOTO_BUCKET, normalizeTagName, toSource } from "@/types/database";
import { isPathForRecord } from "@/lib/storagePath";
import {
  canEdit,
  getRoleInHousehold,
  householdScopeFilter,
  requireEditableHousehold,
} from "@/lib/household";

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

// pet_id を取り出し、正当に紐付けられるペットのみ受理する（横取り防止の防御）。
// 受理範囲: 本人所有のペット、または household を解決できた場合は同じ household のペット
// （共有記録が参照する同居メンバーのペットを取りこぼさないため）。RLS で見えるペットに限る。
// household 未解決時は従来どおり owner_id のみ。未指定・不正・対象外は null。
async function resolvePetId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ownerId: string,
  householdId: string | null,
  formData: FormData,
): Promise<string | null> {
  const petId = String(formData.get("pet_id") || "").trim();
  if (!UUID_RE.test(petId)) return null;

  let query = supabase.from("pets").select("id").eq("id", petId);
  query = householdId
    ? query.or(`owner_id.eq.${ownerId},household_id.eq.${householdId}`)
    : query.eq("owner_id", ownerId);
  const { data } = await query.maybeSingle();

  return data ? petId : null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 既存の記録に対する操作の権限検査: 記録が「属する世帯」でのロールを確認する
// （Cookie の「現在の世帯」とは独立。別タブで世帯を切り替えた後に古いフォームを
// 送信しても、対象の記録が別世帯へ移動したり誤った世帯で検証されたりしない）。
// 記録が見えている時点で呼び出しユーザーはその世帯のメンバー（読取は membership
// のみ）だが、role が viewer なら分かりやすいエラーで拒否する。一次防衛線は RLS。
async function requireEditableRecordHousehold(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  recordId: string,
): Promise<string> {
  const { data } = await supabase
    .from("daycare_records")
    .select("household_id")
    .eq("id", recordId)
    .maybeSingle();
  if (!data) {
    throw new Error("記録が見つかりません（または権限がありません）");
  }
  const role = await getRoleInHousehold(supabase, userId, data.household_id);
  if (role && !canEdit(role)) {
    throw new Error("閲覧のみの権限（viewer）のため、追加・編集・削除はできません");
  }
  return data.household_id;
}

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
  householdId: string | null,
) {
  // {household_id}/{record_id}/...（手順8 の新規約）または {owner_id}/{record_id}/...
  // （未所属時のフォールバック）配下のパスのみ受理（防御的サニタイズ）。
  // Storage 側もメンバーシップ RLS が同じ規約で強制する。
  const valid = paths.filter(
    (p) =>
      (householdId !== null && isPathForRecord(p, householdId, recordId)) ||
      isPathForRecord(p, ownerId, recordId),
  );
  if (valid.length === 0) return;

  // household_id は親 daycare_records から継承する（バックフィルの「親に追随」と同方針）。
  const { error } = await supabase
    .from("record_photos")
    .insert(
      valid.map((storage_path) => ({
        record_id: recordId,
        storage_path,
        household_id: householdId,
      })),
    );
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
// Phase 3.5 UC-M02: タグ辞書は世帯で共有する。household を解決できた場合は
// 「世帯の辞書（+ 移行期の自分の未所属タグ）」から名前を引き、同名タグの重複作成を
// 避けて世帯メンバーのタグを再利用する。作成時は household_id を付与する。
async function syncRecordTags(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ownerId: string,
  householdId: string | null,
  recordId: string,
  tagNames: string[],
) {
  // 望ましいタグ名の集合に対応する既存タグを引く（世帯辞書を優先）。
  // householdId があるときは、移行期に残った自分の未所属（household_id=null）タグを
  // 世帯辞書へ「昇格」させてから返す。null のままだと他メンバーはそのタグを解決できず、
  // 他メンバーの記録への付与も RLS（t.household_id = r.household_id）で弾かれるため。
  // 昇格対象は常に自分のタグに限られる（null タグは owner RLS 経由でしか見えない）。
  const selectTagsByName = async () => {
    let query = supabase.from("tags").select("id, name, household_id").in("name", tagNames);
    query = householdId
      ? query.or(householdScopeFilter(householdId))
      : query.eq("owner_id", ownerId);
    const { data, error } = await query;
    if (error) {
      throw new Error(`タグの取得に失敗しました: ${error.message}`);
    }
    let rows = data ?? [];

    const legacyIds = householdId
      ? rows.filter((t) => t.household_id === null).map((t) => t.id)
      : [];
    if (householdId && legacyIds.length > 0) {
      const { error: promoteError } = await supabase
        .from("tags")
        .update({ household_id: householdId })
        .in("id", legacyIds)
        .is("household_id", null);
      if (promoteError) {
        throw new Error(`タグの更新に失敗しました: ${promoteError.message}`);
      }
      rows = rows.map((t) =>
        t.household_id === null ? { ...t, household_id: householdId } : t,
      );
    }
    return rows;
  };

  // 1. 望ましいタグ名に対応する tag id を用意する（無ければ作成）。
  const tagIds: string[] = [];
  if (tagNames.length > 0) {
    const idByName = new Map<string, string>();
    // 同名が「世帯の共有タグ」と「移行期の未所属タグ」の両方にある場合は世帯側を優先。
    const fill = (rows: { id: string; name: string; household_id: string | null }[]) => {
      rows.forEach((t) => {
        if (!idByName.has(t.name) || t.household_id !== null) {
          idByName.set(t.name, t.id);
        }
      });
    };
    fill(await selectTagsByName());

    const missing = tagNames.filter((n) => !idByName.has(n));
    if (missing.length > 0) {
      const { data: inserted, error: insertError } = await supabase
        .from("tags")
        .insert(
          missing.map((name) => ({
            owner_id: ownerId,
            household_id: householdId,
            name,
          })),
        )
        .select("id, name, household_id");
      if (insertError) {
        // 一意制約違反（23505）は同名タグの同時作成との競合。作成済みを引き直して続行する。
        if (insertError.code === "23505") {
          fill(await selectTagsByName());
          if (tagNames.some((n) => !idByName.has(n))) {
            throw new Error(`タグの作成に失敗しました: ${insertError.message}`);
          }
        } else {
          throw new Error(`タグの作成に失敗しました: ${insertError.message}`);
        }
      }
      fill(inserted ?? []);
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

  // record_id はクライアント生成（Storage パス {scope_id}/{record_id}/... と一致させる）。
  const recordId = String(formData.get("record_id") || "");
  if (!UUID_RE.test(recordId)) {
    throw new Error("不正なリクエストです");
  }
  const fields = parseRecordFields(formData);
  // ロール検査（viewer は書き込み不可）+ 所属世帯の解決（一次防衛線は RLS）。
  const householdId = await requireEditableHousehold(supabase, user.id);
  const pet_id = await resolvePetId(supabase, user.id, householdId, formData);

  const { error } = await supabase
    .from("daycare_records")
    .insert({
      id: recordId,
      owner_id: user.id,
      household_id: householdId,
      ...fields,
      pet_id,
    });

  if (error) {
    throw new Error(`記録の作成に失敗しました: ${error.message}`);
  }

  await attachPhotoPaths(
    supabase,
    user.id,
    recordId,
    readPhotoPaths(formData),
    householdId,
  );
  await syncRecordTags(
    supabase,
    user.id,
    householdId,
    recordId,
    readTagNames(formData),
  );

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
  // 対象の記録が属する世帯で権限を検査し、以降の検証・タグ同期もその世帯で行う
  // （Cookie の現在世帯には依存しない = 記録が世帯間を移動することはない）。
  const householdId = await requireEditableRecordHousehold(
    supabase,
    user.id,
    recordId,
  );
  const pet_id = await resolvePetId(supabase, user.id, householdId, formData);

  const { error } = await supabase
    .from("daycare_records")
    .update({ ...fields, pet_id })
    .eq("id", recordId);

  if (error) {
    throw new Error(`記録の更新に失敗しました: ${error.message}`);
  }

  await attachPhotoPaths(
    supabase,
    user.id,
    recordId,
    readPhotoPaths(formData),
    householdId,
  );
  await syncRecordTags(
    supabase,
    user.id,
    householdId,
    recordId,
    readTagNames(formData),
  );

  revalidatePath("/");
  revalidatePath(`/records/${recordId}`);
  redirect(`/records/${recordId}`);
}

export async function deletePhoto(photoId: string, recordId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  await requireEditableRecordHousehold(supabase, user.id, recordId);

  const { data: photo, error: fetchError } = await supabase
    .from("record_photos")
    .select("storage_path")
    .eq("id", photoId)
    .single();

  if (fetchError || !photo) {
    throw new Error(`写真が見つかりません: ${fetchError?.message}`);
  }

  // Storage オブジェクトを削除 (RLS でオーナー / 世帯メンバーのみ削除可能)
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
  await requireEditableRecordHousehold(supabase, user.id, recordId);

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
