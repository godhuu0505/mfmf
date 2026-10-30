import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createGcpDataClient } from "../../src/lib/gcp/dataClient";

const secret = Buffer.alloc(32, 41).toString("base64");
const userId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const identity = { subject: "opaque-google-user", email: "member@example.test", emailVerified: true };
function claims(init?: RequestInit) {
  const token = new Headers(init?.headers).get("Authorization")!.slice(7);
  const [header, body, signature] = token.split(".");
  expect(signature).toBe(createHmac("sha256", Buffer.from(secret, "base64")).update(`${header}.${body}`).digest("base64url"));
  return JSON.parse(Buffer.from(body, "base64url").toString());
}

describe("Cloud SQL data client identity boundary", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("synchronizes only a verified identity and uses its internal UUID in the request transaction", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("http://127.0.0.1:3001");
      expect(init).toMatchObject({ redirect: "error", cache: "no-store", credentials: "omit" });
      expect(new Headers(init?.headers).has("apikey")).toBe(false);
      expect(new Headers(init?.headers).has("cookie")).toBe(false);
      if (url.pathname === "/rpc/sync_identity") {
        expect(claims(init).role).toBe("identity_sync");
        expect(claims(init).sub).toBeUndefined();
        expect(JSON.parse(String(init?.body))).toEqual({ p_subject: identity.subject, p_email: identity.email, p_email_verified: true, p_allow_create: false });
        return Response.json(userId);
      }
      expect(claims(init)).toMatchObject({ role: "authenticated", sub: userId, aud: "mfmf-internal-database", exp: 160, iat: 100 });
      expect(url.pathname).toBe("/records");
      return Response.json([]);
    });
    const { client, user } = await createGcpDataClient(identity, { secret, fetchImpl, now: () => 100_000 });
    expect(user?.id).toBe(userId);
    expect((await client.from("records").select("id")).error).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("does not synchronize or give a subject to anonymous requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(claims(init).role).toBe("anon"); expect(claims(init).sub).toBeUndefined();
      return Response.json("gcs");
    });
    const { client, user } = await createGcpDataClient(null, { secret, fetchImpl });
    expect(user).toBeNull(); await client.rpc("get_media_read_backend");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("cannot publish an unverified email into the invitation authorization mirror", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ p_subject: identity.subject, p_email: null, p_email_verified: false, p_allow_create: false });
      return Response.json(userId);
    });
    const { user } = await createGcpDataClient({ ...identity, emailVerified: false }, { secret, fetchImpl });
    expect(user?.email).toBeUndefined();
  });
  it.each([Response.json({ message: "private-marker" }, { status: 403 }), Response.json(identity.subject), Response.json(null)])("stops on failed or invalid identity synchronization", async (response) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response.clone());
    await expect(createGcpDataClient(identity, { secret, fetchImpl })).rejects.toThrow("Identity database synchronization failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("isolates concurrent users and mints a short-lived token for every query", async () => {
    let now = 100_000;
    const seen: { sub?: string; iat: number }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("sync_identity")) return Response.json(JSON.parse(String(init?.body)).p_subject === "other" ? otherId : userId);
      seen.push(claims(init)); return Response.json([]);
    });
    const [a, b] = await Promise.all([createGcpDataClient(identity, { secret, fetchImpl, now: () => now }), createGcpDataClient({ ...identity, subject: "other" }, { secret, fetchImpl, now: () => now })]);
    await Promise.all([a.client.from("records").select("id"), b.client.from("records").select("id")]);
    now = 200_000; await a.client.from("pets").select("id");
    expect(seen.map((x) => [x.sub, x.iat])).toEqual([[userId, 100], [otherId, 100], [userId, 200]]);
  });
  it("rejects unavailable signing keys and malformed identities before sending anything", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const key of ["", "short", Buffer.alloc(31).toString("base64")]) await expect(createGcpDataClient(identity, { secret: key, fetchImpl })).rejects.toThrow();
    for (const subject of ["", "x".repeat(129), "x\n"]) await expect(createGcpDataClient({ ...identity, subject }, { secret, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([undefined, "false", "TRUE", "true"])("derives new-user admission only from the exact server flag %s", async (flag) => {
    vi.stubEnv("SIGNUP_ENABLED", flag);
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body)).p_allow_create).toBe(flag === "true");
      return Response.json(userId);
    });
    await createGcpDataClient(identity, { secret, fetchImpl });
  });
  it("blocks accidental old Storage and Auth traffic instead of falling back to Supabase", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { client } = await createGcpDataClient(null, { secret, fetchImpl });
    const result = await client.storage.from("daycare-photos").createSignedUrl("object", 60);
    expect(result.error).toBeTruthy(); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("keeps MCP lookups read-only even while normal registration is open", async () => {
    vi.stubEnv("SIGNUP_ENABLED", "true");
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body)).p_allow_create).toBe(false);
      return Response.json(userId);
    });
    await createGcpDataClient(identity, { secret, fetchImpl, allowCreate: false });
  });
});
