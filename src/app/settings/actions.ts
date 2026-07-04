"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import { getCurrentMembership, HOUSEHOLD_COOKIE } from "@/lib/household";

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

// 招待を発行する（owner のみ / UC-O09。宛先メール固定 D12・期限 7 日）。
// 強制は RLS（invites_insert_owner）。リンクは /invite/{token} を owner が本人へ共有する。
export async function createInvite(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getCurrentMembership(supabase);
  if (!membership || membership.role !== "owner") {
    throw new Error("招待の発行は owner のみ行えます");
  }

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
    household_id: membership.householdId,
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

// 招待を取り消す（owner のみ / UC-O11）。
export async function revokeInvite(inviteId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getCurrentMembership(supabase);
  if (!membership || membership.role !== "owner") {
    throw new Error("招待の取消は owner のみ行えます");
  }

  const { error } = await supabase
    .from("household_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", inviteId)
    .eq("household_id", membership.householdId);
  if (error) {
    throw new Error(`招待の取消に失敗しました: ${error.message}`);
  }

  revalidatePath("/settings");
}

// メンバーを世帯から削除する（owner のみ / UC-H05。最後の owner は D6 が拒否）。
export async function removeMember(memberUserId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getCurrentMembership(supabase);
  if (!membership || membership.role !== "owner") {
    throw new Error("メンバーの削除は owner のみ行えます");
  }

  const { error } = await supabase
    .from("household_members")
    .delete()
    .eq("household_id", membership.householdId)
    .eq("user_id", memberUserId);
  if (error) {
    throw new Error(`メンバーの削除に失敗しました: ${error.message}`);
  }

  revalidatePath("/settings");
}

// 自分が世帯から退出する（UC-H06。最後の owner は D6 が拒否）。
// 退出後は当該世帯のデータが一切見えなくなる（記録は世帯に残る = UC-H10）。
export async function leaveHousehold() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getCurrentMembership(supabase);
  if (!membership) throw new Error("世帯に所属していません");

  const { error } = await supabase
    .from("household_members")
    .delete()
    .eq("household_id", membership.householdId)
    .eq("user_id", user.id);
  if (error) {
    // 最後の owner の場合は D6 トリガのメッセージをそのまま届ける。
    throw new Error(`世帯からの退出に失敗しました: ${error.message}`);
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
