"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import {
  initialFeedbackState,
  submitFeedback,
} from "@/app/feedback/actions";
import {
  FEEDBACK_FREQUENCIES,
  FEEDBACK_FREQUENCY_LABEL,
  FEEDBACK_KIND_LABEL,
  FEEDBACK_KINDS,
  FEEDBACK_SEVERITIES,
  FEEDBACK_SEVERITY_LABEL,
  type FeedbackContext,
  type FeedbackKind,
} from "@/types/database";

// 送信時に、ユーザーが入力しなくてもアプリの状況を自動で集める。
function collectContext(): FeedbackContext {
  if (typeof window === "undefined") return {};
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari のホーム画面起動
    (window.navigator as unknown as { standalone?: boolean }).standalone ===
      true;
  return {
    page_path: window.location.pathname + window.location.search,
    page_url: window.location.href,
    user_agent: window.navigator.userAgent,
    language: window.navigator.language,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    screen: `${window.screen.width}x${window.screen.height}`,
    pixel_ratio: window.devicePixelRatio,
    online: window.navigator.onLine,
    standalone,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    client_time: new Date().toISOString(),
  };
}

// 種類ごとに、本文の見出しとヒント文を出し分ける（ITが苦手な方にも分かりやすく）。
const BODY_GUIDE: Record<
  FeedbackKind,
  { label: string; placeholder: string; hint: string }
> = {
  bug: {
    label: "どんなことでお困りですか？",
    placeholder:
      "例：写真をのせようとしたら、ぐるぐる回ったまま進まなくなりました。",
    hint: "うまくいかなかったことを、思ったままの言葉で大丈夫です。短くてもかまいません。",
  },
  request: {
    label: "どんなことができたら、うれしいですか？",
    placeholder:
      "例：その日のごはんの量も、いっしょに記録できたらうれしいです。",
    hint: "「こうなったらいいな」と思うことを、自由に書いてください。",
  },
  question: {
    label: "気になっていること・聞きたいことを教えてください",
    placeholder: "例：まちがえて消してしまった記録は、元にもどせますか？",
    hint: "どんな小さなことでも大丈夫です。お気軽にどうぞ。",
  },
};

const inputClass =
  "w-full rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground";
const labelClass = "mb-1 block text-sm font-medium text-foreground";
const hintClass = "mb-1.5 text-xs leading-relaxed text-muted-foreground";

export default function FeedbackWidget() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* どの画面でも右下に出るフローティングボタン */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-40 flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-medium text-primary-foreground shadow-lg ring-1 ring-black/5 transition hover:bg-primary-hover active:scale-95"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        ご意見・不具合
      </button>

      {open && <FeedbackDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const [state, formAction, isPending] = useActionState(
    submitFeedback,
    initialFeedbackState,
  );
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [contextJson, setContextJson] = useState("");
  const [showDetails, setShowDetails] = useState(false);

  // ダイアログを開いた時点でのアプリの状況を集めて hidden field に入れる。
  useEffect(() => {
    setContextJson(JSON.stringify(collectContext()));
  }, []);

  // 背景のスクロールを止める + Esc で閉じる。
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const guide = useMemo(() => BODY_GUIDE[kind], [kind]);
  const succeeded = state.ok;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-title"
    >
      {/* 背景の暗幕（クリックで閉じる） */}
      <button
        type="button"
        aria-label="閉じる"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />

      <div className="relative z-10 flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
        {/* ヘッダー */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2
              id="feedback-title"
              className="text-base font-semibold text-foreground"
            >
              ご意見・不具合のお知らせ
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              気づいたことを、なんでも教えてください。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="-mr-1 rounded-lg p-1.5 text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {succeeded ? (
          // 送信完了画面
          <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-7 w-7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </div>
            <p className="text-sm leading-relaxed text-foreground">
              {state.message}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 rounded-lg bg-primary px-6 py-2.5 font-medium text-primary-foreground transition hover:bg-primary-hover"
            >
              閉じる
            </button>
          </div>
        ) : (
          <form action={formAction} className="overflow-y-auto px-5 py-4">
            {/* イントロ */}
            <p className="mb-4 rounded-lg bg-surface-muted px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              入力が必要なのは「内容」だけです。むずかしく考えず、思ったことを
              そのまま書いてください。書ける範囲で大丈夫です。今このアプリで
              起きている状況（開いている画面など）も、自動でいっしょにお送りします。
            </p>

            {/* 種類 */}
            <div className="mb-4">
              <span className={labelClass}>どれにいちばん近いですか？</span>
              <input type="hidden" name="kind" value={kind} />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {FEEDBACK_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    aria-pressed={kind === k}
                    className={
                      "rounded-lg border px-3 py-2 text-sm font-medium transition " +
                      (kind === k
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground hover:bg-surface-muted")
                    }
                  >
                    {FEEDBACK_KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>

            {/* 本文（唯一の必須項目） */}
            <div className="mb-4">
              <label htmlFor="feedback-body" className={labelClass}>
                {guide.label}
                <span className="ml-1 text-xs font-normal text-rose-500">
                  （ここだけ必須です）
                </span>
              </label>
              <p className={hintClass}>{guide.hint}</p>
              <textarea
                id="feedback-body"
                name="body"
                rows={5}
                required
                autoFocus
                placeholder={guide.placeholder}
                className={inputClass}
              />
            </div>

            {/* もっと詳しく（任意・折りたたみ） */}
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              aria-expanded={showDetails}
              className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2.5 text-left text-sm font-medium text-foreground transition hover:bg-surface-muted"
            >
              <span>
                もっと詳しく教えていただけますか？
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  （任意・書ける範囲でOK）
                </span>
              </span>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className={
                  "h-4 w-4 shrink-0 text-muted-foreground transition " +
                  (showDetails ? "rotate-180" : "")
                }
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>

            {showDetails && (
              <div className="mt-3 space-y-4 rounded-lg bg-surface-muted px-3 py-4">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  分かるところだけで大丈夫です。空欄のままでも送信できます。
                </p>

                {/* いつ */}
                <div>
                  <label htmlFor="feedback-when" className={labelClass}>
                    いつのことですか？
                  </label>
                  <p className={hintClass}>
                    例：「さっき」「今日の朝」「昨日の夜くらい」など、ざっくりで大丈夫です。
                  </p>
                  <input
                    id="feedback-when"
                    name="when_happened"
                    type="text"
                    placeholder="さっき / 今日の朝 など"
                    className={inputClass}
                  />
                </div>

                {/* 期待した動き（不具合のとき向け） */}
                <div>
                  <label htmlFor="feedback-expected" className={labelClass}>
                    本当はどうなってほしかったですか？
                  </label>
                  <input
                    id="feedback-expected"
                    name="expected"
                    type="text"
                    placeholder="例：写真がそのまま保存される"
                    className={inputClass}
                  />
                </div>

                {/* 実際の動き */}
                <div>
                  <label htmlFor="feedback-actual" className={labelClass}>
                    実際には、どうなりましたか？
                  </label>
                  <input
                    id="feedback-actual"
                    name="actual"
                    type="text"
                    placeholder="例：エラーが出て保存できなかった"
                    className={inputClass}
                  />
                </div>

                {/* 頻度 */}
                <div>
                  <label htmlFor="feedback-frequency" className={labelClass}>
                    それは、どれくらいの頻度で起きますか？
                  </label>
                  <select
                    id="feedback-frequency"
                    name="frequency"
                    defaultValue=""
                    className={inputClass}
                  >
                    <option value="">選ばなくても大丈夫です</option>
                    {FEEDBACK_FREQUENCIES.map((f) => (
                      <option key={f} value={f}>
                        {FEEDBACK_FREQUENCY_LABEL[f]}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 困り度 */}
                <div>
                  <label htmlFor="feedback-severity" className={labelClass}>
                    どれくらい、お困りですか？
                  </label>
                  <select
                    id="feedback-severity"
                    name="severity"
                    defaultValue=""
                    className={inputClass}
                  >
                    <option value="">選ばなくても大丈夫です</option>
                    {FEEDBACK_SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {FEEDBACK_SEVERITY_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 記入者 */}
                <div>
                  <label htmlFor="feedback-reporter" className={labelClass}>
                    よろしければ、お名前を教えてください
                  </label>
                  <p className={hintClass}>
                    どちらが書いたか分かると、お返事しやすくなります。
                  </p>
                  <input
                    id="feedback-reporter"
                    name="reporter"
                    type="text"
                    placeholder="おとうさん / おかあさん など"
                    className={inputClass}
                  />
                </div>
              </div>
            )}

            {/* 自動収集したアプリの状況 */}
            <input type="hidden" name="context" value={contextJson} />

            {/* エラー表示 */}
            {state.message && !state.ok && (
              <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm leading-relaxed text-rose-600">
                {state.message}
              </p>
            )}

            {/* 送信 */}
            <div className="mt-5 flex items-center justify-end gap-3 border-t border-border pt-4">
              <button
                type="button"
                onClick={onClose}
                className="text-sm text-muted-foreground transition hover:text-foreground"
              >
                やめる
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="rounded-lg bg-primary px-6 py-2.5 font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
              >
                {isPending ? "送信中…" : "送信する"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
