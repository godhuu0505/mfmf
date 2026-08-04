"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canEdit, getRoleInHousehold, requireEditableHousehold } from "@/lib/household";
import { AVATAR_BUCKET } from "@/types/database";
import { isAvatarPathForScope } from "@/lib/storagePath";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

function parsePetFields(formData: FormData) {
  const name = String(formData.get("name") || "").trim();
  const speciesRaw = String(formData.get("species") || "").trim();
  const birthdayRaw = String(formData.get("birthday") || "").trim();
  return {
    name,
    species: speciesRaw === "" ? null : speciesRaw,
    birthday: birthdayRaw === "" ? null : birthdayRaw,
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 既存ペットへの操作は「ペットが属する世帯」でロールを検査する（Cookie の現在世帯には
// 依存しない = 別タブで世帯を切り替えた後の古いフォーム送信でも対象がすり替わらない）。
async function requireEditablePetHousehold(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  userId: string,
  petId: string,
) {
  const { data } = await supabase
    .from("pets")
    .select("household_id")
    .eq("id", petId)
    .maybeSingle();
  if (!data) {
    throw new Error("ペットが見つかりません（または権限がありません）");
  }
  const role = await getRoleInHousehold(supabase, userId, data.household_id);
  if (role && !canEdit(role)) {
    throw new Error("閲覧のみの権限（viewer）のため、追加・編集・削除はできません");
  }
}

export async function createPet(formData: FormData) {
  const { supabase, user } = await requireUser();
  const fields = parsePetFields(formData);
  if (fields.name === "") {
    throw new Error("ペットの名前を入力してください");
  }

  // 追加先の世帯は「フォームを描画した世帯」（hidden で送信）を優先して検証する。
  // hidden が無い場合のみ現在世帯を解決（一次防衛線は RLS）。
  const formHousehold = String(formData.get("household_id") || "").trim();
  let householdId: string | null;
  if (UUID_RE.test(formHousehold)) {
    const role = await getRoleInHousehold(supabase, user.id, formHousehold);
    if (!role) throw new Error("この世帯のメンバーではありません");
    if (!canEdit(role)) {
      throw new Error("閲覧のみの権限（viewer）のため、追加・編集・削除はできません");
    }
    householdId = formHousehold;
  } else {
    householdId = await requireEditableHousehold(supabase, user.id);
  }

  const { error } = await supabase
    .from("pets")
    .insert({ owner_id: user.id, household_id: householdId, ...fields });
  if (error) {
    throw new Error(`ペットの追加に失敗しました: ${error.message}`);
  }

  revalidatePath("/pets");
  revalidatePath("/");
}

export async function updatePet(petId: string, formData: FormData) {
  const { supabase, user } = await requireUser();
  await requireEditablePetHousehold(supabase, user.id, petId);
  const fields = parsePetFields(formData);
  if (fields.name === "") {
    throw new Error("ペットの名前を入力してください");
  }

  // RLS (owner_id = auth.uid()) により自分のペットのみ更新できる。
  const { error } = await supabase.from("pets").update(fields).eq("id", petId);
  if (error) {
    throw new Error(`ペットの更新に失敗しました: ${error.message}`);
  }

  revalidatePath("/pets");
  revalidatePath("/");
}

// ペットのアバター画像を設定 / 変更 / 削除する（editor 以上 / 世帯で共有）。
// 画像本体はクライアントが avatars バケットへ直接アップロード済みで、ここには
// そのオブジェクトパス（削除時は空文字）だけが渡る（record 写真と同方針）。
export async function updatePetAvatar(petId: string, formData: FormData) {
  const { supabase, user } = await requireUser();

  // 対象ペットの世帯・現在のアバターを取得（ロール検査は「ペットの世帯」基準）。
  const { data: pet } = await supabase
    .from("pets")
    .select("household_id, avatar_path")
    .eq("id", petId)
    .maybeSingle();
  if (!pet) {
    throw new Error("ペットが見つかりません（または権限がありません）");
  }
  const role = await getRoleInHousehold(supabase, user.id, pet.household_id);
  if (role && !canEdit(role)) {
    throw new Error("閲覧のみの権限（viewer）のため、追加・編集・削除はできません");
  }

  const newPath = String(formData.get("avatar_path") || "").trim();
  // 空文字 = 削除。新規パスは「ペットの世帯」配下のものだけ受け付ける（越境防止・RLS が最終防衛）。
  if (newPath !== "" && !isAvatarPathForScope(newPath, pet.household_id)) {
    throw new Error("不正なアバターパスです");
  }

  const { error } = await supabase
    .from("pets")
    .update({ avatar_path: newPath === "" ? null : newPath })
    .eq("id", petId);
  if (error) {
    throw new Error(`アバターの保存に失敗しました: ${error.message}`);
  }

  // 差し替え / 削除で不要になった旧オブジェクトを片付ける（オーファン防止・失敗は無視）。
  const oldPath = pet.avatar_path;
  if (oldPath && oldPath !== newPath) {
    await supabase.storage.from(AVATAR_BUCKET).remove([oldPath]).catch(() => {});
  }

  revalidatePath("/pets");
  revalidatePath("/");
}

export async function deletePet(petId: string) {
  const { supabase, user } = await requireUser();
  await requireEditablePetHousehold(supabase, user.id, petId);
  // 記録の pet_id は ON DELETE SET NULL のため、削除しても記録自体は残る。
  const { error } = await supabase.from("pets").delete().eq("id", petId);
  if (error) {
    throw new Error(`ペットの削除に失敗しました: ${error.message}`);
  }

  revalidatePath("/pets");
  revalidatePath("/");
}
