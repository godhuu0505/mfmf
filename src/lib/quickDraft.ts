import type { RecordSource } from "@/types/database";

// クイック記録 → 記録フォームへの下書き引き継ぎ（proto 合意の
// 「写真つきでくわしく記録する →」導線）。本文には家族のプライベートな
// メモが入るため、URL クエリではなく sessionStorage（同一タブ限定・
// 履歴やサーバーログに残らない）で渡す。

export type QuickDraft = { body: string; source: RecordSource };

const KEY = "mfmf:quick-draft";

export function saveQuickDraft(draft: QuickDraft): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // プライベートモード等で失敗しても導線自体は生かす（下書きなしで開く）
  }
}

/** 下書きを取り出して消す（一度きり。リロードで再適用されないように）。 */
export function takeQuickDraft(): QuickDraft | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "body" in parsed &&
      typeof parsed.body === "string" &&
      "source" in parsed &&
      (parsed.source === "home" || parsed.source === "daycare")
    ) {
      return { body: parsed.body, source: parsed.source };
    }
  } catch {
    // 壊れた値は捨てる
  }
  return null;
}
