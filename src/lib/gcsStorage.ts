import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";

export const GCS_PROJECT = "mfmf-499612";
export const GCS_RUNTIME = `mfmf-runtime@${GCS_PROJECT}.iam.gserviceaccount.com`;
export const GCS_BUCKETS = { photos: "mfmf-499612-photos", avatars: "mfmf-499612-avatars" } as const;
export type GcsBucket = keyof typeof GCS_BUCKETS;
export type GcsObject = { bucket: GcsBucket; name: string };
export type GcsRef = GcsObject & { generation: string };
export type GcsContentType = "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/avif";
export type GcsBinding = {
  schema: "1";
  state: "ready";
  kind: "record-photo" | "profile-avatar" | "household-avatar" | "pet-avatar";
  entityId: string;
  householdId: string | null;
  ownerId: string | null;
  reservationId: string;
  sourceGeneration: string;
};
export type GcsMetadata = GcsRef & {
  size: number;
  contentType: string;
  contentEncoding: string | null;
  crc32c: string;
  md5Hash: string | null;
  binding: GcsBinding | null;
};
export const GCS_MAX_BYTES = { photos: 10 * 1024 * 1024, avatars: 2 * 1024 * 1024 } as const;
const TYPES: GcsContentType[] = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const API = "https://storage.googleapis.com/storage/v1";
const TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const SIGN_URL = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${GCS_RUNTIME}:signBlob`;
const BINDING_KEYS = ["schema", "state", "kind", "entityId", "householdId", "ownerId", "reservationId", "sourceGeneration"] as const;
const METADATA_KEYS = { schema: "mfmf-schema", state: "mfmf-state", kind: "mfmf-kind", entityId: "mfmf-entity-id", householdId: "mfmf-household-id", ownerId: "mfmf-owner-id", reservationId: "mfmf-reservation-id", sourceGeneration: "mfmf-source-generation" } as const;
const MAX_PIXELS = 16_000_000;
let imageVerificationBusy = false;

export class GcsStorageError extends Error {
  readonly code: "invalid" | "unavailable" | "forbidden" | "conflict" | "image" | "busy";
  constructor(code: GcsStorageError["code"], message: string) {
    super(message); this.name = "GcsStorageError"; this.code = code;
  }
}
function invalid(): never { throw new GcsStorageError("invalid", "Invalid storage request; input withheld."); }
function unavailable(): never { throw new GcsStorageError("unavailable", "Storage request failed; details withheld."); }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const generation = (value: unknown): value is string => typeof value === "string" && GENERATION.test(value) && BigInt(value) <= 18446744073709551615n;
const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

export function validateGcsObject(value: GcsObject, incomingOnly = false): void {
  if (!record(value) || typeof value.bucket !== "string" || !Object.hasOwn(GCS_BUCKETS, value.bucket) || typeof value.name !== "string" || value.name.length > 512) invalid();
  const parts = value.name.split("/");
  if (parts[0] === "_incoming") {
    if (parts.length !== 2 || !UUID.test(parts[1])) invalid();
    return;
  }
  if (incomingOnly || parts.length !== 3 || !UUID.test(parts[0]) ||
      !(UUID.test(parts[1]) || parts[1] === "avatars") || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/.test(parts[2]) ||
      parts.some((part) => part === "." || part === "..") ||
      (value.bucket === "photos" ? parts[1] === "avatars" : parts[1] !== "avatars")) invalid();
}
function validateRef(ref: GcsRef) { validateGcsObject(ref); if (!generation(ref.generation)) invalid(); }
function validateSize(bucket: GcsBucket, size: number, type: string): asserts type is GcsContentType {
  if (!Number.isSafeInteger(size) || size < 1 || size > GCS_MAX_BYTES[bucket] || !TYPES.includes(type as GcsContentType)) invalid();
}
export function validateGcsBinding(binding: GcsBinding): void {
  if (!record(binding) || Object.keys(binding).length !== BINDING_KEYS.length || !BINDING_KEYS.every((key) => Object.hasOwn(binding, key)) ||
      binding.schema !== "1" || binding.state !== "ready" ||
      !["record-photo", "profile-avatar", "household-avatar", "pet-avatar"].includes(binding.kind) ||
      !uuid(binding.entityId) || !uuid(binding.reservationId) || !generation(binding.sourceGeneration) ||
      (binding.kind === "household-avatar" ? binding.ownerId !== null || binding.entityId !== binding.householdId : !uuid(binding.ownerId)) ||
      (binding.kind === "profile-avatar" ? binding.householdId !== null || binding.entityId !== binding.ownerId : !uuid(binding.householdId))) invalid();
}
export function gcsBindingMetadata(binding: GcsBinding): Record<string, string> {
  validateGcsBinding(binding);
  return Object.fromEntries(BINDING_KEYS.map((key) => [METADATA_KEYS[key], binding[key] ?? ""]));
}
function parseBinding(metadata: unknown): GcsBinding | null {
  if (!record(metadata) || Object.keys(metadata).length !== BINDING_KEYS.length) return null;
  const values = Object.fromEntries(BINDING_KEYS.map((key) => [key, metadata[METADATA_KEYS[key]]]));
  if (values.householdId === "") values.householdId = null;
  if (values.ownerId === "") values.ownerId = null;
  try { validateGcsBinding(values as GcsBinding); return values as GcsBinding; } catch { return null; }
}
function bindingMatchesName(object: GcsObject, binding: GcsBinding) {
  const scope = binding.kind === "profile-avatar" ? binding.ownerId : binding.householdId;
  return object.bucket === (binding.kind === "record-photo" ? "photos" : "avatars") &&
    object.name.startsWith(`${scope}/${binding.kind === "record-photo" ? binding.entityId : "avatars"}/`);
}
function parseMetadata(value: unknown, object: GcsObject, expectedGeneration?: string): GcsMetadata {
  if (!record(value) || value.bucket !== GCS_BUCKETS[object.bucket] || value.name !== object.name || !generation(value.generation) ||
      (expectedGeneration !== undefined && value.generation !== expectedGeneration) ||
      typeof value.size !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.size) || !Number.isSafeInteger(Number(value.size)) ||
      typeof value.contentType !== "string" || typeof value.crc32c !== "string" || !/^[A-Za-z0-9+/]{6}==$/.test(value.crc32c) ||
      (value.contentEncoding !== undefined && typeof value.contentEncoding !== "string") ||
      (value.md5Hash !== undefined && (typeof value.md5Hash !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(value.md5Hash)))) unavailable();
  return { bucket: object.bucket, name: object.name, generation: value.generation, size: Number(value.size), contentType: value.contentType,
    contentEncoding: value.contentEncoding as string | undefined ?? null, crc32c: value.crc32c,
    md5Hash: value.md5Hash as string | undefined ?? null, binding: parseBinding(value.metadata) };
}
async function bounded(response: Response, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  try {
    if (!response.body) unavailable();
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) unavailable();
      chunks.push(Buffer.from(chunk));
    }
  } catch { unavailable(); }
  return Buffer.concat(chunks);
}

export type GcsDependencies = {
  fetchImpl?: typeof fetch;
  // Inject only trusted server-side dependencies. No caller-supplied tokens or URLs enter these hooks.
  getAccessToken?: () => Promise<string>;
  signBlob?: (payload: Buffer) => Promise<Buffer>;
  now?: () => number;
};

export function createGcsStorage(dependencies: GcsDependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? Date.now;
  let tokenCache: { token: string; expires: number } | null = null;
  const getToken = async () => {
    if (dependencies.getAccessToken) return dependencies.getAccessToken();
    if (tokenCache && tokenCache.expires > now() + 60_000) return tokenCache.token;
    let response: Response;
    try { response = await fetchImpl(TOKEN_URL, { headers: { "Metadata-Flavor": "Google" }, redirect: "error", signal: AbortSignal.timeout(10_000) }); }
    catch { return unavailable(); }
    if (!response.ok || response.headers.get("metadata-flavor") !== "Google") return unavailable();
    let value: unknown;
    try { value = JSON.parse((await bounded(response, 16_384)).toString("utf8")); } catch { return unavailable(); }
    if (!record(value) || typeof value.access_token !== "string" || !value.access_token || /[\r\n]/.test(value.access_token) ||
        value.token_type !== "Bearer" || typeof value.expires_in !== "number" || value.expires_in < 120 || value.expires_in > 3600) return unavailable();
    tokenCache = { token: value.access_token, expires: now() + value.expires_in * 1000 };
    return tokenCache.token;
  };
  const request = async (url: string, options: RequestInit = {}, allowMissing = false) => {
    let response: Response;
    try {
      const token = await getToken();
      if (!token || /[\r\n]/.test(token)) unavailable();
      response = await fetchImpl(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch { return unavailable(); }
    if (response.status === 404 && allowMissing) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 409 || response.status === 412) throw new GcsStorageError("conflict", "Storage generation conflict; details withheld.");
      if (response.status === 401 || response.status === 403) throw new GcsStorageError("forbidden", "Storage access denied; details withheld.");
      return unavailable();
    }
    return response;
  };
  const json = async (response: Response | null): Promise<unknown> => {
    if (!response) return null;
    try { return JSON.parse((await bounded(response, 65_536)).toString("utf8")); } catch { return unavailable(); }
  };
  const sign = async (payload: Buffer) => {
    if (dependencies.signBlob) {
      try { const value = await dependencies.signBlob(payload); if (!Buffer.isBuffer(value) || value.length !== 256) return unavailable(); return value; }
      catch { return unavailable(); }
    }
    const value = await json(await request(SIGN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: payload.toString("base64") }) }));
    if (!record(value) || typeof value.signedBlob !== "string") return unavailable();
    const signed = Buffer.from(value.signedBlob, "base64");
    if (signed.length !== 256 || signed.toString("base64") !== value.signedBlob) return unavailable();
    return signed;
  };
  const signUrl = async (object: GcsObject, method: "GET" | "PUT", ttl: number, headers: Record<string, string>, query: Record<string, string> = {}) => {
    validateGcsObject(object);
    const date = new Date(now()).toISOString().replace(/[-:]|\.\d{3}/g, "");
    const scope = `${date.slice(0, 8)}/auto/storage/goog4_request`;
    const canonicalHeaders = { host: "storage.googleapis.com", ...headers };
    const names = Object.keys(canonicalHeaders).sort();
    const signedHeaders = names.join(";");
    const params = { ...query, "X-Goog-Algorithm": "GOOG4-RSA-SHA256", "X-Goog-Credential": `${GCS_RUNTIME}/${scope}`,
      "X-Goog-Date": date, "X-Goog-Expires": String(ttl), "X-Goog-SignedHeaders": signedHeaders };
    const canonicalQuery = Object.entries(params).map(([key, value]) => [encode(key), encode(value)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("&");
    const path = `/${GCS_BUCKETS[object.bucket]}/${object.name.split("/").map(encode).join("/")}`;
    const canonical = [method, path, canonicalQuery, names.map((name) => `${name}:${canonicalHeaders[name as keyof typeof canonicalHeaders]}\n`).join(""), signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
    const toSign = `GOOG4-RSA-SHA256\n${date}\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`;
    const signature = await sign(Buffer.from(toSign));
    return `https://storage.googleapis.com${path}?${canonicalQuery}&X-Goog-Signature=${signature.toString("hex")}`;
  };
  const objectUrl = (object: GcsObject) => `${API}/b/${GCS_BUCKETS[object.bucket]}/o/${encode(object.name)}`;
  const stat = async (object: GcsObject & { generation?: string }): Promise<GcsMetadata | null> => {
    validateGcsObject(object); if (object.generation !== undefined && !generation(object.generation)) invalid();
    const result = await json(await request(`${objectUrl(object)}${object.generation ? `?generation=${object.generation}` : ""}`, {}, true));
    return result === null ? null : parseMetadata(result, object, object.generation);
  };
  const readBounded = async (ref: GcsRef, maxBytes: number): Promise<Buffer> => {
    validateRef(ref); if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > GCS_MAX_BYTES[ref.bucket]) invalid();
    const response = await request(`${objectUrl(ref)}?alt=media&generation=${ref.generation}`);
    if (!response) return unavailable();
    return bounded(response, maxBytes);
  };
  const verifyImage = async (ref: GcsRef, expectedSize: number, contentType: GcsContentType): Promise<GcsMetadata> => {
    validateRef(ref); validateSize(ref.bucket, expectedSize, contentType);
    if (imageVerificationBusy) throw new GcsStorageError("busy", "Image verification is busy; retry shortly.");
    imageVerificationBusy = true;
    try {
      const metadata = await stat(ref);
      if (!metadata || metadata.size !== expectedSize || metadata.contentType !== contentType ||
          (metadata.contentEncoding !== null && metadata.contentEncoding !== "identity")) throw new Error();
      const data = await readBounded(ref, expectedSize);
      if (data.length !== expectedSize) throw new Error();
      const decoder = sharp(data, { animated: true, limitInputPixels: MAX_PIXELS, failOn: "warning" });
      const info = await decoder.metadata();
      const types: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heif: "image/avif" };
      const pixels = (info.width ?? 0) * (info.pageHeight ?? info.height ?? 0) * (info.pages ?? 1);
      if (!info.format || types[info.format] !== contentType || pixels < 1 || pixels > MAX_PIXELS ||
          (info.format === "heif" && info.compression !== "av1")) throw new Error();
      // Force real decoding of every frame, not metadata-only magic-byte acceptance.
      await decoder.raw().toBuffer();
      return metadata;
    } catch (error) {
      if (error instanceof GcsStorageError && ["forbidden", "unavailable"].includes(error.code)) throw error;
      throw new GcsStorageError("image", "Image verification failed; details withheld.");
    } finally { imageVerificationBusy = false; }
  };
  return {
    stat, readBounded, verifyImage,
    async signRead(ref: GcsRef, ttlSeconds = 3600): Promise<string> {
      validateRef(ref); if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600 || ref.name.startsWith("_incoming/")) invalid();
      return signUrl(ref, "GET", ttlSeconds, {}, { generation: ref.generation });
    },
    async signUpload(input: GcsObject & { size: number; contentType: GcsContentType }): Promise<{ url: string; headers: Record<string, string>; expiresAt: string }> {
      validateGcsObject(input, true); validateSize(input.bucket, input.size, input.contentType);
      const headers = { "content-type": input.contentType, "x-goog-content-length-range": `${input.size},${input.size}`, "x-goog-if-generation-match": "0" };
      return { url: await signUrl(input, "PUT", 300, headers), headers, expiresAt: new Date(now() + 300_000).toISOString() };
    },
    async publish(input: { source: GcsRef; destinationName: string; binding: GcsBinding; expectedSize: number; contentType: GcsContentType }): Promise<GcsMetadata> {
      const { source, binding, expectedSize, contentType } = input;
      validateRef(source); validateGcsObject(source, true); validateGcsBinding(binding);
      const destination = { bucket: source.bucket, name: input.destinationName };
      validateGcsObject(destination);
      if (source.name !== `_incoming/${binding.reservationId}` || source.generation !== binding.sourceGeneration || !bindingMatchesName(destination, binding)) invalid();
      const verified = await verifyImage(source, expectedSize, contentType);
      const url = `${objectUrl(source)}/rewriteTo/b/${GCS_BUCKETS[destination.bucket]}/o/${encode(destination.name)}?sourceGeneration=${source.generation}&ifSourceGenerationMatch=${source.generation}&ifGenerationMatch=0`;
      const body = JSON.stringify({ contentType, contentEncoding: "identity", cacheControl: "private, no-store", contentDisposition: "inline", metadata: gcsBindingMetadata(binding) });
      const result = await json(await request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }));
      // Same bucket/location/class rewrites finish in one call; never follow arbitrary rewrite tokens.
      if (!record(result) || result.done !== true) return unavailable();
      const metadata = parseMetadata(result.resource, destination);
      if (metadata.size !== expectedSize || metadata.contentType !== contentType || metadata.crc32c !== verified.crc32c ||
          !metadata.binding || BINDING_KEYS.some((key) => metadata.binding?.[key] !== binding[key])) return unavailable();
      return metadata;
    },
    async deleteGeneration(ref: GcsRef): Promise<void> {
      validateRef(ref);
      const response = await request(`${objectUrl(ref)}?generation=${ref.generation}&ifGenerationMatch=${ref.generation}`, { method: "DELETE" }, true);
      await response?.body?.cancel();
    },
  };
}

export type GcsStorage = ReturnType<typeof createGcsStorage>;
