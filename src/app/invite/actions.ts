"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// 招待を受諾する（UC-O10）。検証（token 実在・未失効・期限内・宛先メール一致
// D12/D13）はすべて DB の accept_household_invite（SECURITY DEFINER）が行う。
export async function acceptInvite(token: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.rpc("accept_household_invite", {
    p_token: token,
  });
  if (error) {
    // PG 例外のメッセージ（期限切れ・宛先不一致など）をそのまま届ける。
    throw new Error(`招待を受諾できませんでした: ${error.message}`);
  }

  redirect("/");
}
