import Link from "next/link";
import { isSignupEnabled } from "@/lib/signup";
import SignupForm from "@/app/signup/SignupForm";

export const metadata = { title: "アカウント作成" };

// UC-O02/O08: セルフサインアップ。公開（課金 #49・法務 #50・濫用対策 #37）まで
// feature flag（SIGNUP_ENABLED）で閉じておき、閉塞中は招待のみの案内を出す。
export default function SignupPage() {
  const enabled = isSignupEnabled();

  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-2xl font-bold text-foreground">
          mfmf
        </h1>
        <p className="mb-8 text-center text-sm text-muted-foreground">
          ペット保育園記録
        </p>

        {enabled ? (
          <SignupForm />
        ) : (
          <div className="space-y-4 rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-border">
            <h2 className="text-base font-bold text-foreground">
              現在は招待制です
            </h2>
            <p className="text-sm text-muted-foreground">
              新規登録は現在受け付けていません。利用中の家族から招待リンクを
              受け取っている場合は、そのリンクから参加できます。
            </p>
            <p className="text-center text-sm">
              <Link
                href="/login"
                className="font-medium text-foreground underline-offset-2 hover:underline"
              >
                ログインへ戻る
              </Link>
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
