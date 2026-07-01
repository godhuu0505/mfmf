"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getHouseholdIdForUser } from "@/lib/household";
import {
  toFeedbackFrequency,
  toFeedbackKind,
  toFeedbackSeverity,
  toFeedbackStatus,
  type FeedbackContext,
} from "@/types/database";
import type { FeedbackState } from "./types";

function trimOrNull(value: FormDataEntryValue | null): string | null {
  const s = String(value ?? "").trim();
  return s === "" ? null : s;
}

// クライアントから送られてきた状況 JSON を安全にパースする。
function parseContext(raw: FormDataEntryValue | null): FeedbackContext | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as FeedbackContext)
      : null;
  } catch {
    return null;
  }
}

// フォーム送信を受け取り、Supabase の feedback テーブルに保存する。
//
// 公開リポジトリに内容が漏れないよう、ここでは GitHub には一切送らない。
// GitHub Issue への転記は scripts/feedback-to-issues.mjs で、個人情報・秘匿情報を
// マスクしたうえで（非公開リポジトリ宛てに）手動実行する運用とする。
export async function submitFeedback(
  _prevState: FeedbackState,
  formData: FormData,
): Promise<FeedbackState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      message:
        "ログインの有効期限が切れているようです。お手数ですが一度ログインし直してから、もう一度お試しください。",
    };
  }

  const body = String(formData.get("body") ?? "").trim();
  if (body === "") {
    return {
      ok: false,
      message:
        "「どんなことでお困りですか？」の欄が空のようです。一言だけでも大丈夫ですので、内容を入力してください。",
    };
  }

  const kind = toFeedbackKind(formData.get("kind"));
  const severity = toFeedbackSeverity(formData.get("severity"));
  const frequency = toFeedbackFrequency(formData.get("frequency"));
  const whenHappened = trimOrNull(formData.get("when_happened"));
  const expected = trimOrNull(formData.get("expected"));
  const actual = trimOrNull(formData.get("actual"));
  const reporter = trimOrNull(formData.get("reporter"));
  const context = parseContext(formData.get("context"));
  // 所属世帯を解決し、書き込みに household_id をセットする（owner_id は従来どおり残す）。
  const householdId = await getHouseholdIdForUser(supabase, user.id);

  const { error: insertError } = await supabase.from("feedback").insert({
    owner_id: user.id,
    household_id: householdId,
    kind,
    severity,
    frequency,
    body,
    when_happened: whenHappened,
    expected,
    actual,
    reporter,
    context,
  });

  if (insertError) {
    return {
      ok: false,
      message:
        "申し訳ありません。送信に失敗してしまいました。通信状況を確認して、もう一度お試しください。",
    };
  }

  return {
    ok: true,
    message:
      "送信ありがとうございました！内容はしっかり届きました。いただいた声をもとに、よりよいアプリにしていきます。",
  };
}

// トリアージ画面から status を切り替える。RLS で本人の行のみ更新可能。
export async function setFeedbackStatus(id: string, formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const newStatus = toFeedbackStatus(formData.get("status"));

  const { error } = await supabase
    .from("feedback")
    .update({ status: newStatus, status_changed_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    throw new Error(`フィードバックの状態更新に失敗しました: ${error.message}`);
  }

  revalidatePath("/feedback");
}

// トリアージ画面からフィードバックを削除する。
export async function deleteFeedback(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.from("feedback").delete().eq("id", id);

  if (error) {
    throw new Error(`フィードバックの削除に失敗しました: ${error.message}`);
  }

  revalidatePath("/feedback");
}
