import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/lib/household";
import { getCurrentProfile } from "@/lib/profile";
import AppHeader from "@/components/AppHeader";
import SubmitButton from "@/components/SubmitButton";
import { ProfileForm, PasswordForm } from "@/app/settings/SettingsForms";
import { renameHousehold, updateMemberRole } from "@/app/settings/actions";

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
                      ) : (
                        <span className="text-muted-foreground">{m.role}</span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  メンバーの招待・削除・退出は今後のアップデート（S3 内部招待）で対応予定です。
                  世帯には最低 1 人の owner が必要です。
                </p>
              </div>
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
