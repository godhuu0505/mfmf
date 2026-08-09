import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "@/components/AppHeader";
import SubmitButton from "@/components/SubmitButton";
import { acceptInvite } from "@/app/invite/actions";
import { inviteErrorMessage } from "@/app/invite/reasons";

export const dynamic = "force-dynamic";

export const metadata = { title: "世帯への招待" };

// 招待の受諾ページ（UC-O10）。
// 表示は invites_select_invitee（自分のメール宛て）と invites_select_owner
// （自世帯の招待は owner にも見える）に依存する。**owner には他人宛ての招待も
// 見える**ため、宛先メールの一致はこの画面でも必ず判定すること —— ここを
// 見ていないと、招待した本人がリンクを確認したときに受諾ボタンが出てしまい、
// 押すと accept_household_invite が D12/D13 で弾いて例外になる。
// 受諾の検証（token 実在・未失効・期限内・宛先メール一致）は DB の
// accept_household_invite（SECURITY DEFINER）が最終防衛線として行う。
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error: errorReason } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // 自分のメール宛て（invitee）か自世帯の招待（owner）なら RLS 越しに見える。
  const { data: invite, error } = await supabase
    .from("household_invites")
    .select(
      "email, role, expires_at, accepted_at, accepted_by, revoked_at, valid_from, valid_to",
    )
    .eq("token", token)
    .maybeSingle();
  if (error) {
    // 取得失敗を「無効な招待」に混ぜない（原因が追えなくなる）。
    console.error("failed to load household_invite", {
      code: error.code,
      message: error.message,
    });
  }

  const userEmail = (user.email ?? "").trim().toLowerCase();
  const status = (() => {
    if (error) return "load_failed" as const;
    if (!invite) return "not_found" as const;
    if (invite.revoked_at !== null) return "revoked" as const;
    if (invite.accepted_at !== null) {
      return invite.accepted_by === user.id
        ? ("already_accepted" as const)
        : ("used" as const);
    }
    if (new Date(invite.expires_at).getTime() < Date.now())
      return "expired" as const;
    if ((invite.email ?? "").trim().toLowerCase() !== userEmail)
      return "mismatch" as const;
    return "ok" as const;
  })();

  // 受諾可能なときだけ招待の中身を出す（型としても null を外す）。
  const acceptable = status === "ok" ? invite : null;
  const isGuestInvite = acceptable?.role?.startsWith("guest:") ?? false;
  const acceptError = inviteErrorMessage(errorReason);

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="mb-4 text-xl font-bold text-foreground">世帯への招待</h1>

        {acceptError && (
          <p
            role="alert"
            className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600"
          >
            {acceptError}
          </p>
        )}

        {acceptable ? (
          <section className="space-y-4 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
            {isGuestInvite ? (
              <p className="text-sm text-foreground">
                あなた（{acceptable.email}）は、
                <span className="font-medium">
                  {acceptable.role === "guest:daycare" ? "保育園" : "シッター"}の
                  ゲスト
                </span>
                として招待されています。参加すると、対象のペット 1 匹について、
                期間内（{acceptable.valid_from ?? "参加日"} 〜{" "}
                {acceptable.valid_to ?? "失効まで"}）に共有された記録の閲覧と、
                お世話の記録の追加ができます（写真や世帯のその他の情報は
                見えません）。
              </p>
            ) : (
              <p className="text-sm text-foreground">
                あなた（{acceptable.email}）は、ロール{" "}
                <span className="font-medium">{acceptable.role}</span>{" "}
                として世帯に招待されています。参加すると世帯の記録・写真・ペットを
                {acceptable.role === "viewer"
                  ? "閲覧できます。"
                  : "閲覧・編集できます。"}
              </p>
            )}
            <form action={acceptInvite.bind(null, token)}>
              <SubmitButton
                pendingLabel="参加中…"
                className="rounded-lg bg-primary px-5 py-2.5 font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
              >
                {isGuestInvite ? "ゲストとして参加する" : "この世帯に参加する"}
              </SubmitButton>
            </form>
          </section>
        ) : (
          <section className="space-y-3 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
            <InviteProblem
              status={status}
              inviteEmail={invite?.email ?? null}
              userEmail={user.email ?? null}
            />
            {status === "mismatch" && (
              <form method="post" action="/auth/signout">
                <input type="hidden" name="next" value={`/invite/${token}`} />
                <button
                  type="submit"
                  className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover"
                >
                  別のアカウントでログインし直す
                </button>
              </form>
            )}
            <Link
              href="/"
              className="inline-block rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-surface-muted"
            >
              ホームへ戻る
            </Link>
          </section>
        )}
      </main>
    </>
  );
}

// 受諾できない理由を、原因ごとに切り分けて出す（全部「無効です」に潰さない）。
function InviteProblem({
  status,
  inviteEmail,
  userEmail,
}: {
  status:
    | "load_failed"
    | "not_found"
    | "revoked"
    | "used"
    | "already_accepted"
    | "expired"
    | "mismatch"
    | "ok";
  inviteEmail: string | null;
  userEmail: string | null;
}) {
  switch (status) {
    case "ok":
      return null; // 受諾フォーム側で描画する（ここには来ない）
    case "load_failed":
      return (
        <>
          <p className="text-sm text-foreground">
            招待の読み込みに失敗しました。時間をおいて再度お試しください。
          </p>
          <p className="text-sm text-muted-foreground">
            繰り返す場合はフィードバックからお知らせください。
          </p>
        </>
      );
    case "not_found":
      return (
        <>
          <p className="text-sm text-foreground">
            この招待は見つかりませんでした。リンクが途中で切れていないか確認して
            ください。
          </p>
          <p className="text-sm text-muted-foreground">
            心当たりがない場合は、招待した方に再送を依頼してください
            （ログイン中: {userEmail ?? "不明"}）。
          </p>
        </>
      );
    case "mismatch":
      return (
        <>
          <p className="text-sm text-foreground">
            この招待は <span className="font-medium">{inviteEmail}</span>{" "}
            宛てですが、いまログインしているのは{" "}
            <span className="font-medium">{userEmail ?? "不明"}</span> です。
          </p>
          <p className="text-sm text-muted-foreground">
            宛先のアカウントでログインし直すと参加できます。
          </p>
        </>
      );
    case "revoked":
      return (
        <>
          <p className="text-sm text-foreground">
            この招待は取り消されています。
          </p>
          <p className="text-sm text-muted-foreground">
            招待した方に再発行を依頼してください。
          </p>
        </>
      );
    case "used":
      return (
        <>
          <p className="text-sm text-foreground">この招待は使用済みです。</p>
          <p className="text-sm text-muted-foreground">
            招待した方に再発行を依頼してください。
          </p>
        </>
      );
    case "already_accepted":
      return (
        <>
          <p className="text-sm text-foreground">
            この招待は受諾済みです。すでに世帯に参加しています。
          </p>
          <p className="text-sm text-muted-foreground">
            ホームから記録を確認できます。
          </p>
        </>
      );
    case "expired":
      return (
        <>
          <p className="text-sm text-foreground">
            この招待は期限切れです（発行から 7 日間有効）。
          </p>
          <p className="text-sm text-muted-foreground">
            招待した方に再発行を依頼してください。
          </p>
        </>
      );
  }
}
