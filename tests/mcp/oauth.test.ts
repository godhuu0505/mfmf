import { createHash, randomUUID, generateKeyPairSync } from "node:crypto";
import { initializeApp, deleteApp, cert, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ database: vi.fn(), getUser: vi.fn() }));
vi.mock("@/lib/mcp/store", () => ({ database: mocks.database }));
vi.mock("@/lib/mcp/identity", () => ({ verifyMcpIdentity: async (identity: {subject:string}, expected?:string) => {
 const user = await mocks.getUser(identity.subject);
 if (user.disabled || !user.emailVerified || (expected !== undefined && user.tokensValidAfterTime !== expected)) throw new McpHttpError("ACCESS_DENIED",403,"denied");
 return { client: {}, validAfter: user.tokensValidAfterTime };
} }));
import { McpHttpError } from "@/lib/mcp/http";
vi.mock("@/lib/mcp/config", () => ({ mcpConfiguration: () => ({ origin: "https://mfmf.example.test" }) }));
import { consentAuthorization as consentForIdentity, exchangeToken, listConnections, registerOAuthClient, requireMcpPrincipal, revokeConnection, startAuthorization } from "@/lib/mcp/oauth";
const householdId = "92000000-0000-4000-8000-000000000001";
const consentAuthorization = (id:string,uid:string,approved:boolean) => consentForIdentity(id,{subject:uid,userId:uid,householdId},approved);
const origin = "https://mfmf.example.test";
const resource = `${origin}/mcp`;
const callback = "https://claude.ai/api/mcp/auth_callback";
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
let app: App;
let db: Firestore;
function form(fields: Record<string,string>) { return new Request(`${origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) }); }
const bearer = (token: string) => new Request(resource, { headers: { Authorization: `Bearer ${token}` } });
async function authorized(uid = "fictional-owner") {
  const client = await registerOAuthClient({ redirect_uris: [callback], token_endpoint_auth_method: "none" });
  const url = await startAuthorization(new URLSearchParams({ client_id: client.client_id, redirect_uri: callback, response_type: "code", resource, scope: "mfmf.read", state: "fictional-state-0123456789", code_challenge: challenge, code_challenge_method: "S256" }));
  const id = new URL(url).pathname.split("/").at(-1)!;
  const code = new URL(await consentAuthorization(id, uid, true)).searchParams.get("code")!;
  return { client, code, request: () => form({ client_id: client.client_id, grant_type: "authorization_code", redirect_uri: callback, resource, code, code_verifier: verifier }) };
}
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Loopback Firestore emulator required");
  // A fresh synthetic certificate prevents reading any developer ADC file.
  // The SDK's emulator path uses its built-in owner header over loopback only.
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  app = initializeApp({ projectId: "demo-mfmf-mcp", credential: cert({ projectId: "demo-mfmf-mcp", clientEmail: "fictional@example.test", privateKey }) }, `mcp-oauth-${randomUUID()}`);
  db = getFirestore(app, "mfmf-mcp");
  mocks.database.mockReturnValue(db);
  vi.stubEnv("MCP_ENABLED", "true");
});
beforeEach(async () => {
  for (const name of ["Clients", "Requests", "Codes", "Grants", "Access", "Refresh", "Limits"]) await db.recursiveDelete(db.collection(`mcpOAuth${name}`));
  mocks.getUser.mockImplementation(async (uid: string) => ({ uid, disabled: false, emailVerified: true, providerData: [{ providerId: "google.com" }], tokensValidAfterTime: "Thu, 29 Oct 2026 00:00:00 GMT" }));
});
afterAll(async () => { vi.unstubAllEnvs(); if (db) await db.terminate(); if (app) await deleteApp(app); });
describe("real Firestore OAuth atomicity and per-user connection control", () => {
  it("denies anonymous browser reads and writes in the named database", async () => {
    const endpoint = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-mfmf-mcp/databases/mfmf-mcp/documents/mcpOAuthGrants/fictional`;
    expect((await fetch(endpoint)).status).toBe(403);
    expect((await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: { uid: { stringValue: "fictional-attacker" } } }) })).status).toBe(403);
  });
  it("rejects tampered or missing grant deadlines independently of token expiry", async () => {
    const authorization = await authorized(); const token = await exchangeToken(authorization.request());
    const [grant] = (await db.collection("mcpOAuthGrants").get()).docs;
    const data = grant.data(); delete data.expiresAt; await grant.ref.set(data);
    await expect(requireMcpPrincipal(bearer(token.access_token))).rejects.toBeDefined();
    await expect(exchangeToken(form({ client_id: authorization.client.client_id, grant_type: "refresh_token", refresh_token: token.refresh_token!, resource }))).rejects.toBeDefined();
  });
  it("runs a real code flow, lists only own connections and revokes immediately", async () => {
    const authorization = await authorized();
    const token = await exchangeToken(authorization.request());
    expect(await requireMcpPrincipal(bearer(token.access_token))).toMatchObject({ userId: "fictional-owner", householdId });
    expect(await listConnections("fictional-other")).toEqual([]);
    const connections = await listConnections("fictional-owner");
    expect(connections).toHaveLength(1);
    await expect(revokeConnection("fictional-other", connections[0]!.id)).rejects.toMatchObject({ status: 403 });
    await revokeConnection("fictional-owner", connections[0]!.id);
    await expect(requireMcpPrincipal(bearer(token.access_token))).rejects.toBeDefined();
    expect(await listConnections("fictional-owner")).toEqual([]);
  });
  it("allows at most one parallel code exchange and fails closed on reuse", async () => {
    const authorization = await authorized();
    const results = await Promise.allSettled([exchangeToken(authorization.request()), exchangeToken(authorization.request())]);
    expect(results.filter(result => result.status === "fulfilled").length).toBeLessThanOrEqual(1);
    expect(results.some(result => result.status === "rejected")).toBe(true);
    expect((await db.collection("mcpOAuthAccess").get()).size).toBeLessThanOrEqual(1);
    for (const result of results) if (result.status === "fulfilled") await expect(requireMcpPrincipal(bearer(result.value.access_token))).rejects.toBeDefined();
  });
  it("rotates refresh tokens atomically and revokes the family on a replay", async () => {
    const authorization = await authorized();
    const token = await exchangeToken(authorization.request());
    const refresh = () => form({ client_id: authorization.client.client_id, grant_type: "refresh_token", refresh_token: token.refresh_token!, resource });
    const next = await exchangeToken(refresh());
    expect(next.refresh_token).not.toBe(token.refresh_token);
    expect(await requireMcpPrincipal(bearer(next.access_token))).toMatchObject({ userId: "fictional-owner", householdId });
    await expect(exchangeToken(refresh())).rejects.toBeDefined();
    await expect(requireMcpPrincipal(bearer(next.access_token))).rejects.toBeDefined();
  });
  it("lists live connections even after more than 100 old records", async () => {
    const batch = db.batch();
    for (let i = 0; i < 110; i++) batch.set(db.collection("mcpOAuthGrants").doc(`old-${i}`), { uid: "fictional-owner", revoked: true, expiresAt: new Date(Date.now() + 86400_000) });
    await batch.commit();
    const authorization = await authorized();
    await exchangeToken(authorization.request());
    expect(await listConnections("fictional-owner")).toHaveLength(1);
  });
});
