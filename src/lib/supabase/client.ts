"use client";

import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_AUTH_COOKIE } from "./cookieName";

// ブラウザ (Client Component) 用 Supabase クライアント
export function createClient() {
  if (process.env.NEXT_PUBLIC_GCP_AUTH_ENABLED === "true") {
    throw new Error("Browser Supabase access is disabled after the GCP cutover.");
  }
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: { name: SUPABASE_AUTH_COOKIE },
    },
  );
}
