"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { HOUSEHOLD_COOKIE } from "@/lib/household";

// 未所属ユーザーが新世帯を作成して owner になる（D7 / UC-O03）。
// 実体は SECURITY DEFINER の create_own_household（所属ゼロのユーザーのみ許可・
// ユーザー単位で直列化）。ここでは認証確認と Cookie の切替だけを行う。
export async function createOwnHousehold(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const name = String(formData.get("name") || "").trim();

  const { data, error } = await supabase.rpc("create_own_household", {
    p_name: name,
  });
  if (error) {
    throw new Error(`世帯の作成に失敗しました: ${error.message}`);
  }

  // 作成した世帯を「現在の世帯」にする（UC-H08 と同じ Cookie）。
  const cookieStore = await cookies();
  cookieStore.set(HOUSEHOLD_COOKIE, String(data), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });

  revalidatePath("/", "layout");
  // 次のステップ = 最初のペット登録（UC-O05）。
  redirect("/pets");
}
