import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { databaseMock, getUser, fetchMock } = vi.hoisted(() => ({
  databaseMock: vi.fn(),
  getUser: vi.fn(),
  fetchMock: vi.fn(),
}));
vi.mock("@/lib/mcp/store", () => ({ database: databaseMock }));
vi.mock("@/lib/mcp/identity", () => ({ verifyMcpIdentity: async (identity: {subject: string;userId:string;householdId:string}, expected?: string) => {
  const user = await getUser(identity.subject);
  if (user.disabled || !user.emailVerified || (expected !== undefined && user.tokensValidAfterTime !== expected)) throw new McpHttpError("ACCESS_DENIED",403,"denied");
  return { client: { fictional: true }, validAfter: user.tokensValidAfterTime };
} }));
import { McpHttpError } from "@/lib/mcp/http";
vi.mock("@/lib/mcp/config", () => ({ mcpConfiguration: () => ({ origin: "https://mfmf.example.test" }) }));

import {
  callbackClient,
  consentAuthorization as consentForIdentity,
  exchangeToken,
  listConnections,
  loadAuthorization,
  MCP_SCOPE,
  mcpResource,
  mcpUnauthorizedResponse,
  oauthErrorResponse,
  readOAuthForm,
  registerOAuthClient,
  requireMcpPrincipal,
  revokeConnection,
  startAuthorization,
} from "@/lib/mcp/oauth";

type Data = Record<string, unknown>;
type User = { uid: string; disabled: boolean; emailVerified: boolean; providerData: { providerId: string }[]; tokensValidAfterTime: string };
type Ref = { path: string; id: string; get: () => Promise<{ data: () => Data | undefined }>; create: (data: Data) => Promise<void>; update: (data: Data) => Promise<void> };
type Write = { operation: "set" | "create" | "update"; ref: Ref; data: Data };
type Tx = { get: (ref: Ref) => Promise<{ data: () => Data | undefined }>; set: (ref: Ref, data: Data) => void; create: (ref: Ref, data: Data) => void; update: (ref: Ref, data: Data) => void };

// This fake preserves Firestore's important boundaries: Date writes become
// Timestamp reads, snapshots are detached, writes commit atomically, and a
// thrown transaction rolls back. The actual OAuth library is never mocked.
function stored(value: unknown): unknown {
  if (value instanceof Date) return Timestamp.fromDate(value);
  if (value instanceof Timestamp) return Timestamp.fromMillis(value.toMillis());
  if (Array.isArray(value)) return value.map(stored);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (entry === undefined) throw new Error("Firestore does not accept undefined");
    return [key, stored(entry)];
  }));
  return value;
}

function memoryFirestore() {
  const documents = new Map<string, Data>();
  let previous: Promise<void> = Promise.resolve();
  const snapshot = (path: string) => {
    const data = documents.get(path);
    return { exists: data !== undefined, data: () => data ? stored(data) as Data : undefined };
  };
  async function runTransaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
    const predecessor = previous;
    let unlock!: () => void;
    previous = new Promise<void>(resolve => { unlock = resolve; });
    await predecessor;
    const writes: Write[] = [];
    const tx: Tx = {
      async get(ref) {
        if (writes.length) throw new Error("Firestore transaction reads must precede writes");
        return snapshot(ref.path);
      },
      set: (ref, data) => { writes.push({ operation: "set", ref, data }); },
      create: (ref, data) => { writes.push({ operation: "create", ref, data }); },
      update: (ref, data) => { writes.push({ operation: "update", ref, data }); },
    };
    try {
      const result = await operation(tx);
      const updated = new Map(documents);
      for (const write of writes) {
        if (write.operation === "create" && updated.has(write.ref.path)) throw new Error("ALREADY_EXISTS");
        if (write.operation === "update" && !updated.has(write.ref.path)) throw new Error("NOT_FOUND");
        updated.set(write.ref.path, stored(write.operation === "update" ? { ...updated.get(write.ref.path), ...write.data } : write.data) as Data);
      }
      documents.clear();
      for (const [path, data] of updated) documents.set(path, data);
      return result;
    } finally { unlock(); }
  }
  const reference = (collection: string, id: string): Ref => {
    const ref: Ref = {
      path: `${collection}/${id}`,
      id,
      async get() { return snapshot(ref.path); },
      async create(data) { await runTransaction(async tx => { tx.create(ref, data); }); },
      async update(data) { await runTransaction(async tx => { tx.update(ref, data); }); },
    };
    return ref;
  };
  const rows = (collection: string) => [...documents].filter(([path]) => path.startsWith(`${collection}/`));
  function query(collection: string, filters: [string, string, unknown][] = [], maximum = 1000) {
    return {
      where: (field: string, comparison: string, value: unknown) => query(collection, [...filters, [field, comparison, value]], maximum),
      limit: (maximum: number) => query(collection, filters, maximum),
      async get() {
        const comparable = (value: unknown) => value instanceof Timestamp ? value.toMillis() : value instanceof Date ? value.getTime() : value;
        return { docs: rows(collection).filter(([, data]) => filters.every(([field, comparison, value]) => {
          if (comparison === "==") return data[field] === value;
          if (comparison === ">") return Number(comparable(data[field])) > Number(comparable(value));
          throw new Error("Unsupported fake query");
        })).slice(0, maximum).map(([path]) => ({ id: path.split("/").at(-1)!, ...snapshot(path) })) };
      },
    };
  }
  return {
    documents,
    rows,
    runTransaction,
    collection(collection: string) {
      return {
        doc: (id: string) => reference(collection, id),
        where: (field: string, comparison: string, value: unknown) => query(collection, [[field, comparison, value]]),
      };
    },
  };
}

const householdId = "92000000-0000-4000-8000-000000000001";
const consentAuthorization = (id: string, uid: string, approved: boolean) => consentForIdentity(id, {subject:uid,userId:uid,householdId}, approved);
const origin = "https://mfmf.example.test";
const redirectUri = "https://claude.ai/api/mcp/auth_callback";
const resource = `${origin}/mcp`;
const initialTime = Date.parse("2026-10-29T00:00:00Z");
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let db: ReturnType<typeof memoryFirestore>;
const users = new Map<string, User>();
const fictionalUser = (uid: string): User => ({ uid, disabled: false, emailVerified: true, providerData: [{ providerId: "google.com" }], tokensValidAfterTime: "Thu, 29 Oct 2026 00:00:00 GMT" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(initialTime);
  vi.stubEnv("MCP_ENABLED", "true");
  db = memoryFirestore();
  databaseMock.mockReset().mockReturnValue(db);
  users.clear();
  users.set("fictional-owner", fictionalUser("fictional-owner"));
  users.set("fictional-other", fictionalUser("fictional-other"));
  getUser.mockReset().mockImplementation(async (uid: string) => {
    const user = users.get(uid);
    if (!user) throw new McpHttpError("ACCESS_DENIED",403,"denied");
    return structuredClone(user);
  });
  fetchMock.mockReset().mockRejectedValue(new Error("Unit tests must not use external services"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function client(method = "none", callback = redirectUri) {
  return registerOAuthClient({ redirect_uris: [callback], token_endpoint_auth_method: method, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: MCP_SCOPE });
}
type Client = Awaited<ReturnType<typeof client>>;
function parameters(registered: Client, overrides: Record<string, string> = {}) {
  return new URLSearchParams({ client_id: registered.client_id, redirect_uri: registered.redirect_uris[0]!, response_type: "code", resource, scope: MCP_SCOPE, state: "fictional-client-state-0123456789", code_challenge: challenge, code_challenge_method: "S256", ...overrides });
}
function request(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`${origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields) });
}
async function authorization(registered: Client, uid = "fictional-owner") {
  const consentUrl = await startAuthorization(parameters(registered));
  const transactionId = new URL(consentUrl).pathname.split("/").at(-1)!;
  const callback = new URL(await consentAuthorization(transactionId, uid, true));
  return { code: callback.searchParams.get("code")!, transactionId, callback };
}
function codeRequest(registered: Client, code: string, changes: Record<string, string> = {}) {
  return request({ grant_type: "authorization_code", client_id: registered.client_id, code, code_verifier: verifier, redirect_uri: registered.redirect_uris[0]!, resource, ...changes });
}
async function connection(uid = "fictional-owner", registered?: Client) {
  const selected = registered ?? await client();
  const auth = await authorization(selected, uid);
  const token = await exchangeToken(codeRequest(selected, auth.code));
  return { registered: selected, ...auth, token };
}
function bearer(token: string, query = "") {
  return new Request(`${resource}${query}`, { headers: { Authorization: `Bearer ${token}`, Cookie: "wkwk_session=fictional-other-session" } });
}
function refresh(registered: Client, refreshToken: string, changes: Record<string, string> = {}) {
  return exchangeToken(request({ grant_type: "refresh_token", client_id: registered.client_id, refresh_token: refreshToken, resource, ...changes }));
}

describe("restricted MCP registration and input boundaries", () => {
  it.each(["https://chatgpt.com/connector/\noauth/fictional", "https://chatgpt.com/connector/oauth/fi\tctional", "https://chatgpt.com\\connector\\oauth\\fictional", "https://chatgpt.com/connector/oauth/fictional "])("rejects callback URL normalization ambiguities: %j", async callback => {
    expect(callbackClient(callback)).toBeNull(); await expect(client("none", callback)).rejects.toBeDefined();
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])("fails closed for corrupt quota counters: %s", async count => {
    await client(); const [path, data] = db.rows("mcpOAuthLimits")[0]!;
    db.documents.set(path, { ...data, count });
    await expect(client()).rejects.toMatchObject({ status: 429 });
  });
  it.each([
    [redirectUri, "Claude"],
    ["https://chatgpt.com/connector_platform_oauth_redirect", "ChatGPT"],
    ["https://chatgpt.com/connector/oauth/fictional_callback-01", "ChatGPT"],
  ])("accepts only documented exact callback shapes: %s", async (callback, expected) => {
    expect(callbackClient(callback)).toBe(expected);
    const registered = await client("none", callback);
    expect(registered.redirect_uris).toEqual([callback]);
    expect(registered.client_name).toBe(expected);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    "http://claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback/", "https://claude.ai.evil.test/api/mcp/auth_callback",
    "https://chatgpt.com.evil.test/connector_platform_oauth_redirect", "https://evil.test/connector_platform_oauth_redirect", "https://chatgpt.com/connector/oauth/", "https://chatgpt.com/connector/oauth/a/b", "https://chatgpt.com/connector/oauth/a%2Fb", "https://chatgpt.com/connector/oauth/a?redirect=evil", "https://chatgpt.com/connector_platform_oauth_redirect#fragment", "https://attacker@chatgpt.com/connector_platform_oauth_redirect", "https://chatgpt.com:8443/connector_platform_oauth_redirect", "https://chatgpt.com/backend-api/aip/oauth/callback",
  ])("rejects lookalike, alternate and ambiguous callbacks: %s", async callback => {
    expect(callbackClient(callback)).toBeNull();
    await expect(client("none", callback)).rejects.toBeDefined();
    expect(db.rows("mcpOAuthClients")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("binds a registered client to one URI and one read-only scope", async () => {
    const registered = await client();
    for (const body of [{ redirect_uris: [redirectUri, "https://chatgpt.com/connector_platform_oauth_redirect"] }, { redirect_uris: [redirectUri], scope: "mfmf.write" }, { redirect_uris: [redirectUri], grant_types: ["client_credentials"] }]) await expect(registerOAuthClient(body)).rejects.toBeDefined();
    await expect(startAuthorization(parameters(registered, { redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" }))).rejects.toBeDefined();
    await expect(startAuthorization(parameters(registered, { scope: "mfmf.read mfmf.write" }))).rejects.toBeDefined();
    expect(db.rows("mcpOAuthRequests")).toHaveLength(0);
  });
  it.each(["client_id", "resource", "redirect_uri", "state", "code_challenge"])("rejects duplicate authorize %s before storing a request", async field => {
    const registered = await client();
    const query = parameters(registered);
    query.append(field, query.get(field)!);
    await expect(startAuthorization(query)).rejects.toBeDefined();
    expect(db.rows("mcpOAuthRequests")).toHaveLength(0);
  });
  it("rejects duplicate form parameters, wrong types, and streamed oversized input", async () => {
    await expect(readOAuthForm(new Request(`${origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "code=one&code=two" }))).rejects.toBeDefined();
    await expect(readOAuthForm(new Request(`${origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))).rejects.toBeDefined();
    await expect(readOAuthForm(new Request(`${origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "x=" + "a".repeat(8192) }))).rejects.toBeDefined();
  });
  it("keeps registration and authorization off unless enabled", async () => {
    vi.stubEnv("MCP_ENABLED", "false");
    await expect(client()).rejects.toMatchObject({ code: "MCP_DISABLED" });
    expect(() => mcpResource()).toThrow();
    expect(databaseMock).not.toHaveBeenCalled();
  });
});

describe("real library authorization-code and PKCE flow", () => {
  it("passes a native Request through consent, code exchange and principal resolution", async () => {
    const connected = await connection();
    expect(connected.callback.origin + connected.callback.pathname).toBe(redirectUri);
    expect(connected.callback.searchParams.get("state")).toBe("fictional-client-state-0123456789");
    expect(connected.callback.searchParams.get("iss")).toBe(origin);
    expect(await loadAuthorization(connected.transactionId)).toBeNull();
    expect(await requireMcpPrincipal(bearer(connected.token.access_token))).toMatchObject({ userId: "fictional-owner", householdId });
    expect(connected.token).toMatchObject({ token_type: "Bearer", expires_in: 600, scope: MCP_SCOPE });
    expect(Object.keys(connected.token).sort()).toEqual(["access_token", "expires_in", "refresh_token", "scope", "token_type"]);
    const serialized = JSON.stringify(connected.token);
    for (const value of ["fictional-owner", connected.code, connected.transactionId, "authorizationCode", "grantId", "clientId", "validAfter"]) expect(serialized).not.toContain(value);
  });
  it("denial consumes consent once and returns issuer identification without issuing a code", async () => {
    const registered = await client();
    const consent = new URL(await startAuthorization(parameters(registered))).pathname.split("/").at(-1)!;
    const callback = new URL(await consentAuthorization(consent, "fictional-owner", false));
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("iss")).toBe(origin);
    expect(callback.searchParams.has("code")).toBe(false);
    await expect(consentAuthorization(consent, "fictional-owner", true)).rejects.toBeDefined();
    expect(db.rows("mcpOAuthGrants")).toHaveLength(0);
  });
  it.each([{ code_challenge_method: "plain" }, { code_challenge: "" }, { code_challenge_method: "" }])("rejects PKCE omission or downgrade at authorization: %j", async changes => {
    const registered = await client();
    await expect(startAuthorization(parameters(registered, Object.fromEntries(Object.entries(changes).filter(([, value]) => typeof value === "string"))))).rejects.toBeDefined();
    expect(db.rows("mcpOAuthRequests")).toHaveLength(0);
  });
  it.each(["", "wrong-verifier".padEnd(43, "x")])("consumes codes even when PKCE verification fails: %j", async wrongVerifier => {
    const registered = await client();
    const { code } = await authorization(registered);
    await expect(exchangeToken(codeRequest(registered, code, { code_verifier: wrongVerifier }))).rejects.toBeDefined();
    await expect(exchangeToken(codeRequest(registered, code))).rejects.toBeDefined();
    expect(db.rows("mcpOAuthAccess")).toHaveLength(0);
    expect(db.rows("mcpOAuthCodes")[0]![1].consumed).toBe(true);
  });
  it("rejects code replay and revokes the already-issued connection family", async () => {
    const connected = await connection();
    await expect(exchangeToken(codeRequest(connected.registered, connected.code))).rejects.toBeDefined();
    await expect(requireMcpPrincipal(bearer(connected.token.access_token))).rejects.toBeDefined();
    await expect(refresh(connected.registered, connected.token.refresh_token!)).rejects.toBeDefined();
  });
  it("does not let concurrent exchanges issue multiple tokens", async () => {
    const registered = await client();
    const { code } = await authorization(registered);
    const results = await Promise.allSettled([exchangeToken(codeRequest(registered, code)), exchangeToken(codeRequest(registered, code))]);
    expect(results.filter(result => result.status === "fulfilled").length).toBeLessThanOrEqual(1);
    expect(results.some(result => result.status === "rejected")).toBe(true);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ name: "invalid_grant" });
    expect(db.rows("mcpOAuthAccess").length).toBeLessThanOrEqual(1);
  });
  it("rejects another resource, redirect and client without redeeming a valid code", async () => {
    const registered = await client();
    const otherClient = await client();
    const { code } = await authorization(registered);
    await expect(startAuthorization(parameters(registered, { resource: "https://mnmn.example.test/mcp" }))).rejects.toBeDefined();
    await expect(exchangeToken(codeRequest(registered, code, { resource: "https://mnmn.example.test/mcp" }))).rejects.toBeDefined();
    await expect(exchangeToken(codeRequest(otherClient, code))).rejects.toBeDefined();
    const token = await exchangeToken(codeRequest(registered, code));
    expect(await requireMcpPrincipal(bearer(token.access_token))).toMatchObject({ userId: "fictional-owner", householdId });
    const fresh = await authorization(registered);
    await expect(exchangeToken(codeRequest(registered, fresh.code, { redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" }))).rejects.toBeDefined();
  });
  it("expires consent and short-lived codes using Timestamp records", async () => {
    const registered = await client();
    const consent = new URL(await startAuthorization(parameters(registered))).pathname.split("/").at(-1)!;
    expect(db.rows("mcpOAuthRequests")[0]![1].expiresAt).toBeInstanceOf(Timestamp);
    vi.setSystemTime(initialTime + 600_001);
    expect(await loadAuthorization(consent)).toBeNull();
    await expect(consentAuthorization(consent, "fictional-owner", true)).rejects.toBeDefined();
    const { code } = await authorization(registered);
    vi.setSystemTime(initialTime + 720_002);
    await expect(exchangeToken(codeRequest(registered, code))).rejects.toBeDefined();
  });
  it.each(["missing", "invalid", "at-deadline"])("rejects an authorization code with a %s deadline even while its grant is valid", async deadline => {
    const registered = await client();
    const { code } = await authorization(registered);
    const path = `mcpOAuthCodes/${hash(code)}`;
    const changed = { ...db.documents.get(path)! };
    if (deadline === "missing") delete changed.expiresAt;
    else changed.expiresAt = deadline === "invalid" ? "invalid-stored-deadline" : Timestamp.fromMillis(Date.now());
    db.documents.set(path, changed);
    const grant = db.rows("mcpOAuthGrants")[0]![1];
    expect(grant.revoked).toBe(false);
    expect((grant.expiresAt as Timestamp).toMillis()).toBeGreaterThan(Date.now());
    await expect(exchangeToken(codeRequest(registered, code))).rejects.toMatchObject({ name: "invalid_grant" });
    expect(db.rows("mcpOAuthAccess")).toHaveLength(0);
    expect(db.rows("mcpOAuthRefresh")).toHaveLength(0);
  });
});

describe("client authentication and opaque storage", () => {
  it.each(["client_secret_post", "client_secret_basic"])("requires the right confidential secret and authentication method: %s", async method => {
    const registered = await client(method);
    const { code } = await authorization(registered);
    await expect(exchangeToken(codeRequest(registered, code))).rejects.toBeDefined();
    await expect(exchangeToken(codeRequest(registered, code, { client_secret: "fictional-wrong-secret" }))).rejects.toBeDefined();
    let token;
    if (method === "client_secret_basic") {
      await expect(exchangeToken(codeRequest(registered, code, { client_secret: registered.client_secret! }))).rejects.toBeDefined();
      const basic = Buffer.from(`${registered.client_id}:${registered.client_secret}`).toString("base64");
      token = await exchangeToken(request({ grant_type: "authorization_code", client_id: registered.client_id, code, code_verifier: verifier, redirect_uri: redirectUri, resource }, { Authorization: `Basic ${basic}` }));
    } else token = await exchangeToken(codeRequest(registered, code, { client_secret: registered.client_secret! }));
    expect(await requireMcpPrincipal(bearer(token.access_token))).toMatchObject({ userId: "fictional-owner", householdId });
  });
  it("never persists raw codes, access/refresh tokens, confidential secrets or consent handles", async () => {
    const registered = await client("client_secret_post");
    const auth = await authorization(registered);
    const token = await exchangeToken(codeRequest(registered, auth.code, { client_secret: registered.client_secret! }));
    const serialized = JSON.stringify([...db.documents]);
    for (const raw of [registered.client_secret!, auth.code, auth.transactionId, token.access_token, token.refresh_token!]) expect(serialized).not.toContain(raw);
    expect(db.documents.has(`mcpOAuthCodes/${hash(auth.code)}`)).toBe(true);
    expect(db.documents.has(`mcpOAuthAccess/${hash(token.access_token)}`)).toBe(true);
    expect(db.documents.has(`mcpOAuthRefresh/${hash(token.refresh_token!)}`)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("refresh families, live identity checks and user isolation", () => {
  it("rotates refresh tokens and revokes every descendant when an old token is reused", async () => {
    const connected = await connection();
    const rotated = await refresh(connected.registered, connected.token.refresh_token!);
    expect(rotated.refresh_token).not.toBe(connected.token.refresh_token);
    expect(await requireMcpPrincipal(bearer(rotated.access_token))).toMatchObject({ userId: "fictional-owner", householdId });
    await expect(refresh(connected.registered, connected.token.refresh_token!)).rejects.toBeDefined();
    for (const access of [connected.token.access_token, rotated.access_token]) await expect(requireMcpPrincipal(bearer(access))).rejects.toBeDefined();
    await expect(refresh(connected.registered, rotated.refresh_token!)).rejects.toBeDefined();
  });
  it("does not let concurrent refreshes issue multiple descendants", async () => {
    const connected = await connection();
    const results = await Promise.allSettled([refresh(connected.registered, connected.token.refresh_token!), refresh(connected.registered, connected.token.refresh_token!)]);
    expect(results.filter(result => result.status === "fulfilled").length).toBeLessThanOrEqual(1);
    expect(results.some(result => result.status === "rejected")).toBe(true);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ name: "invalid_grant" });
    expect(db.rows("mcpOAuthAccess").length).toBeLessThanOrEqual(2);
    for (const result of results) if (result.status === "fulfilled") await expect(requireMcpPrincipal(bearer(result.value.access_token))).rejects.toBeDefined();
  });
  it("rejects refresh scope expansion and a different resource", async () => {
    const connected = await connection();
    await expect(refresh(connected.registered, connected.token.refresh_token!, { scope: "mfmf.read mfmf.write" })).rejects.toBeDefined();
    await expect(refresh(connected.registered, connected.token.refresh_token!, { resource: "https://wkwk.example.test/mcp" })).rejects.toBeDefined();
    expect((await refresh(connected.registered, connected.token.refresh_token!)).scope).toBe(MCP_SCOPE);
  });
  it.each(["missing", "invalid", "at-deadline"])("rejects a refresh token with a %s deadline independently of the connection's deadline", async deadline => {
    const connected = await connection();
    const path = `mcpOAuthRefresh/${hash(connected.token.refresh_token!)}`;
    const changed = { ...db.documents.get(path)! };
    if (deadline === "missing") delete changed.expiresAt;
    else changed.expiresAt = deadline === "invalid" ? "invalid-stored-deadline" : Timestamp.fromMillis(Date.now());
    db.documents.set(path, changed);
    await expect(refresh(connected.registered, connected.token.refresh_token!)).rejects.toMatchObject({ name: "invalid_grant" });
    expect(db.rows("mcpOAuthAccess")).toHaveLength(1);
    expect(db.rows("mcpOAuthRefresh")).toHaveLength(1);
    // The original access token is still valid, so the rejection above must
    // come from the refresh token deadline, not the overall grant deadline.
    expect(await requireMcpPrincipal(bearer(connected.token.access_token))).toMatchObject({ userId: "fictional-owner", householdId });
  });
  it.each(["disabled", "revoked", "unverified", "deleted"])("rechecks Firebase before both reading and refreshing: %s", async reason => {
    const connected = await connection();
    const user = users.get("fictional-owner")!;
    if (reason === "disabled") user.disabled = true;
    if (reason === "revoked") user.tokensValidAfterTime = "Thu, 29 Oct 2026 00:01:00 GMT";
    if (reason === "unverified") user.emailVerified = false;
    if (reason === "not-google") user.providerData = [{ providerId: "password" }];
    if (reason === "deleted") users.delete(user.uid);
    await expect(requireMcpPrincipal(bearer(connected.token.access_token))).rejects.toBeDefined();
    await expect(refresh(connected.registered, connected.token.refresh_token!)).rejects.toBeDefined();
  });
  it("rejects a disabled account at consent before creating a grant", async () => {
    const registered = await client();
    users.get("fictional-owner")!.disabled = true;
    await expect(authorization(registered)).rejects.toBeDefined();
    expect(db.rows("mcpOAuthGrants")).toHaveLength(0);
  });
  it("derives each UID only from its token and isolates connection listing/revocation", async () => {
    const registered = await client();
    const first = await connection("fictional-owner", registered);
    const second = await connection("fictional-other", registered);
    expect(await requireMcpPrincipal(bearer(first.token.access_token, "?uid=fictional-other"))).toMatchObject({ userId: "fictional-owner", householdId });
    expect(await requireMcpPrincipal(bearer(second.token.access_token))).toMatchObject({ userId: "fictional-other", householdId });
    const own = await listConnections("fictional-owner");
    const other = await listConnections("fictional-other");
    expect(own).toHaveLength(1); expect(other).toHaveLength(1);
    expect(own[0]!.id).not.toBe(other[0]!.id);
    await expect(revokeConnection("fictional-other", own[0]!.id)).rejects.toMatchObject({ status: 403 });
    await revokeConnection("fictional-owner", own[0]!.id);
    await expect(requireMcpPrincipal(bearer(first.token.access_token))).rejects.toBeDefined();
    expect(await requireMcpPrincipal(bearer(second.token.access_token))).toMatchObject({ userId: "fictional-other", householdId });
  });
  it("rejects browser cookies, query tokens and other-app token formats as MCP credentials", async () => {
    const connected = await connection();
    for (const incoming of [new Request(resource, { headers: { Cookie: "wkwk_session=fake-session" } }), new Request(`${resource}?access_token=${connected.token.access_token}`), new Request(resource, { headers: { Authorization: "Bearer fictional-firebase-id-token" } })]) await expect(requireMcpPrincipal(incoming)).rejects.toBeDefined();
  });
  it("expires access tokens, permits a bounded refresh, and stops the connection after 30 days", async () => {
    const connected = await connection();
    vi.setSystemTime(initialTime + 600_001);
    await expect(requireMcpPrincipal(bearer(connected.token.access_token))).rejects.toBeDefined();
    const rotated = await refresh(connected.registered, connected.token.refresh_token!);
    expect(await requireMcpPrincipal(bearer(rotated.access_token))).toMatchObject({ userId: "fictional-owner", householdId });
    vi.setSystemTime(initialTime + 30 * 86400_000 + 1);
    await expect(refresh(connected.registered, rotated.refresh_token!)).rejects.toBeDefined();
    expect(await listConnections("fictional-owner")).toHaveLength(0);
  });
  it.each(["mcpOAuthAccess", "mcpOAuthGrants"])("fails closed if an existing %s record loses its expiry", async collection => {
    const connected = await connection();
    const [path, data] = db.rows(collection)[0]!;
    const changed = { ...data };
    delete changed.expiresAt;
    db.documents.set(path, changed);
    await expect(requireMcpPrincipal(bearer(connected.token.access_token))).rejects.toBeDefined();
  });
  it("does not allow consent for a request with an invalid stored deadline", async () => {
    const registered = await client();
    const consent = new URL(await startAuthorization(parameters(registered))).pathname.split("/").at(-1)!;
    const [path, data] = db.rows("mcpOAuthRequests")[0]!;
    db.documents.set(path, { ...data, expiresAt: "invalid-stored-deadline" });
    expect(await loadAuthorization(consent)).toBeNull();
    await expect(consentAuthorization(consent, "fictional-owner", true)).rejects.toBeDefined();
  });
  it("returns a non-cacheable auth challenge without exposing internal errors", async () => {
    let error: unknown;
    try { await requireMcpPrincipal(new Request(resource)); } catch (caught) { error = caught; }
    const response = mcpUnauthorizedResponse(error);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("www-authenticate")).toContain(`${origin}/.well-known/oauth-protected-resource/mcp`);
    expect(await response.json()).toEqual({ error: "invalid_token" });
    const failed = oauthErrorResponse(new Error("fictional-private-provider-error"));
    expect(failed.headers.get("cache-control")).toContain("no-store");
    expect(await failed.text()).not.toContain("fictional-private-provider-error");
  });
});
