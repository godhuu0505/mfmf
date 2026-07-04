import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "@/components/AppHeader";
import SubmitButton from "@/components/SubmitButton";
import { acceptInvite } from "@/app/invite/actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "世帯への招待" };

// 招待の受諾ページ（UC-O10）。
// 表示は invites_select_invitee（自分のメール宛てのみ可視）に依存し、受諾の検証
// （token 実在・未失効・期限内・宛先メール一致 D12/D13）は DB の
// accept_household_invite（SECURITY DEFINER）が最終防衛線として行う。
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // 自分のメール宛てなら RLS 越しに見える（他人宛て・存在しない token は null）。
  const { data: invite } = await supabase
    .from("household_invites")
    .select("email, role, expires_at, accepted_at, revoked_at")
    .eq("token", token)
    .maybeSingle();

  const invalid =
    !invite ||
    invite.revoked_at !== null ||
    invite.accepted_at !== null ||
    new Date(invite.expires_at).getTime() < Date.now();

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="mb-4 text-xl font-bold text-foreground">世帯への招待</h1>

        {invalid ? (
          <section className="space-y-3 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
            <p className="text-sm text-foreground">
              この招待は無効です（期限切れ・取消済み・使用済み、または宛先のメール
              アドレスがログイン中のアカウント（{user.email ?? "不明"}）と一致しません）。
            </p>
            <p className="text-sm text-muted-foreground">
              招待した方に、宛先メールアドレスの確認と再送を依頼してください。
            </p>
            <Link
              href="/"
              className="inline-block rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-surface-muted"
            >
              ホームへ戻る
            </Link>
          </section>
        ) : (
          <section className="space-y-4 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
            <p className="text-sm text-foreground">
              あなた（{invite.email}）は、ロール{" "}
              <span className="font-medium">{invite.role}</span>{" "}
              として世帯に招待されています。参加すると世帯の記録・写真・ペットを
              {invite.role === "viewer" ? "閲覧できます。" : "閲覧・編集できます。"}
            </p>
            <form action={acceptInvite.bind(null, token)}>
              <SubmitButton
                pendingLabel="参加中…"
                className="rounded-lg bg-primary px-5 py-2.5 font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
              >
                この世帯に参加する
              </SubmitButton>
            </form>
          </section>
        )}
      </main>
    </>
  );
}
