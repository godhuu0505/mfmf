import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// サーバー (Server Component / Server Action / Route Handler) 用 Supabase クライアント
// Cookie ベースのセッションを @supabase/ssr で扱う。
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Component から呼ばれた場合は set 不可。
            // middleware でセッション更新するため無視して問題ない。
          }
        },
      },
    },
  );
}
