import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import OAuth2Server from "@node-oauth/oauth2-server";
import { Timestamp, type DocumentData } from "firebase-admin/firestore";
import { database } from "./store";
import { mcpConfiguration } from "./config";
import { verifyMcpIdentity, type McpIdentity } from "./identity";
import { McpHttpError as AppError } from "./http";
import { json } from "./http";
import { ZodError } from "zod";

export const MCP_SCOPE = "mfmf.read";
const MAX_CONNECTION_MS = 30 * 86400_000;
const opaque = () => randomBytes(32).toString("base64url");
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const millis = (value: unknown): number => {
  const result = value instanceof Timestamp
    ? value.toMillis()
    : value instanceof Date
      ? value.getTime()
      : NaN;
  return Number.isFinite(result) ? result : -Infinity;
};
const ref = (collection: string, id: string) =>
  database().collection(`mcpOAuth${collection}`).doc(id);
export function mcpOrigin() {
  if (process.env.MCP_ENABLED !== "true")
    throw new AppError("MCP_DISABLED", 503, "AIとの接続は準備中です。");
  return mcpConfiguration().origin;
}
export const mcpResource = () => `${mcpOrigin()}/mcp`;
function invalid(name = "invalid_request"): never {
  throw new OAuth2Server.OAuthError("OAuth request rejected", {
    name,
    code: 400,
  });
}
const safeEqual = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// No URL is fetched during registration. These providers own the only allowed
// callbacks; each registered client is subsequently bound to its exact URI.
export function callbackClient(uri: string): string | null {
  if (/[\u0000-\u0020\u007f\\]/u.test(uri)) return null;
  if (uri === "https://claude.ai/api/mcp/auth_callback") return "Claude";
  try {
    const url = new URL(uri);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return null;
    if (
      url.origin === "https://chatgpt.com" &&
      (url.pathname === "/connector_platform_oauth_redirect" ||
        /^\/connector\/oauth\/[A-Za-z0-9_-]{1,160}$/.test(url.pathname))
    )
      return "ChatGPT";
  } catch {
    /* reject */
  }
  return null;
}

export async function oauthQuota(
  key: string,
  maximum: number,
  windowMs = 86400_000,
) {
  const bucket = Math.floor(Date.now() / windowMs);
  const doc = ref("Limits", `${digest(key)}-${bucket}`);
  await database().runTransaction(async (tx) => {
    const old = await tx.get(doc);
    const count = Number(old.data()?.count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0 || count >= maximum)
      throw new AppError(
        "RATE_LIMIT",
        429,
        "接続の回数が上限に達しました。時間をおいてお試しください。",
      );
    tx.set(doc, {
      count: count + 1,
      expiresAt: new Date((bucket + 2) * windowMs),
    });
  });
}

export async function registerOAuthClient(body: Record<string, unknown>) {
  mcpOrigin();
  if (
    !Array.isArray(body.redirect_uris) ||
    body.redirect_uris.length !== 1 ||
    typeof body.redirect_uris[0] !== "string"
  )
    invalid("invalid_client_metadata");
  const redirectUri = body.redirect_uris[0] as string;
  const clientName = callbackClient(redirectUri);
  if (!clientName) invalid("invalid_redirect_uri");
  const method = body.token_endpoint_auth_method ?? "none";
  if (
    !["none", "client_secret_post", "client_secret_basic"].includes(
      String(method),
    )
  )
    invalid("invalid_client_metadata");
  if (
    body.grant_types !== undefined &&
    (!Array.isArray(body.grant_types) ||
      body.grant_types.some(
        (v) => !["authorization_code", "refresh_token"].includes(v),
      ))
  )
    invalid("invalid_client_metadata");
  if (
    body.response_types !== undefined &&
    JSON.stringify(body.response_types) !== '["code"]'
  )
    invalid("invalid_client_metadata");
  if (body.scope !== undefined && body.scope !== MCP_SCOPE)
    invalid("invalid_scope");
  await oauthQuota("registration", 100);
  const clientId = `mfc_${opaque()}`;
  const secret = method === "none" ? null : `mfs_${opaque()}`;
  await ref("Clients", clientId).create({
    clientName,
    redirectUri,
    method,
    secretHash: secret ? digest(secret) : null,
    createdAt: new Date(),
  });
  return {
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clientName,
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: method,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: MCP_SCOPE,
  };
}

function uniqueParams(params: URLSearchParams) {
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in result || key.length > 64 || value.length > 2048) invalid();
    result[key] = value;
  }
  return result;
}
export async function startAuthorization(params: URLSearchParams) {
  mcpOrigin();
  const query = uniqueParams(params);
  if (!/^mfc_[\w-]{43}$/.test(query.client_id ?? "")) invalid("invalid_client");
  const client = (await ref("Clients", query.client_id!).get()).data();
  if (
    !client ||
    query.redirect_uri !== client.redirectUri ||
    !callbackClient(query.redirect_uri ?? "")
  )
    invalid("invalid_client");
  if (
    query.response_type !== "code" ||
    query.resource !== mcpResource() ||
    (query.scope !== undefined && query.scope !== MCP_SCOPE)
  )
    invalid();
  if (
    query.code_challenge_method !== "S256" ||
    !/^[\w-]{43}$/.test(query.code_challenge ?? "") ||
    !/^[\x21-\x7e]{16,512}$/.test(query.state ?? "")
  )
    invalid();
  query.scope = MCP_SCOPE;
  await oauthQuota("authorization", 500);
  const id = opaque();
  await ref("Requests", digest(id)).create({
    query,
    clientName: client.clientName,
    expiresAt: new Date(Date.now() + 600_000),
    used: false,
  });
  return `${mcpOrigin()}/oauth/consent/${id}`;
}
export async function loadAuthorization(
  id: string,
): Promise<{ clientName: string; clientId: string } | null> {
  mcpOrigin();
  if (!/^[\w-]{43}$/.test(id)) return null;
  const data = (await ref("Requests", digest(id)).get()).data();
  if (!data || data.used || millis(data.expiresAt) <= Date.now()) return null;
  return { clientName: data.clientName, clientId: data.query.client_id };
}

async function validGrant(grantId: string, clientId?: string): Promise<DocumentData & { verified: Awaited<ReturnType<typeof verifyMcpIdentity>> }> {
  if (!/^[\w-]{43}$/.test(grantId)) invalid("invalid_grant");
  const data = (await ref("Grants", grantId).get()).data();
  if (
    !data ||
    data.revoked ||
    millis(data.expiresAt) <= Date.now() ||
    data.resource !== mcpResource() ||
    data.scope !== MCP_SCOPE ||
    typeof data.validAfter !== "string" ||
    (clientId && data.clientId !== clientId)
  )
    invalid("invalid_grant");
  let verified: Awaited<ReturnType<typeof verifyMcpIdentity>>;
  try { verified = await verifyMcpIdentity({ subject: data.subject, userId: data.uid, householdId: data.householdId }, data.validAfter); }
  catch (error) { if (error instanceof AppError && error.status === 403) invalid("invalid_grant"); throw error; }
  return { ...data, verified };
}

type Context = {
  stage: "authorize" | "token";
  clientId?: string;
  authMethod?: string;
  transactionId?: string;
  grantId?: string;
};
function server(context: Context) {
  const model: OAuth2Server.AuthorizationCodeModel &
    OAuth2Server.RefreshTokenModel = {
    async getClient(id, secret) {
      if (!/^mfc_[\w-]{43}$/.test(id)) return false;
      const data = (await ref("Clients", id).get()).data();
      if (!data || !callbackClient(data.redirectUri)) return false;
      if (context.stage === "token") {
        if (id !== context.clientId || context.authMethod !== data.method)
          return false;
        if (
          data.method === "none"
            ? !!secret
            : !secret || !safeEqual(digest(secret), data.secretHash)
        )
          return false;
      }
      return {
        id,
        grants: ["authorization_code", "refresh_token"],
        redirectUris: [data.redirectUri],
        clientName: data.clientName,
      };
    },
    async getAccessToken() {
      return false;
    },
    async generateAuthorizationCode() {
      return `mfo_${opaque()}`;
    },
    async generateAccessToken() {
      return `mfa_${opaque()}`;
    },
    async generateRefreshToken() {
      return `mfr_${opaque()}`;
    },
    async validateScope(_user, _client, scope) {
      return scope?.length === 1 && scope[0] === MCP_SCOPE ? scope : false;
    },
    async saveAuthorizationCode(code, client, user) {
      const grantId = opaque();
      const current = await verifyMcpIdentity({ subject: user.subject, userId: user.uid, householdId: user.householdId });
      const { authorizationCode, ...stored } = code;
      await database().runTransaction(async (tx) => {
        const requestRef = ref("Requests", digest(context.transactionId!));
        const request = (await tx.get(requestRef)).data();
        if (
          !request ||
          request.used ||
          millis(request.expiresAt) <= Date.now() ||
          request.query.client_id !== client.id
        )
          invalid("invalid_grant");
        tx.update(requestRef, { used: true });
        tx.create(ref("Grants", grantId), {
          uid: user.uid,
          clientId: client.id,
          clientName: client.clientName,
          resource: mcpResource(),
          scope: MCP_SCOPE,
          validAfter: current.validAfter,
          subject: user.subject,
          householdId: user.householdId,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + MAX_CONNECTION_MS),
          revoked: false,
        });
        tx.create(ref("Codes", digest(authorizationCode)), {
          ...stored,
          grantId,
          clientId: client.id,
          uid: user.uid,
          resource: mcpResource(),
          consumed: false,
        });
      });
      return { ...code, client, user: { uid: user.uid, grantId } };
    },
    async getAuthorizationCode(code) {
      if (!/^mfo_[\w-]{43}$/.test(code)) return false;
      const data = (await ref("Codes", digest(code)).get()).data();
      if (
        !data ||
        data.clientId !== context.clientId ||
        data.resource !== mcpResource()
      )
        return false;
      if (data.consumed) {
        await ref("Grants", data.grantId).update({ revoked: true });
        return false;
      }
      // Invalid Date compares false in the OAuth library's expiry comparison.
      // Reject corrupt/missing deadlines before constructing its Date object.
      if (millis(data.expiresAt) <= Date.now()) return false;
      await validGrant(data.grantId, context.clientId);
      return {
        authorizationCode: code,
        expiresAt: new Date(millis(data.expiresAt)),
        redirectUri: data.redirectUri,
        scope: data.scope,
        codeChallenge: data.codeChallenge,
        codeChallengeMethod: data.codeChallengeMethod,
        client: {
          id: data.clientId,
          grants: ["authorization_code", "refresh_token"],
        },
        user: { uid: data.uid, grantId: data.grantId },
      };
    },
    async revokeAuthorizationCode(code) {
      return database().runTransaction(async (tx) => {
        const doc = ref("Codes", digest(code.authorizationCode));
        const data = (await tx.get(doc)).data();
        if (!data || data.consumed) {
          if (data) tx.update(ref("Grants", data.grantId), { revoked: true });
          return false;
        }
        tx.update(doc, { consumed: true });
        return true;
      });
    },
    async getRefreshToken(token) {
      if (!/^mfr_[\w-]{43}$/.test(token)) return false;
      const data = (await ref("Refresh", digest(token)).get()).data();
      if (
        !data ||
        data.clientId !== context.clientId ||
        data.resource !== mcpResource()
      )
        return false;
      if (data.consumed) {
        await ref("Grants", data.grantId).update({ revoked: true });
        return false;
      }
      if (millis(data.expiresAt) <= Date.now()) return false;
      await validGrant(data.grantId, context.clientId);
      return {
        refreshToken: token,
        refreshTokenExpiresAt: new Date(millis(data.expiresAt)),
        scope: [MCP_SCOPE],
        client: {
          id: data.clientId,
          grants: ["authorization_code", "refresh_token"],
        },
        user: { uid: data.uid, grantId: data.grantId },
      };
    },
    async revokeToken(token) {
      return database().runTransaction(async (tx) => {
        const doc = ref("Refresh", digest(token.refreshToken));
        const data = (await tx.get(doc)).data();
        if (!data || data.consumed) {
          if (data) tx.update(ref("Grants", data.grantId), { revoked: true });
          return false;
        }
        tx.update(doc, { consumed: true });
        return true;
      });
    },
    async saveToken(token, client, user) {
      const grant = await validGrant(user.grantId, client.id);
      const refreshExpires = new Date(millis(grant.expiresAt));
      const accessExpires = new Date(
        Math.min(
          token.accessTokenExpiresAt!.getTime(),
          refreshExpires.getTime(),
        ),
      );
      await database().runTransaction(async (tx) => {
        const current = (await tx.get(ref("Grants", user.grantId))).data();
        if (
          !current ||
          current.revoked ||
          millis(current.expiresAt) <= Date.now()
        )
          invalid("invalid_grant");
        const base = {
          uid: user.uid,
          grantId: user.grantId,
          clientId: client.id,
          resource: mcpResource(),
          scope: MCP_SCOPE,
        };
        tx.create(ref("Access", digest(token.accessToken)), {
          ...base,
          expiresAt: accessExpires,
        });
        tx.create(ref("Refresh", digest(token.refreshToken!)), {
          ...base,
          expiresAt: refreshExpires,
          consumed: false,
        });
      });
      return {
        ...token,
        accessToken: token.accessToken,
        accessTokenExpiresAt: accessExpires,
        refreshTokenExpiresAt: refreshExpires,
        client,
        user,
      };
    },
  };
  return new OAuth2Server({
    model,
    accessTokenLifetime: 600,
    refreshTokenLifetime: MAX_CONNECTION_MS / 1000,
    authorizationCodeLifetime: 120,
    requirePKCE: true,
    allowEmptyState: false,
    alwaysIssueNewRefreshToken: true,
    requireClientAuthentication: {
      authorization_code: false,
      refresh_token: false,
    },
  });
}

export async function consentAuthorization(
  id: string,
  identity: McpIdentity,
  approved: boolean,
) {
  mcpOrigin();
  if (!/^[\w-]{43}$/.test(id)) invalid();
  const requestRef = ref("Requests", digest(id));
  const data = (await requestRef.get()).data();
  if (!data || data.used || millis(data.expiresAt) <= Date.now())
    invalid("invalid_grant");
  const uid = identity.userId;
  await oauthQuota(`consent:${uid}`, 30);
  const query = data.query as Record<string, string>;
  const callback = new URL(query.redirect_uri!);
  callback.searchParams.set("state", query.state!);
  callback.searchParams.set("iss", mcpOrigin());
  if (!approved) {
    await database().runTransaction(async (tx) => {
      const current = (await tx.get(requestRef)).data();
      if (!current || current.used || millis(current.expiresAt) <= Date.now())
        invalid("invalid_grant");
      tx.update(requestRef, { used: true });
    });
    callback.searchParams.set("error", "access_denied");
    return callback.href;
  }
  // At most 40 grants can remain live across two adjacent fixed 30-day buckets.
  // The connection-management list's 100-row bound therefore cannot hide one.
  await oauthQuota(`new-connection:${uid}`, 20, MAX_CONNECTION_MS);
  const response = new OAuth2Server.Response();
  const code = await server({
    stage: "authorize",
    transactionId: id,
  }).authorize(
    new OAuth2Server.Request({ method: "GET", headers: {}, query }),
    response,
    { authenticateHandler: { handle: async () => ({ uid, subject: identity.subject, householdId: identity.householdId }) } },
  );
  callback.searchParams.set("code", code.authorizationCode);
  return callback.href;
}

export async function readOAuthForm(request: Request) {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/x-www-form-urlencoded"
  )
    invalid();
  const reader = request.body?.getReader();
  if (!reader) invalid();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => undefined); }, 5000);
  try {
    while (true) {
      const part = await reader.read();
      if (expired) invalid();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8192) {
        await reader.cancel();
        invalid();
      }
      chunks.push(part.value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  return uniqueParams(
    new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
  );
}

export async function exchangeToken(request: Request) {
  mcpOrigin();
  const body = await readOAuthForm(request);
  if (
    body.resource !== mcpResource() ||
    !["authorization_code", "refresh_token"].includes(body.grant_type ?? "")
  )
    invalid();
  let method = body.client_secret ? "client_secret_post" : "none";
  const authorization = request.headers.get("authorization");
  if (authorization) {
    if (
      !/^Basic [A-Za-z0-9+/=]{1,1024}$/.test(authorization) ||
      body.client_secret
    )
      invalid("invalid_client");
    const value = Buffer.from(authorization.slice(6), "base64").toString(
      "utf8",
    );
    const separator = value.indexOf(":");
    if (separator < 0) invalid("invalid_client");
    const id = decodeURIComponent(value.slice(0, separator));
    if (body.client_id && body.client_id !== id) invalid("invalid_client");
    body.client_id = id;
    body.client_secret = decodeURIComponent(value.slice(separator + 1));
    method = "client_secret_basic";
  }
  if (!/^mfc_[\w-]{43}$/.test(body.client_id ?? "")) invalid("invalid_client");
  // Unknown random client IDs must never create quota documents.
  if (!(await ref("Clients", body.client_id!).get()).exists)
    invalid("invalid_client");
  await oauthQuota(`token:${body.client_id}`, 120, 60_000);
  const response = new OAuth2Server.Response();
  const token = await server({
    stage: "token",
    clientId: body.client_id!,
    authMethod: method,
  }).token(
    new OAuth2Server.Request({
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(
          new URLSearchParams(body).toString(),
        ).toString(),
      },
      query: {},
      body,
    }),
    response,
  );
  // Explicit DTO: never serialize the model's UID, client, code or grant objects.
  return {
    access_token: token.accessToken,
    token_type: "Bearer",
    expires_in: Math.max(
      0,
      Math.floor((token.accessTokenExpiresAt!.getTime() - Date.now()) / 1000),
    ),
    refresh_token: token.refreshToken,
    scope: MCP_SCOPE,
  };
}

export async function requireMcpPrincipal(
  request: Request,
): Promise<McpIdentity & { grantId: string; client: Awaited<ReturnType<typeof verifyMcpIdentity>>["client"] }> {
  mcpOrigin();
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer mfa_[\w-]{43}$/.test(authorization)) invalid("invalid_token");
  const data = (
    await ref("Access", digest(authorization.slice(7))).get()
  ).data();
  if (
    !data ||
    millis(data.expiresAt) <= Date.now() ||
    data.resource !== mcpResource() ||
    data.scope !== MCP_SCOPE
  )
    invalid("invalid_token");
  const grant = await validGrant(data.grantId, data.clientId);
  if (grant.uid !== data.uid) invalid("invalid_token");
  await oauthQuota(`mcp:${data.grantId}`, 120, 60_000);
  return { subject: grant.subject, userId: data.uid, householdId: grant.householdId, grantId: data.grantId, client: grant.verified.client };
}
export function mcpUnauthorizedResponse(error: unknown): Response {
  if (error instanceof AppError)
    return json({ error: error.code }, error.status);
  if (!(error instanceof OAuth2Server.OAuthError))
    return json({ error: "temporarily_unavailable" }, 503);
  return new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "WWW-Authenticate": `Bearer resource_metadata="${mcpOrigin()}/.well-known/oauth-protected-resource/mcp", scope="${MCP_SCOPE}", error="invalid_token"`,
    },
  });
}
export function oauthErrorResponse(error: unknown) {
  if (error instanceof ZodError) return json({ error: "invalid_request" }, 400);
  if (error instanceof AppError)
    return json({ error: error.code }, error.status);
  if (error instanceof OAuth2Server.OAuthError)
    return json(
      {
        error: [
          "invalid_request",
          "invalid_client",
          "invalid_grant",
          "invalid_scope",
          "invalid_client_metadata",
          "invalid_redirect_uri",
          "access_denied",
          "unsupported_grant_type",
        ].includes(error.name)
          ? error.name
          : "invalid_request",
      },
      400,
    );
  return json({ error: "temporarily_unavailable" }, 503);
}
export async function listConnections(uid: string) {
  mcpOrigin();
  const snapshot = await database()
    .collection("mcpOAuthGrants")
    .where("uid", "==", uid)
    .where("revoked", "==", false)
    .where("expiresAt", ">", new Date())
    .limit(100)
    .get();
  return snapshot.docs
    .filter(
      (doc) => !doc.data().revoked && millis(doc.data().expiresAt) > Date.now(),
    )
    .map((doc) => ({
      id: doc.id,
      clientName: doc.data().clientName as string,
      householdId: doc.data().householdId as string,
      createdAt: new Date(millis(doc.data().createdAt)).toISOString(),
      expiresAt: new Date(millis(doc.data().expiresAt)).toISOString(),
    }));
}
export async function revokeConnection(uid: string, id: string) {
  mcpOrigin();
  if (!/^[\w-]{43}$/.test(id)) invalid();
  await database().runTransaction(async (tx) => {
    const doc = ref("Grants", id);
    const data: DocumentData | undefined = (await tx.get(doc)).data();
    if (!data || data.uid !== uid)
      throw new AppError("FORBIDDEN", 403, "この接続を解除できません。");
    tx.update(doc, { revoked: true });
  });
}
