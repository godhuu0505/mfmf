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
        <h1 className="mb-6 text-xl font-bold text-slate-900">設定</h1>

        <div className="space-y-6">
          <ProfileForm
            defaultDisplayName={profile?.display_name ?? ""}
            defaultAuthor={profile?.default_author ?? ""}
          />

          <PasswordForm />

          {/* アカウント情報・サインアウト */}
          <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <div>
              <h2 className="text-base font-bold text-slate-900">アカウント</h2>
              <p className="mt-0.5 text-sm text-slate-500">
                ログイン中のメールアドレスです。
              </p>
            </div>
            <p className="break-all rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
              {user.email ?? "（メールアドレス未設定）"}
            </p>
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
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
