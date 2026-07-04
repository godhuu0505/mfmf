import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/lib/household";
import { getCurrentProfile } from "@/lib/profile";
import AppHeader from "@/components/AppHeader";
import SubmitButton from "@/components/SubmitButton";
import { ProfileForm, PasswordForm } from "@/app/settings/SettingsForms";
import {
  createInvite,
  leaveHousehold,
  removeMember,
  renameHousehold,
  revokeInvite,
  updateMemberRole,
} from "@/app/settings/actions";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  owner: "owner（全権・メンバー管理）",
  editor: "editor（記録の追加・編集）",
  viewer: "viewer（閲覧のみ）",
};

export const metadata = { title: "設定" };

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const profile = await getCurrentProfile();

  // 世帯セクション（Phase 3.5 S2 #46）: 世帯名・メンバー一覧・ロール変更（owner のみ）。
  // メンバー一覧は RLS（household_members_select_member）で自世帯分のみ返る。
  const membership = await getCurrentMembership(supabase);
  const isOwner = membership?.role === "owner";
  const [{ data: household }, { data: members }] = membership
    ? await Promise.all([
        supabase
          .from("households")
          .select("id, name")
          .eq("id", membership.householdId)
          .maybeSingle(),
        supabase
          .from("household_members")
          .select("user_id, role, created_at")
          .eq("household_id", membership.householdId)
          .order("created_at", { ascending: true }),
      ])
    : [{ data: null }, { data: null }];

  // 招待一覧（owner のみ。RLS invites_select_owner が強制）。
  const { data: invites } =
    membership && isOwner
      ? await supabase
          .from("household_invites")
          .select("id, email, role, token, expires_at, accepted_at, revoked_at")
          .eq("household_id", membership.householdId)
          .order("created_at", { ascending: false })
          .limit(20)
      : { data: null };

  const inviteStatus = (inv: {
    expires_at: string;
    accepted_at: string | null;
    revoked_at: string | null;
  }): string => {
    if (inv.accepted_at) return "受諾済み";
    if (inv.revoked_at) return "取消済み";
    if (new Date(inv.expires_at).getTime() < Date.now()) return "期限切れ";
    return "有効";
  };

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="mb-6 text-xl font-bold text-foreground">設定</h1>

        <div className="space-y-6">
          <ProfileForm
            defaultDisplayName={profile?.display_name ?? ""}
            defaultAuthor={profile?.default_author ?? ""}
          />

          <PasswordForm />

          {/* 世帯（household）: 名前・メンバー・ロール（Phase 3.5 S2） */}
          {membership && (
            <section className="space-y-4 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
              <div>
                <h2 className="text-base font-bold text-foreground">世帯</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  記録・写真・ペットは世帯のメンバーで共有されます。あなたのロール:{" "}
                  {ROLE_LABEL[membership.role] ?? membership.role}
                </p>
              </div>

              {isOwner ? (
                <form action={renameHousehold} className="flex items-end gap-2">
                  <div className="flex-1">
                    <label
                      htmlFor="household_name"
                      className="mb-1 block text-sm font-medium text-foreground"
                    >
                      世帯の名前
                    </label>
                    <input
                      id="household_name"
                      name="household_name"
                      type="text"
                      defaultValue={household?.name ?? ""}
                      placeholder="例: うちの家族"
                      className="w-full rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground"
                    />
                  </div>
                  <SubmitButton
                    pendingLabel="保存中…"
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
                  >
                    保存
                  </SubmitButton>
                </form>
              ) : (
                <p className="rounded-lg bg-surface-muted px-3 py-2 text-sm text-foreground">
                  世帯の名前: {household?.name || "（未設定）"}
                </p>
              )}

              <div>
                <h3 className="mb-2 text-sm font-medium text-foreground">メンバー</h3>
                <ul className="space-y-2">
                  {(members ?? []).map((m) => (
                    <li
                      key={m.user_id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-muted px-3 py-2 text-sm"
                    >
                      <span className="text-foreground">
                        {m.user_id === user.id
                          ? `${profile?.display_name || user.email || "自分"}（自分）`
                          : `メンバー ${m.user_id.slice(0, 8)}…`}
                      </span>
                      {isOwner && m.user_id !== user.id ? (
                        <div className="flex items-center gap-2">
                          <form
                            action={updateMemberRole.bind(null, m.user_id)}
                            className="flex items-center gap-2"
                          >
                            <select
                              name="role"
                              defaultValue={m.role}
                              className="rounded-lg border border-border px-2 py-1 text-sm text-foreground"
                            >
                              <option value="owner">owner</option>
                              <option value="editor">editor</option>
                              <option value="viewer">viewer</option>
                            </select>
                            <SubmitButton
                              pendingLabel="変更中…"
                              className="rounded-lg border border-border px-3 py-1 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-60"
                            >
                              変更
                            </SubmitButton>
                          </form>
                          <form action={removeMember.bind(null, m.user_id)}>
                            <SubmitButton
                              pendingLabel="削除中…"
                              className="text-xs text-red-600 transition hover:text-red-800 disabled:opacity-60"
                            >
                              削除
                            </SubmitButton>
                          </form>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">{m.role}</span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  削除・退出しても、その人が書いた記録は世帯に残ります。
                  世帯には最低 1 人の owner が必要です（最後の owner は降格・退出できません）。
                </p>
                <form action={leaveHousehold} className="mt-3">
                  <SubmitButton
                    pendingLabel="退出中…"
                    className="text-xs text-red-600 transition hover:text-red-800 disabled:opacity-60"
                  >
                    この世帯から退出する
                  </SubmitButton>
                </form>
              </div>

              {/* 招待（owner のみ / UC-O09〜O11。宛先メール固定 D12） */}
              {isOwner && (
                <div className="border-t border-border pt-4">
                  <h3 className="mb-2 text-sm font-medium text-foreground">
                    メンバーを招待
                  </h3>
                  <form action={createInvite} className="flex flex-wrap items-end gap-2">
                    <div className="flex-1 min-w-[12rem]">
                      <label
                        htmlFor="invite_email"
                        className="mb-1 block text-xs text-muted-foreground"
                      >
                        宛先メールアドレス（このアドレスのアカウントだけが参加できます）
                      </label>
                      <input
                        id="invite_email"
                        name="invite_email"
                        type="email"
                        required
                        placeholder="family@example.com"
                        className="w-full rounded-lg border border-border px-3 py-2 text-sm text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground"
                      />
                    </div>
                    <select
                      name="invite_role"
                      defaultValue="editor"
                      className="rounded-lg border border-border px-2 py-2 text-sm text-foreground"
                    >
                      <option value="editor">editor（編集可）</option>
                      <option value="viewer">viewer（閲覧のみ）</option>
                    </select>
                    <SubmitButton
                      pendingLabel="発行中…"
                      className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
                    >
                      招待を発行
                    </SubmitButton>
                  </form>

                  {(invites ?? []).length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {(invites ?? []).map((inv) => (
                        <li
                          key={inv.id}
                          className="rounded-lg bg-surface-muted px-3 py-2 text-sm"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-foreground">
                              {inv.email}（{inv.role}） ・ {inviteStatus(inv)}
                            </span>
                            {inviteStatus(inv) === "有効" && (
                              <form action={revokeInvite.bind(null, inv.id)}>
                                <SubmitButton
                                  pendingLabel="取消中…"
                                  className="text-xs text-red-600 transition hover:text-red-800 disabled:opacity-60"
                                >
                                  取り消す
                                </SubmitButton>
                              </form>
                            )}
                          </div>
                          {inviteStatus(inv) === "有効" && (
                            <p className="mt-1 break-all text-xs text-muted-foreground">
                              招待リンク: /invite/{inv.token}
                              （このリンクを本人に共有してください）
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          )}

          {/* フィードバックのトリアージ導線 */}
          <section className="space-y-3 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
            <div>
              <h2 className="text-base font-bold text-foreground">
                送信したフィードバック
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                ご意見・不具合報告の状態を確認・整理できます。
              </p>
            </div>
            <Link
              href="/feedback"
              className="inline-block rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-surface-muted"
            >
              トリアージ画面を開く
            </Link>
          </section>

          {/* アカウント情報・サインアウト */}
          <section className="space-y-4 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
            <div>
              <h2 className="text-base font-bold text-foreground">アカウント</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                ログイン中のメールアドレスです。
              </p>
            </div>
            <p className="break-all rounded-lg bg-surface-muted px-3 py-2 text-sm text-foreground">
              {user.email ?? "（メールアドレス未設定）"}
            </p>
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-foreground transition hover:bg-surface-muted"
              >
                ログアウト
              </button>
            </form>
          </section>
        </div>

        {/* アバター画像のアップロードは将来対応 */}
      </main>
    </>
  );
}
