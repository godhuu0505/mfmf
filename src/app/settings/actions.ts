"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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
