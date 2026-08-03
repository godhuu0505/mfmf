import Link from "next/link";
import { redirect } from "next/navigation";
import { Users } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/lib/household";
import { getCurrentProfile } from "@/lib/profile";
import { createAvatarSignedUrl } from "@/lib/avatars";
import AvatarUploader from "@/components/AvatarUploader";
import { ProfileForm, PasswordForm } from "@/app/(app)/settings/SettingsForms";
import { updateUserAvatar } from "@/app/(app)/settings/actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "アカウント設定" };

// アカウント設定（UC-M03 個人スコープ）。プロフィールとパスワードの変更に絞った画面。
// 世帯・招待などの管理は /settings（世帯の設定）へ分離している。
export default async function AccountSettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [profile, membership] = await Promise.all([
    getCurrentProfile(),
    getCurrentMembership(supabase),
  ]);
  const avatarUrl = await createAvatarSignedUrl(profile?.avatar_path);

  return (
    <>
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link
            href="/"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← 一覧へ戻る
          </Link>
        </div>
        <h1 className="mb-6 text-xl font-bold text-foreground">アカウント設定</h1>

        <div className="space-y-6">
          <section className="space-y-4 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
            <div>
              <h2 className="text-base font-bold text-foreground">プロフィール画像</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                あなたのアバター画像です（自分だけに表示されます）。
              </p>
            </div>
            <AvatarUploader
              scopeId={user.id}
              currentUrl={avatarUrl}
              action={updateUserAvatar}
              alt="あなたのアバター"
              label="アバター画像"
            />
          </section>

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

          {/* 世帯の設定への導線（メンバー・招待・ゲスト管理は別画面） */}
          {membership && (
            <section className="space-y-3 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
              <div>
                <h2 className="text-base font-bold text-foreground">世帯の設定</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  世帯名・メンバー・招待・ゲストの管理は別の画面で行います。
                </p>
              </div>
              <Link
                href="/settings"
                className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-surface-muted"
              >
                <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                世帯の設定を開く
              </Link>
            </section>
          )}
        </div>
      </main>
    </>
  );
}
