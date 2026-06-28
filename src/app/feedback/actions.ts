"use server";

import { createClient } from "@/lib/supabase/server";
import {
  toFeedbackFrequency,
  toFeedbackKind,
  toFeedbackSeverity,
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

  const { error: insertError } = await supabase.from("feedback").insert({
    owner_id: user.id,
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
