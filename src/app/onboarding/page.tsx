import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/lib/household";
import { hasActiveGuestGrant } from "@/lib/guest";
import SubmitButton from "@/components/SubmitButton";
import { createOwnHousehold } from "@/app/onboarding/actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "はじめる" };

// 初回オンボーディング（UC-O03/O05）: 世帯を持たないユーザーの入口。
// D7 の両導線 =「新世帯を作成して owner になる」か「招待リンクから既存世帯に参加する」。
export default async function OnboardingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // 既に世帯があるユーザーに作成 UI は出さない（追加参加は招待経由のみ）。
  const membership = await getCurrentMembership(supabase);
  if (membership) redirect("/");

  // 有効なゲスト付与を持つユーザーはゲスト画面へ（UC-G02。世帯を持たないのが正常）。
  if (await hasActiveGuestGrant(supabase, user.id)) redirect("/guest");

  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-center text-2xl font-bold text-foreground">
          mfmf へようこそ
        </h1>
        <p className="mb-8 text-center text-sm text-muted-foreground">
          はじめに、記録を共有する「世帯」を作成します。
        </p>

        <div className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-border">
          <form action={createOwnHousehold} className="space-y-4">
            <div>
              <label
                htmlFor="name"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                世帯の名前
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  （任意・あとから変更できます）
                </span>
              </label>
              <input
                id="name"
                name="name"
                type="text"
                placeholder="例: 山田家"
                className="w-full rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground"
              />
            </div>
            <SubmitButton
              pendingLabel="作成中…"
              className="w-full rounded-lg bg-primary px-5 py-2.5 font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
            >
              世帯を作成してはじめる
            </SubmitButton>
          </form>

          <p className="mt-4 border-t border-border pt-4 text-xs text-muted-foreground">
            家族から招待を受けている場合は、届いた招待リンクを開くとその世帯に
            参加できます（この画面で世帯を作る必要はありません）。
          </p>
        </div>
      </div>
    </main>
  );
}
