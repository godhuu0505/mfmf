import { beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
vi.mock("server-only", () => ({}));
import { createGcsStorage, GCS_BUCKETS, GCS_MAX_BYTES, GCS_RUNTIME, gcsBindingMetadata, validateGcsObject, validateGcsBinding, type GcsBinding, type GcsObject, type GcsRef } from "../../src/lib/gcsStorage";
import { bootstrapStorage, storageBucketConfig, STORAGE_ORIGIN } from "../../scripts/gcp/bootstrap-storage.mjs";
import { runStorageContract } from "../../scripts/gcp/test-storage-contract.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const household = "22222222-2222-4222-8222-222222222222";
const entity = "33333333-3333-4333-8333-333333333333";
const reservation = "44444444-4444-4444-8444-444444444444";
const source: GcsRef = { bucket: "photos", name: `_incoming/${reservation}`, generation: "12345678901234567890" };
const destination: GcsObject = { bucket: "photos", name: `${household}/${entity}/${reservation}` };
const binding: GcsBinding = { schema: "1", state: "ready", kind: "record-photo", entityId: entity, householdId: household, ownerId: owner, reservationId: reservation, sourceGeneration: source.generation };
let png: Buffer;
beforeAll(async () => { png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer(); });
function metadata(object: GcsObject = source, extra = {}) {
  return { bucket: GCS_BUCKETS[object.bucket], name: object.name, generation: source.generation, size: String(png.length), contentType: "image/png", crc32c: "AAAAAA==", metadata: { attacker: "input-must-not-be-inherited" }, ...extra };
}
function fake({ failure = "", data = () => png } = {}) {
  const signBlob = vi.fn(async () => Buffer.alloc(256, 7));
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const url = new URL(String(input));
    if (failure === "throw") throw new Error("private-response-marker");
    if (["403", "404", "412", "500"].includes(failure)) return new Response("private-response-marker", { status: Number(failure) });
    if (failure === "oversize-json") return new Response("private-response-marker".repeat(10_000));
    if (options?.method === "DELETE") return new Response(null, { status: 204 });
    if (url.searchParams.get("alt") === "media") return new Response(new Uint8Array(data()));
    if (url.pathname.includes("/rewriteTo/")) {
      const body = JSON.parse(String(options?.body));
      return Response.json({ done: true, resource: metadata(destination, { generation: "12345678901234567891", metadata: body.metadata, contentEncoding: body.contentEncoding }) });
    }
    return Response.json(metadata(source, failure === "wrong-generation" ? { generation: "9" } : failure === "wrong-size" ? { size: "1" } : failure === "gzip" ? { contentEncoding: "gzip" } : {}));
  });
  const storage = createGcsStorage({ fetchImpl, signBlob, getAccessToken: async () => "private-runtime-token", now: () => Date.UTC(2026, 9, 27) });
  return { storage, fetchImpl, signBlob };
}

describe("fixed GCS adapter", () => {
  it.each(["../x", `${household}/../x`, `${household}/${entity}/..`, `${household}/${entity}/a%2Fb`, `${household}/${entity}/a\\b`, `${household}/${entity}/a?token=x`, `${household}/${entity}/a#x`, `${household}/${entity}/a\n`, `${household}/${entity}/a/b`, "_incoming/not-uuid"])("rejects unsafe object names: %j", (name) => {
    expect(() => validateGcsObject({ bucket: "photos", name })).toThrow("input withheld");
  });
  it("rejects bucket substitutions, mixed bucket paths and final-name browser uploads before signing", async () => {
    const h = fake();
    for (const object of [{ ...source, bucket: "foreign" }, { bucket: "avatars", name: destination.name }, destination]) {
      await expect(h.storage.signUpload({ ...object, bucket: object.bucket as "photos", size: 10, contentType: "image/png" })).rejects.toThrow();
    }
    expect(h.signBlob).not.toHaveBeenCalled(); expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, Number.NaN, GCS_MAX_BYTES.photos + 1])("rejects invalid upload size %s", async (size) => {
    const h = fake(); await expect(h.storage.signUpload({ ...source, size, contentType: "image/png" })).rejects.toThrow(); expect(h.signBlob).not.toHaveBeenCalled();
  });
  it("binds exact size, MIME and create-only condition to a five-minute XML PUT", async () => {
    const h = fake(); const result = await h.storage.signUpload({ ...source, size: png.length, contentType: "image/png" });
    const url = new URL(result.url);
    expect(url.origin).toBe("https://storage.googleapis.com");
    expect(url.pathname).toBe(`/mfmf-499612-photos/${source.name}`);
    expect(url.searchParams.get("X-Goog-Credential")).toBe(`${GCS_RUNTIME}/20261027/auto/storage/goog4_request`);
    expect(url.searchParams.get("X-Goog-Expires")).toBe("300");
    expect(url.searchParams.get("X-Goog-SignedHeaders")).toBe("content-type;host;x-goog-content-length-range;x-goog-if-generation-match");
    expect(result.headers).toEqual({ "content-type": "image/png", "x-goog-content-length-range": `${png.length},${png.length}`, "x-goog-if-generation-match": "0" });
    expect(result.expiresAt).toBe("2026-10-27T00:05:00.000Z");
    expect(result.url).not.toContain("private-runtime-token");
  });
  it.each(["0", "-1", "01", "1e2", "18446744073709551616"])("rejects unsafe generation %s", async (generation) => {
    const h = fake(); await expect(h.storage.signRead({ ...destination, generation })).rejects.toThrow(); expect(h.signBlob).not.toHaveBeenCalled();
  });
  it("pins a signed GET to the specified 64-bit generation and caps its TTL", async () => {
    const h = fake(); const url = new URL(await h.storage.signRead({ ...destination, generation: source.generation }));
    expect(url.searchParams.get("generation")).toBe(source.generation); expect(url.searchParams.get("X-Goog-Expires")).toBe("3600");
    await expect(h.storage.signRead(source)).rejects.toThrow();
    await expect(h.storage.signRead({ ...destination, generation: "1" }, 3601)).rejects.toThrow();
  });
  it.each(["403", "412", "500", "throw", "oversize-json", "wrong-generation"])("does not convert %s into missing or leak the error body", async (failure) => {
    const h = fake({ failure }); const error = await h.storage.stat(source).catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain("private-response-marker"); expect(String(error)).not.toContain("private-runtime-token");
  });
  it("treats only authenticated 404 as absent", async () => { expect(await fake({ failure: "404" }).storage.stat(source)).toBeNull(); });
  it("uses fixed API host, redirect rejection and token only in Authorization", async () => {
    const h = fake(); await h.storage.stat(source);
    const [input, options] = h.fetchImpl.mock.calls[0];
    expect(new URL(String(input)).origin).toBe("https://storage.googleapis.com"); expect(options?.redirect).toBe("error");
    expect(options?.headers).toHaveProperty("Authorization", "Bearer private-runtime-token"); expect(String(input)).not.toContain("private-runtime-token");
  });
  it("decodes a genuine image and replaces all untrusted incoming metadata while publishing", async () => {
    const h = fake(); const final = await h.storage.publish({ source, destinationName: destination.name, binding, expectedSize: png.length, contentType: "image/png" });
    expect(final.binding).toEqual(binding); expect(final.generation).toBe("12345678901234567891");
    const writes = h.fetchImpl.mock.calls.filter(([, options]) => options?.method === "POST"); expect(writes).toHaveLength(1);
    const url = new URL(String(writes[0][0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ sourceGeneration: source.generation, ifSourceGenerationMatch: source.generation, ifGenerationMatch: "0" });
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({ contentType: "image/png", contentEncoding: "identity", cacheControl: "private, no-store", contentDisposition: "inline", metadata: gcsBindingMetadata(binding) });
    expect(String(writes[0][1]?.body)).not.toContain("attacker");
  });
  it.each(["wrong-size", "gzip"])("rejects %s before reading or copying", async (failure) => {
    const h = fake({ failure }); await expect(h.storage.publish({ source, destinationName: destination.name, binding, expectedSize: png.length, contentType: "image/png" })).rejects.toThrow("Image verification failed");
    expect(h.fetchImpl.mock.calls).toHaveLength(1);
  });
  it("rejects bytes that only claim to be an image and bounds received media", async () => {
    const h = fake({ data: () => Buffer.alloc(png.length, 1) });
    await expect(h.storage.verifyImage(source, png.length, "image/png")).rejects.toThrow("Image verification failed");
    await expect(fake({ data: () => Buffer.alloc(png.length + 1) }).storage.readBounded(source, png.length)).rejects.toThrow("details withheld");
  });
  it("rejects a truncated file whose PNG header is genuine", async () => {
    const data = png.subarray(0, 40);
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => new URL(String(input)).searchParams.has("alt")
      ? new Response(new Uint8Array(data)) : Response.json(metadata(source, { size: String(data.length) })));
    await expect(createGcsStorage({ fetchImpl, getAccessToken: async () => "fixture" }).verifyImage(source, data.length, "image/png")).rejects.toThrow("Image verification failed");
  });
  it("rejects an image above the decoded pixel cap", async () => {
    const data = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: "black" } }).png().toBuffer();
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => new URL(String(input)).searchParams.has("alt")
      ? new Response(new Uint8Array(data)) : Response.json(metadata(source, { size: String(data.length) })));
    await expect(createGcsStorage({ fetchImpl, getAccessToken: async () => "fixture" }).verifyImage(source, data.length, "image/png")).rejects.toThrow("Image verification failed");
  });
  it("binds each avatar kind to its proper scope and permits only household's null owner", () => {
    const householdBinding = { ...binding, kind: "household-avatar" as const, entityId: household, ownerId: null };
    expect(() => validateGcsBinding(householdBinding)).not.toThrow();
    expect(gcsBindingMetadata(householdBinding)["mfmf-owner-id"]).toBe("");
    expect(() => validateGcsBinding({ ...householdBinding, ownerId: owner })).toThrow();
    expect(() => validateGcsBinding({ ...binding, ownerId: null })).toThrow();
    expect(() => validateGcsBinding({ ...binding, entityId: [entity] as unknown as string })).toThrow();
  });
  it("rejects SVG, wrong binding and cross-scope destinations before any API calls", async () => {
    const h = fake();
    await expect(h.storage.signUpload({ ...source, size: 10, contentType: "image/svg+xml" as "image/png" })).rejects.toThrow();
    await expect(h.storage.publish({ source, destinationName: `${owner}/${entity}/${reservation}`, binding, expectedSize: png.length, contentType: "image/png" })).rejects.toThrow();
    await expect(h.storage.publish({ source, destinationName: destination.name, binding: { ...binding, sourceGeneration: "1" }, expectedSize: png.length, contentType: "image/png" })).rejects.toThrow();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects concurrent verification immediately and recovers after completion", async () => {
    const h = fake(); const first = h.storage.verifyImage(source, png.length, "image/png");
    await expect(h.storage.verifyImage(source, png.length, "image/png")).rejects.toMatchObject({ code: "busy" });
    await first; await expect(h.storage.verifyImage(source, png.length, "image/png")).resolves.toHaveProperty("size", png.length);
  });
  it("deletes only the exact generation; 404 is idempotent and 412 is not retried", async () => {
    const h = fake(); await h.storage.deleteGeneration(source);
    expect(new URL(String(h.fetchImpl.mock.calls[0][0])).search).toBe(`?generation=${source.generation}&ifGenerationMatch=${source.generation}`);
    await expect(fake({ failure: "404" }).storage.deleteGeneration(source)).resolves.toBeUndefined();
    const conflict = fake({ failure: "412" }); await expect(conflict.storage.deleteGeneration(source)).rejects.toMatchObject({ code: "conflict" }); expect(conflict.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("uses metadata ADC and self signBlob without credentials files", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      if (String(input).startsWith("http://metadata.google.internal/")) {
        expect(options?.headers).toEqual({ "Metadata-Flavor": "Google" });
        return Response.json({ access_token: "private-adc-token", token_type: "Bearer", expires_in: 3600 }, { headers: { "Metadata-Flavor": "Google" } });
      }
      expect(String(input)).toBe(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${GCS_RUNTIME}:signBlob`);
      expect(options?.headers).toHaveProperty("Authorization", "Bearer private-adc-token");
      expect(String(options?.body)).not.toContain("private-adc-token");
      return Response.json({ signedBlob: Buffer.alloc(256, 2).toString("base64") });
    });
    const storage = createGcsStorage({ fetchImpl });
    await storage.signRead({ ...destination, generation: "1" }); await storage.signRead({ ...destination, generation: "2" });
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).startsWith("http:"))).toHaveLength(1);
  });
  it.each(["metadata-flavor", "invalid-signature"])("rejects %s without exposing a URL or token", async (failure) => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => String(input).startsWith("http:")
      ? Response.json({ access_token: "private-token", token_type: "Bearer", expires_in: 3600 }, { headers: failure === "metadata-flavor" ? {} : { "Metadata-Flavor": "Google" } })
      : Response.json({ signedBlob: "private-response-marker" }));
    const error = await createGcsStorage({ fetchImpl }).signRead({ ...destination, generation: "1" }).catch((value: Error) => value);
    expect(String(error)).not.toMatch(/private-token|private-response-marker|X-Goog-Signature/);
    expect(fetchImpl).toHaveBeenCalledTimes(failure === "metadata-flavor" ? 1 : 2);
  });
});

describe("operator storage contract", () => {
  function harness(missingCode = "MalformedSecurityHeader") {
    const live = new Map<string, GcsRef & { size: number }>();
    const incoming = new Map<string, GcsObject>(); const reads = new Map<string, GcsRef>(); let generation = 0;
    const key = (object: GcsObject) => `${object.bucket}/${object.name}`;
    const stat = async (object: GcsObject & { generation?: string }) => {
      const value = live.get(key(object)); return value && (!object.generation || object.generation === value.generation) ? value : null;
    };
    const storage = {
      stat,
      signUpload: async (object: GcsObject) => {
        incoming.set(object.bucket, object);
        return { url: `https://fixture.invalid/${object.bucket}/upload`, headers: { "content-type": "image/png", "x-goog-content-length-range": `${png.length},${png.length}`, "x-goog-if-generation-match": "0" } };
      },
      publish: async ({ source: original, destinationName }: { source: GcsRef; destinationName: string }) => {
        const object = { bucket: original.bucket, name: destinationName }; if (live.has(key(object))) throw { code: "conflict" };
        const result = { ...object, generation: String(++generation), size: png.length }; live.set(key(object), result); return result;
      },
      signRead: async (object: GcsRef) => { const url = `https://fixture.invalid/read/${object.generation}`; reads.set(url, object); return url; },
      deleteGeneration: async (object: GcsRef) => { if (live.get(key(object))?.generation === object.generation) live.delete(key(object)); },
    };
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], options: RequestInit = {}) => {
      const url = String(input);
      if (options.method === "OPTIONS") return new Response(null, { status: 200, headers: (options.headers as Record<string, string>).Origin === STORAGE_ORIGIN ? { "Access-Control-Allow-Origin": STORAGE_ORIGIN } : {} });
      if (options.method !== "PUT") return new Response(null, { status: await stat(reads.get(url)!) ? 200 : 404 });
      const headers = options.headers as Record<string, string>;
      if ((options.body as Buffer).length !== png.length) return new Response(null, { status: 400 });
      if (!headers["x-goog-content-length-range"]) return new Response(`<Error><Code>${missingCode}</Code><Message>private-response-marker</Message></Error>`, { status: 400 });
      if (headers["content-type"] !== "image/png" || headers["x-goog-if-generation-match"] !== "0") return new Response(null, { status: 403 });
      const object = incoming.get(new URL(url).pathname.split("/")[1])!;
      if (live.has(key(object))) return new Response(null, { status: 412 });
      live.set(key(object), { ...object, generation: String(++generation), size: png.length }); return new Response(null, { status: 200 });
    });
    return { live, storage, fetchImpl, log: vi.fn() };
  }
  it("distinguishes missing security headers, verifies cleanup and reports only aggregate fixture data", async () => {
    const h = harness(); await runStorageContract({ ...h, png });
    expect(h.live.size).toBe(0);
    expect(h.log).toHaveBeenCalledWith(`Fixture cleanup verified: 4 isolated names, zero live objects; 6 observed generations (${png.length * 6} bytes) may remain soft-deleted for seven days.`);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("private-response-marker");
  });
  it("does not accept an unrelated 400 as missing-header rejection", async () => {
    const h = harness("UnrelatedFailure"); await expect(runStorageContract({ ...h, png })).rejects.toThrow("details withheld");
    expect(h.live.size).toBe(0); expect(JSON.stringify(h.log.mock.calls)).not.toContain("private-response-marker");
  });
});

describe("storage operator bootstrap", () => {
  it("uses only two fixed private Tokyo buckets and incoming-only lifecycle", () => {
    const config = storageBucketConfig(GCS_BUCKETS.photos, ["https://mfmf-fixture.vercel.app"]);
    expect(config.iamConfiguration).toEqual({ uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" });
    expect(config.softDeletePolicy.retentionDurationSeconds).toBe("604800"); expect(config.versioning.enabled).toBe(false);
    expect(config.lifecycle.rule).toEqual([{ action: { type: "Delete" }, condition: { age: 1, matchesPrefix: ["_incoming/"] } }]);
    expect(config.cors[0].origin).toContain(STORAGE_ORIGIN); expect(config.cors[0].origin).toContain("https://mfmf.sanba.net"); expect(config.cors[0].method).not.toContain("OPTIONS");
  });
  it.each(["*", "http://localhost:3000", "https://attacker.invalid", "https://mfmf.vercel.app/path", "https://user@mfmf.vercel.app"])("rejects unapproved CORS origin shape %s", (origin) => {
    expect(() => storageBucketConfig(GCS_BUCKETS.photos, [origin])).toThrow("details withheld");
  });
  it("default plan makes no mutations, creates no credentials and withholds API error data", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      expect(options?.redirect).toBe("error");
      return String(input).endsWith(":getIamPolicy") ? Response.json({ etag: "safe", bindings: [] }) : new Response(null, { status: 404 });
    });
    const log = vi.fn(); await bootstrapStorage({ token: "private-marker", fetchImpl, log });
    expect(fetchImpl.mock.calls.every(([input, options]) => options?.method === "GET" || String(input).endsWith(":getIamPolicy"))).toBe(true);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-marker");
    await expect(bootstrapStorage({ token: "private-marker", fetchImpl: async () => new Response("private-body", { status: 403 }), log })).rejects.not.toThrow("private-body");
  });
  function setupHarness(failure = "") {
    const roles = new Map<string, Record<string, unknown>>();
    const buckets = new Map<string, Record<string, unknown>>();
    const policies = new Map<string, { etag: string; version?: number; bindings: { role: string; members: string[] }[] }>();
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      const url = new URL(String(input)); const body = options?.body ? JSON.parse(String(options.body)) : null;
      if (url.pathname.endsWith("/roles") && options?.method === "POST") {
        const name = `projects/mfmf-499612/roles/${body.roleId}`; roles.set(name, { ...body.role, name }); return Response.json(roles.get(name));
      }
      if (url.pathname.includes("/roles/")) return roles.has(url.pathname.slice(4)) ? Response.json(roles.get(url.pathname.slice(4))) : new Response(null, { status: 404 });
      if (url.pathname === "/storage/v1/b" && options?.method === "POST") {
        buckets.set(body.name, { ...body, projectNumber: "92772745697" }); return Response.json(buckets.get(body.name));
      }
      if (url.pathname.endsWith("/iam") || url.pathname.endsWith(":getIamPolicy") || url.pathname.endsWith(":setIamPolicy")) {
        const key = url.pathname.replace(/:(get|set)IamPolicy$/, ":policy");
        const policy = policies.get(key) ?? { etag: "etag-1", bindings: [{ role: "roles/viewer", members: ["user:existing@example.invalid"] }] };
        if (options?.method === "PUT" || url.pathname.endsWith(":setIamPolicy")) {
          if (failure === "conflict") return new Response("private-conflict", { status: 409 });
          const next = body.policy ?? body; expect(next.etag).toBe(policy.etag); policies.set(key, next); return Response.json(next);
        }
        return Response.json(policy);
      }
      const name = url.pathname.split("/").at(-1)!;
      return buckets.has(name) ? Response.json(buckets.get(name)) : new Response(null, { status: 404 });
    });
    return { fetchImpl, buckets, roles, policies };
  }
  it("applies only narrow roles and two protected buckets, preserves IAM peers, then is idempotent", async () => {
    const h = setupHarness(); const log = vi.fn();
    await bootstrapStorage({ token: "private-marker", apply: true, fetchImpl: h.fetchImpl, log });
    expect(h.buckets.size).toBe(2); expect(h.roles.size).toBe(2);
    const grants = [...h.policies.values()].flatMap((policy) => policy.bindings);
    expect(grants.filter((grant) => grant.members.includes(`serviceAccount:${GCS_RUNTIME}`))).toHaveLength(3);
    expect(grants.filter((grant) => grant.members.includes("user:existing@example.invalid"))).toHaveLength(3);
    expect([...h.roles.values()].flatMap((role) => role.includedPermissions)).toEqual(["storage.objects.create", "storage.objects.delete", "storage.objects.get", "iam.serviceAccounts.signBlob"]);
    h.fetchImpl.mockClear();
    await bootstrapStorage({ token: "private-marker", apply: true, fetchImpl: h.fetchImpl, log });
    expect(h.fetchImpl.mock.calls.every(([input, options]) => options?.method === "GET" || String(input).endsWith(":getIamPolicy"))).toBe(true);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-marker");
  });
  it.each(["foreign-project", "public", "unsafe-lifecycle", "wrong-role"])("refuses existing %s before any mutation", async (failure) => {
    const h = setupHarness();
    const config = { ...storageBucketConfig(GCS_BUCKETS.photos), projectNumber: "92772745697" };
    if (failure === "foreign-project") config.projectNumber = "12345";
    if (failure === "public") config.iamConfiguration.publicAccessPrevention = "inherited";
    if (failure === "unsafe-lifecycle") config.lifecycle.rule[0].condition.matchesPrefix = [""];
    h.buckets.set(GCS_BUCKETS.photos, config);
    if (failure === "wrong-role") h.roles.set("projects/mfmf-499612/roles/mfmfStorageSignBlob", { name: "projects/mfmf-499612/roles/mfmfStorageSignBlob", stage: "GA", includedPermissions: ["iam.serviceAccounts.getAccessToken"] });
    await expect(bootstrapStorage({ token: "fixture", apply: true, fetchImpl: h.fetchImpl, log: vi.fn() })).rejects.toThrow();
    expect(h.fetchImpl.mock.calls.every(([input, options]) => options?.method === "GET" || String(input).endsWith(":getIamPolicy"))).toBe(true);
  });
  it("does not retry an IAM conflict or print its response", async () => {
    const h = setupHarness("conflict");
    const log = vi.fn();
    await expect(bootstrapStorage({ token: "fixture", apply: true, fetchImpl: h.fetchImpl, log })).rejects.not.toThrow("private-conflict");
    expect(h.fetchImpl.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("Storage API stopped: bucket-iam PUT HTTP 409. Response details withheld; inspect existing state before retrying.");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-conflict");
  });
});
