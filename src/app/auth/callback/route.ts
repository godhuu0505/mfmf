import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// OAuth (Google 等) のコールバック。
// PKCE フローの `code` をセッションへ交換し、成功したら `next`（相対パス）へ戻す。
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // オープンリダイレクト対策: 相対パスのみ許可（"/" 始まりかつ "//" や "http" を弾く）。
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // code 欠落・交換失敗時はエラー付きでログインへ戻す。
  return NextResponse.redirect(`${origin}/login?error=oauth`);
}

// 安全な遷移先だけを返す。許可しない場合は "/"。
function safeNextPath(raw: string | null): string {
  if (!raw) return "/";
  // "/" 始まりで、かつ "//"（プロトコル相対）や "/\" でないもののみ許可。
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) {
    return raw;
  }
  return "/";
}
