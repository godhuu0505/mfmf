"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import { getRoleInHousehold, HOUSEHOLD_COOKIE } from "@/lib/household";
import { AVATAR_BUCKET, GUEST_ROLES, type GuestRole } from "@/types/database";
import { isAvatarPathForScope } from "@/lib/storagePath";

export type SettingsResult = {
  ok: boolean;
  message: string;
};

// 表示名・既定の記入者を保存する（profiles に upsert）。
export async function updateProfile(
  _prev: SettingsResult | null,
  formData: FormData,
): Promise<SettingsResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const displayNameRaw = String(formData.get("display_name") || "").trim();
  const defaultAuthorRaw = String(formData.get("default_author") || "").trim();

  const { error } = await supabase.from("profiles").upsert(
    {
      owner_id: user.id,
      display_name: displayNameRaw === "" ? null : displayNameRaw,
      default_author: defaultAuthorRaw === "" ? null : defaultAuthorRaw,
    },
    { onConflict: "owner_id" },
  );

  if (error) {
    return { ok: false, message: `保存できませんでした: ${error.message}` };
  }

  revalidatePath("/settings");
  revalidatePath("/settings/account");
  revalidatePath("/records/new");
  return { ok: true, message: "プロフィールを保存しました。" };
}

// ユーザー（自分）のアバター画像を設定 / 変更 / 削除する（個人スコープ・profiles）。
// 画像本体はクライアントが avatars バケットへ直接アップロード済みで、ここには
// そのオブジェクトパス（削除時は空文字）だけが渡る。scope は自分の uid。
export async function updateUserAvatar(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const newPath = String(formData.get("avatar_path") || "").trim();
  // 新規パスは自分の uid 配下のものだけ受け付ける（越境防止・RLS が最終防衛）。
  if (newPath !== "" && !isAvatarPathForScope(newPath, user.id)) {
    throw new Error("不正なアバターパスです");
  }

  const { data: current } = await supabase
    .from("profiles")
    .select("avatar_path")
    .eq("owner_id", user.id)
    .maybeSingle();

  // profiles 行が無いユーザーもいるため upsert。avatar_path 以外の列は
  // 既存行では温存され（提供列のみ更新）、新規行では既定 null になる。
  const { error } = await supabase.from("profiles").upsert(
    { owner_id: user.id, avatar_path: newPath === "" ? null : newPath },
    { onConflict: "owner_id" },
  );
  if (error) {
    throw new Error(`アバターの保存に失敗しました: ${error.message}`);
  }

  const oldPath = current?.avatar_path;
  if (oldPath && oldPath !== newPath) {
    await supabase.storage.from(AVATAR_BUCKET).remove([oldPath]).catch(() => {});
  }

  revalidatePath("/settings/account");
  revalidatePath("/settings");
}

// パスワードを変更する。確認入力との一致と最小文字数を検証する。
export async function changePassword(
  _prev: SettingsResult | null,
  formData: FormData,
): Promise<SettingsResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const password = String(formData.get("password") || "");
  const confirm = String(formData.get("password_confirm") || "");

  if (password.length < 8) {
    return {
      ok: false,
      message: "新しいパスワードは 8 文字以上で入力してください。",
    };
  }
  if (password !== confirm) {
    return {
      ok: false,
      message: "確認用パスワードが一致しません。もう一度入力してください。",
    };
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return {
      ok: false,
      message: `パスワードを変更できませんでした: ${error.message}`,
    };
  }

  return { ok: true, message: "パスワードを変更しました。" };
}

// ---------------------------------------------------------------
// 世帯（household）管理 — Phase 3.5 S2 (#46)
// 一次防衛線は RLS（households_update_owner / household_members_update_owner）と
// D6 トリガ（最後の owner の降格不可）。ここでは getUser + owner 検査で
// 分かりやすいエラーを返す（クライアント回避不可の強制は DB 側）。
// ---------------------------------------------------------------

// 対象世帯（= 画面を描画した世帯。Cookie の現在世帯ではない）での owner を要求する
// 共通検査。別タブで世帯を切り替えた後に古いフォームを送信しても、操作は必ず
// フォームの世帯に対して検証・適用される。一次防衛線は RLS。
async function requireOwnerOf(householdId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const role = await getRoleInHousehold(supabase, user.id, householdId);
  if (role !== "owner") {
    throw new Error("この操作は対象の世帯の owner のみ行えます");
  }
  return { supabase, user };
}

// 世帯名を変更する（owner のみ / UC-H02）。householdId は画面を描画した世帯。
export async function renameHousehold(householdId: string, formData: FormData) {
  const { supabase } = await requireOwnerOf(householdId);

  const name = String(formData.get("household_name") || "").trim().slice(0, 100);
  const { error } = await supabase
    .from("households")
    .update({ name })
    .eq("id", householdId);
  if (error) {
    throw new Error(`世帯名の変更に失敗しました: ${error.message}`);
  }

  revalidatePath("/settings");
}

// 世帯のアバター画像を設定 / 変更 / 削除する（owner のみ / 世帯名と同じ扱い）。
// 画像本体はクライアントが avatars バケットへ直接アップロード済みで、ここには
// そのオブジェクトパス（削除時は空文字）だけが渡る。
export async function updateHouseholdAvatar(
  householdId: string,
  formData: FormData,
) {
  const { supabase } = await requireOwnerOf(householdId);

  const newPath = String(formData.get("avatar_path") || "").trim();
  // 新規パスは当該世帯配下のものだけ受け付ける（越境防止・RLS が最終防衛）。
  if (newPath !== "" && !isAvatarPathForScope(newPath, householdId)) {
    throw new Error("不正なアバターパスです");
  }

  const { data: current } = await supabase
    .from("households")
    .select("avatar_path")
    .eq("id", householdId)
    .maybeSingle();

  const { error } = await supabase
    .from("households")
    .update({ avatar_path: newPath === "" ? null : newPath })
    .eq("id", householdId);
  if (error) {
    throw new Error(`アバターの保存に失敗しました: ${error.message}`);
  }

  const oldPath = current?.avatar_path;
  if (oldPath && oldPath !== newPath) {
    await supabase.storage.from(AVATAR_BUCKET).remove([oldPath]).catch(() => {});
  }

  revalidatePath("/settings");
}

// メンバーのロールを変更する（owner のみ / UC-H04。最後の owner の降格は D6 が拒否）。
export async function updateMemberRole(
  householdId: string,
  memberUserId: string,
  formData: FormData,
) {
  const { supabase } = await requireOwnerOf(householdId);

  const role = String(formData.get("role") || "");
  if (!["owner", "editor", "viewer"].includes(role)) {
    throw new Error("不正なロールです");
  }

  const { error } = await supabase
    .from("household_members")
    .update({ role })
    .eq("household_id", householdId)
    .eq("user_id", memberUserId);
  if (error) {
    // D6 トリガ（最後の owner の降格不可）のメッセージをそのまま届ける。
    throw new Error(`ロールの変更に失敗しました: ${error.message}`);
  }

  revalidatePath("/settings");
}

// 招待を発行する（owner のみ / UC-O09。宛先メール固定 D12・期限 7 日）。
// 強制は RLS（invites_insert_owner）。リンクは /invite/{token} を owner が本人へ共有する。
export async function createInvite(householdId: string, formData: FormData) {
  const { supabase, user } = await requireOwnerOf(householdId);

  const email = String(formData.get("invite_email") || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("宛先メールアドレスを正しく入力してください");
  }
  const role = String(formData.get("invite_role") || "");
  if (!["editor", "viewer"].includes(role)) {
    throw new Error("不正なロールです（招待できるのは editor / viewer のみ）");
  }

  // 推測不能なトークン（URL セーフ）。一意制約が衝突を最終防衛する。
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase.from("household_invites").insert({
    household_id: householdId,
    email,
    role,
    token,
    invited_by: user.id,
    expires_at: expiresAt,
  });
  if (error) {
    throw new Error(`招待の発行に失敗しました: ${error.message}`);
  }

  revalidatePath("/settings");
}

// ゲスト招待を発行する（owner のみ / UC-G01。対象ペット・期間つき、宛先メール固定 D12）。
// 受諾でメンバーではなく guest_grants が作られる（accept_household_invite が分岐）。
export async function createGuestInvite(householdId: string, formData: FormData) {
  const { supabase, user } = await requireOwnerOf(householdId);

  const email = String(formData.get("guest_email") || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("宛先メールアドレスを正しく入力してください");
  }
  const role = String(formData.get("guest_role") || "");
  if (!GUEST_ROLES.includes(role as GuestRole)) {
    throw new Error("不正なゲスト種別です");
  }
  const petId = String(formData.get("guest_pet_id") || "").trim();
  if (petId === "") {
    throw new Error("対象のペットを選択してください");
  }
  const validFrom = String(formData.get("guest_valid_from") || "").trim();
  const validTo = String(formData.get("guest_valid_to") || "").trim();
  if (validFrom !== "" && validTo !== "" && validTo < validFrom) {
    throw new Error("終了日は開始日以降にしてください");
  }

  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // 対象ペットが自世帯のものであることは RLS（invites_insert_owner）が強制する。
  const { error } = await supabase.from("household_invites").insert({
    household_id: householdId,
    email,
    role,
    token,
    invited_by: user.id,
    expires_at: expiresAt,
    scope_pet_id: petId,
    valid_from: validFrom === "" ? null : validFrom,
    valid_to: validTo === "" ? null : validTo,
  });
  if (error) {
    throw new Error(`ゲスト招待の発行に失敗しました: ${error.message}`);
  }

  revalidatePath("/settings");
}

// ゲスト付与を失効する（owner のみ / UC-G04。失効した時点でゲストは読み書き不可）。
export async function revokeGuestGrant(householdId: string, grantId: string) {
  const { supabase } = await requireOwnerOf(householdId);

  const { error } = await supabase
    .from("guest_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", grantId)
    .eq("household_id", householdId);
  if (error) {
    throw new Error(`ゲスト付与の失効に失敗しました: ${error.message}`);
  }

  revalidatePath("/settings");
}

// 招待を取り消す（owner のみ / UC-O11）。
export async function revokeInvite(householdId: string, inviteId: string) {
  const { supabase } = await requireOwnerOf(householdId);

  const { error } = await supabase
    .from("household_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", inviteId)
    .eq("household_id", householdId);
  if (error) {
    throw new Error(`招待の取消に失敗しました: ${error.message}`);
  }

  revalidatePath("/settings");
}

// メンバーを世帯から削除する（owner のみ / UC-H05。最後の owner は D6 が拒否）。
export async function removeMember(householdId: string, memberUserId: string) {
  const { supabase } = await requireOwnerOf(householdId);

  const { error } = await supabase
    .from("household_members")
    .delete()
    .eq("household_id", householdId)
    .eq("user_id", memberUserId);
  if (error) {
    throw new Error(`メンバーの削除に失敗しました: ${error.message}`);
  }

  revalidatePath("/settings");
}

// 自分が世帯から退出する（UC-H06。最後の owner は D6 が拒否）。
// householdId は画面を描画した世帯（= 退出対象を明示。Cookie には依存しない）。
// 退出後は当該世帯のデータが一切見えなくなる（記録は世帯に残る = UC-H10）。
export async function leaveHousehold(householdId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("household_members")
    .delete()
    .eq("household_id", householdId)
    .eq("user_id", user.id);
  if (error) {
    // 最後の owner の場合は D6 トリガのメッセージをそのまま届ける。
    throw new Error(`世帯からの退出に失敗しました: ${error.message}`);
  }

  revalidatePath("/", "layout");
  redirect("/");
}

// 世帯を削除する（owner のみ / UC-H09。参照データの無い世帯だけ削除できる）。
// 一次防衛線は delete_own_household RPC（owner 検査・データ検出・D6 ガードを DB 側で強制）。
// データのある世帯の完全削除（エクスポート後のカスケード削除）は #51 で扱う。
export async function deleteHousehold(householdId: string) {
  const { supabase } = await requireOwnerOf(householdId);

  const { error } = await supabase.rpc("delete_own_household", {
    p_household_id: householdId,
  });
  if (error) {
    // RPC のメッセージ（owner でない / データがある 等）をそのまま届ける。
    throw new Error(`世帯を削除できませんでした: ${error.message}`);
  }

  // 現在世帯 Cookie が削除した世帯を指していたら畳む（次のリクエストで再解決させる）。
  const cookieStore = await cookies();
  if (cookieStore.get(HOUSEHOLD_COOKIE)?.value === householdId) {
    cookieStore.delete(HOUSEHOLD_COOKIE);
  }

  revalidatePath("/", "layout");
  redirect("/");
}

// 「現在の世帯」を切り替える（UC-H08）。Cookie に保持し、全画面が追従する。
// 実在する自分のメンバーシップのみ受理（Cookie 偽装は household.ts 側でも無視される）。
export async function switchHousehold(householdId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data } = await supabase
    .from("household_members")
    .select("household_id")
    .eq("user_id", user.id)
    .eq("household_id", householdId)
    .maybeSingle();
  if (!data) {
    throw new Error("その世帯のメンバーではありません");
  }

  const cookieStore = await cookies();
  cookieStore.set(HOUSEHOLD_COOKIE, householdId, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });

  revalidatePath("/", "layout");
  redirect("/settings");
}
