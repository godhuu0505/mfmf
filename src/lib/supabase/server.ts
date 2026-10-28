import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { SUPABASE_AUTH_COOKIE } from "./cookieName";
import { AuthError } from "@supabase/supabase-js";
import { isGcpAuthEnabled } from "@/lib/identity/config";

// サーバー (Server Component / Server Action / Route Handler) 用 Supabase クライアント
// Cookie ベースのセッションを @supabase/ssr で扱う。
export async function createClient() {
  if (isGcpAuthEnabled()) {
    const [{ getVerifiedIdentity, getIdentityProtocol }, { createGcpDataClient }] = await Promise.all([
      import("@/lib/identity/server"), import("@/lib/gcp/dataClient"),
    ]);
    const { client, user } = await createGcpDataClient(await getVerifiedIdentity());
    client.auth.getUser = (async () => ({ data: { user }, error: null })) as typeof client.auth.getUser;
    client.auth.updateUser = (async (attributes) => {
      if (!user || !attributes.password || Object.keys(attributes).some((key) => key !== "password")) {
        return { data: { user: null }, error: new AuthError("Unsupported identity update") };
      }
      try { await (await getIdentityProtocol()).updatePassword(attributes.password); return { data: { user }, error: null }; }
      catch { return { data: { user: null }, error: new AuthError("認証を確認できません。ログインし直してください。") }; }
    }) as typeof client.auth.updateUser;
    client.auth.signOut = async () => {
      try { await (await getIdentityProtocol()).signout(); return { error: null }; }
      catch { return { error: new AuthError("Sign out failed; details withheld") }; }
    };
    return client;
  }
  const cookieStore = await cookies();

  return createServerClient(
    process.env.SUPABASE_INTERNAL_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: { name: SUPABASE_AUTH_COOKIE },
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
