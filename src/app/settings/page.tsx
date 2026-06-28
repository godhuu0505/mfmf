import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/profile";
import AppHeader from "@/components/AppHeader";
import { ProfileForm, PasswordForm } from "@/app/settings/SettingsForms";

export const dynamic = "force-dynamic";

export const metadata = { title: "設定" };

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const profile = await getCurrentProfile();

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="mb-6 text-xl font-bold text-foreground">設定</h1>

        <div className="space-y-6">
          <ProfileForm
            defaultDisplayName={profile?.display_name ?? ""}
            defaultAuthor={profile?.default_author ?? ""}
          />

          <PasswordForm />

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
