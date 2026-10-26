"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { InviteErrorReason } from "@/app/invite/reasons";

// accept_household_invite が raise する errcode → 受諾ページに出す理由コード。
// メッセージ本文には依存しない（migration で文言が変わっても壊れないように）。
const REASON_BY_ERRCODE: Record<string, InviteErrorReason> = {
  "42501": "mismatch", // 宛先メール不一致 / 未ログイン（D12/D13）
  P0002: "invalid", // 見つからない・取消済み・使用済み・期限切れ・対象ペット消滅
  P0001: "already_member", // ゲスト招待だが既に世帯メンバー
};

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
    // ここで throw すると、エラーバウンダリが無い本番ビルドでは画面全体が
    // 「Application error」に置き換わり、理由が一切ユーザーに届かない。
    // 受諾ページへ戻して、理由を日本語で出す。
    console.error("accept_household_invite failed", {
      code: error.code,
      message: error.message,
    });
    const reason = REASON_BY_ERRCODE[error.code ?? ""] ?? "unknown";
    redirect(`/invite/${encodeURIComponent(token)}?error=${reason}`);
  }

  redirect("/");
}
