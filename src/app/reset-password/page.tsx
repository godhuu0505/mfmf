import { cookies } from "next/headers";
import ResetPasswordForm from "@/app/reset-password/ResetPasswordForm";
import { POST_LOGIN_NEXT_COOKIE, sanitizeNextPath } from "@/lib/nextPath";

export const dynamic = "force-dynamic";

export const metadata = { title: "新しいパスワードを設定" };

// パスワード再設定の入口。再設定メールのリンクは
// /auth/callback?next=/reset-password（Supabase の Redirect URLs に完全一致で
// 登録済み）なので、招待リンクから来た場合の行き先はクエリに載らない。
// middleware が置いた Cookie から拾い、更新後にそこへ戻す。
export default async function ResetPasswordPage() {
  const cookieStore = await cookies();
  const next = sanitizeNextPath(cookieStore.get(POST_LOGIN_NEXT_COOKIE)?.value);
  return <ResetPasswordForm next={next} />;
}
