"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireEditableHousehold } from "@/lib/household";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

export async function createShareLink(formData: FormData) {
  const { supabase, user } = await requireUser();

  const label = String(formData.get("label") || "").trim() || null;
  const fromRaw = String(formData.get("from_date") || "").trim();
  const toRaw = String(formData.get("to_date") || "").trim();
  const expiresDaysRaw = String(formData.get("expires_days") || "").trim();

  const from_date = fromRaw === "" ? null : fromRaw;
  const to_date = toRaw === "" ? null : toRaw;

  // 期限（日数）。0 / 空 / 不正は無期限。
  let expires_at: string | null = null;
  const days = Number(expiresDaysRaw);
  if (Number.isFinite(days) && days > 0) {
    expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  // 共有対象は「現在の世帯」に固定する（複数世帯の作成者でも他世帯の記録は漏れない）。
  const householdId = await requireEditableHousehold(supabase, user.id);
  if (!householdId) {
    throw new Error("世帯に所属していないため共有リンクを作成できません");
  }

  // 推測不能なトークン（256bit 相当）。
  const token = randomBytes(24).toString("base64url");

  const { error } = await supabase.from("share_links").insert({
    owner_id: user.id,
    household_id: householdId,
    token,
    label,
    from_date,
    to_date,
    expires_at,
  });
  if (error) {
    throw new Error(`共有リンクの作成に失敗しました: ${error.message}`);
  }

  revalidatePath("/shares");
}

// 失効（revoke）。リンクは残すが無効化する。
export async function revokeShareLink(id: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase
    .from("share_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    throw new Error(`失効に失敗しました: ${error.message}`);
  }
  revalidatePath("/shares");
}

// 完全削除。
export async function deleteShareLink(id: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("share_links").delete().eq("id", id);
  if (error) {
    throw new Error(`削除に失敗しました: ${error.message}`);
  }
  revalidatePath("/shares");
}
