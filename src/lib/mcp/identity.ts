import "server-only";
import { createGcpDataClient } from "@/lib/gcp/dataClient";
import { getIdentityAdminAuth, getVerifiedIdentity } from "@/lib/identity/server";
import { McpHttpError } from "./http";
import { mcpConfiguration } from "./config";

export type McpIdentity = { subject: string; userId: string; householdId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const roles = ["owner", "editor", "viewer"];
const denied = () => new McpHttpError("ACCESS_DENIED", 403, "接続先の家族へのアクセス権がありません。");

/** Presentation only: legacy household names may be empty or contain line breaks. */
export function mcpHouseholdLabel(name: unknown): string {
  if (typeof name !== "string") return "名前未設定の家族";
  return name.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 120) || "名前未設定の家族";
}

/** Never accept an account label from an OAuth client or a browser payload. */
export function mcpAccountLabel(identity: { email?: string | null; emailVerified?: boolean }): string {
  const email = identity.email;
  return identity.emailVerified === true && typeof email === "string" && email.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) && !/[\u0000-\u001f\u007f]/u.test(email)
    ? email : "ログイン中のmfmfアカウント";
}

/** No token, browser UID, role or cookie can become a DB principal here. */
export async function verifyMcpIdentity(identity: McpIdentity, expectedValidAfter?: string) {
  mcpConfiguration();
  if (!identity || typeof identity.subject !== "string" || !identity.subject || identity.subject.length > 128 || /[\u0000-\u001f\u007f]/u.test(identity.subject) || !uuid.test(identity.userId) || !uuid.test(identity.householdId)) throw denied();
  const account = await getIdentityAdminAuth().getUser(identity.subject).catch(error => {
    if (error && typeof error === "object" && error.code === "auth/user-not-found") throw denied();
    throw error;
  });
  if (account.uid !== identity.subject || account.disabled || !account.emailVerified || !account.email ||
      (expectedValidAfter !== undefined && (account.tokensValidAfterTime ?? "") !== expectedValidAfter)) throw denied();
  const { client, user } = await createGcpDataClient({ subject: account.uid, email: account.email, emailVerified: true }, { allowCreate: false });
  if (user?.id !== identity.userId) throw denied();
  const { data, error } = await client.from("household_members").select("role")
    .eq("user_id", identity.userId).eq("household_id", identity.householdId).maybeSingle();
  if (error || !data || !roles.includes(data.role)) throw denied();
  return { client, validAfter: account.tokensValidAfterTime ?? "" };
}

/** Browser consent uses the existing verified session and self-membership RLS. */
export async function getMcpBrowserContext() {
  mcpConfiguration();
  const identity = await getVerifiedIdentity();
  if (!identity) return null;
  const { client, user } = await createGcpDataClient(identity, { allowCreate: false });
  if (!user) return null;
  const { data, error } = await client.from("household_members")
    .select("household_id, role, households(name)").eq("user_id", user.id).order("created_at").limit(101);
  if (error || !data || data.length > 100) throw denied();
  return { subject: identity.subject, userId: user.id, accountLabel: mcpAccountLabel(identity), households: data.filter(row => roles.includes(row.role)).map(row => ({ householdId: row.household_id as string,
    householdName: mcpHouseholdLabel((row.households as unknown as { name?: string } | null)?.name), role: row.role as "owner" | "editor" | "viewer" })) };
}
