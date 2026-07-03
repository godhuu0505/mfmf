"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/lib/household";

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
  revalidatePath("/records/new");
  return { ok: true, message: "プロフィールを保存しました。" };
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

// 世帯名を変更する（owner のみ / UC-H02）。
export async function renameHousehold(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getCurrentMembership(supabase);
  if (!membership) throw new Error("世帯に所属していません");
  if (membership.role !== "owner") {
    throw new Error("世帯名の変更は owner のみ行えます");
  }

  const name = String(formData.get("household_name") || "").trim().slice(0, 100);
  const { error } = await supabase
    .from("households")
    .update({ name })
    .eq("id", membership.householdId);
  if (error) {
    throw new Error(`世帯名の変更に失敗しました: ${error.message}`);
  }

  revalidatePath("/settings");
}

// メンバーのロールを変更する（owner のみ / UC-H04。最後の owner の降格は D6 が拒否）。
export async function updateMemberRole(memberUserId: string, formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getCurrentMembership(supabase);
  if (!membership) throw new Error("世帯に所属していません");
  if (membership.role !== "owner") {
    throw new Error("ロールの変更は owner のみ行えます");
  }

  const role = String(formData.get("role") || "");
  if (!["owner", "editor", "viewer"].includes(role)) {
    throw new Error("不正なロールです");
  }

  const { error } = await supabase
    .from("household_members")
    .update({ role })
    .eq("household_id", membership.householdId)
    .eq("user_id", memberUserId);
  if (error) {
    // D6 トリガ（最後の owner の降格不可）のメッセージをそのまま届ける。
    throw new Error(`ロールの変更に失敗しました: ${error.message}`);
  }

  revalidatePath("/settings");
}
