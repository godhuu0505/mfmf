import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const PROJECT = "mfmf-499612";
const PROJECT_NUMBER = "92772745697";
const RUNTIME = `mfmf-runtime@${PROJECT}.iam.gserviceaccount.com`;
export const STORAGE_ORIGIN = "https://mfmf-candidate-wspqvmhj6q-an.a.run.app";
const IAM = "https://iam.googleapis.com/v1";
const STORAGE = "https://storage.googleapis.com/storage/v1";
const SA = `${IAM}/projects/${PROJECT}/serviceAccounts/${RUNTIME}`;
const BUCKETS = [`${PROJECT}-photos`, `${PROJECT}-avatars`];
const OBJECT_ROLE = `projects/${PROJECT}/roles/mfmfStorageObjectAccess`;
const SIGN_ROLE = `projects/${PROJECT}/roles/mfmfStorageSignBlob`;
const ROLES = [
  { name: OBJECT_ROLE, title: "mfmf storage object access", includedPermissions: ["storage.objects.create", "storage.objects.delete", "storage.objects.get"] },
  { name: SIGN_ROLE, title: "mfmf storage signing", includedPermissions: ["iam.serviceAccounts.signBlob"] },
];
export class StorageSetupError extends Error {}
const fail = () => { throw new StorageSetupError("Storage setup stopped; credentials, input and API details withheld. Inspect configuration before retrying."); };
const sorted = (values) => [...values].sort();
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

export function storageBucketConfig(name, extraOrigins = []) {
  if (!BUCKETS.includes(name) || !Array.isArray(extraOrigins) || extraOrigins.length > 2) fail();
  for (const origin of extraOrigins) {
    if (typeof origin !== "string" || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(origin)) fail();
  }
  const origins = sorted([...new Set([STORAGE_ORIGIN, ...extraOrigins])]);
  return {
    name, location: "ASIA-NORTHEAST1", storageClass: "STANDARD",
    iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" },
    versioning: { enabled: false }, softDeletePolicy: { retentionDurationSeconds: "604800" },
    cors: [{ origin: origins, method: ["GET", "HEAD", "PUT"], responseHeader: ["Content-Type", "x-goog-content-length-range", "x-goog-if-generation-match", "x-goog-generation", "x-goog-hash"], maxAgeSeconds: 300 }],
    lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 1, matchesPrefix: ["_incoming/"] } }] },
    labels: { app: "mfmf", purpose: name.endsWith("photos") ? "photos" : "avatars" },
  };
}

function validateBucket(bucket, desired) {
  if (!isObject(bucket) || bucket.name !== desired.name || bucket.projectNumber !== PROJECT_NUMBER ||
      bucket.location !== desired.location || bucket.storageClass !== "STANDARD" ||
      bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true || bucket.iamConfiguration?.publicAccessPrevention !== "enforced" ||
      bucket.versioning?.enabled === true || bucket.softDeletePolicy?.retentionDurationSeconds !== "604800" ||
      bucket.hierarchicalNamespace?.enabled || bucket.retentionPolicy || bucket.autoclass?.enabled || bucket.encryption?.defaultKmsKeyName ||
      !same(bucket.lifecycle, desired.lifecycle) || !Array.isArray(bucket.cors) || bucket.cors.length !== 1) fail();
  const cors = bucket.cors[0]; const expected = desired.cors[0];
  if (!Array.isArray(cors.origin) || !Array.isArray(cors.method) || !Array.isArray(cors.responseHeader) ||
      !same(sorted(cors.origin), expected.origin) || !same(sorted(cors.method), sorted(expected.method)) ||
      !same(sorted(cors.responseHeader.map((s) => s.toLowerCase())), sorted(expected.responseHeader.map((s) => s.toLowerCase()))) || cors.maxAgeSeconds !== 300) fail();
}

function withBinding(policy, role) {
  if (!isObject(policy) || typeof policy.etag !== "string" || !policy.etag || (policy.bindings !== undefined && !Array.isArray(policy.bindings))) fail();
  if (policy.bindings?.some((binding) => !Array.isArray(binding.members) || binding.members.some((member) => ["allUsers", "allAuthenticatedUsers"].includes(member)))) fail();
  const next = structuredClone(policy);
  next.version = 3;
  next.bindings ??= [];
  const existing = next.bindings.filter((b) => b.role === role);
  if (existing.length > 1 || existing.some((b) => b.condition || !Array.isArray(b.members))) fail();
  const member = `serviceAccount:${RUNTIME}`;
  if (existing[0]?.members.includes(member)) return null;
  if (existing.length) existing[0].members.push(member);
  else next.bindings.push({ role, members: [member] });
  return next;
}

export async function bootstrapStorage({ token, origins = [], apply = false, fetchImpl = fetch, log = console.log }) {
  if (typeof token !== "string" || !token || /[\r\n]/.test(token)) fail();
  const configs = BUCKETS.map((name) => storageBucketConfig(name, origins));
  const request = async (url, { method = "GET", body, missing = false } = {}) => {
    let response;
    try { response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(30_000) }); } catch { fail(); }
    if (response.status === 404 && missing) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); fail(); }
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 262_144) fail(); chunks.push(Buffer.from(chunk)); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { fail(); }
  };
  // Validate every existing resource before performing the first mutation.
  const absentRoles = [];
  for (const role of ROLES) {
    const actual = await request(`${IAM}/${role.name}`, { missing: true });
    if (actual === null) absentRoles.push(role);
    else if (!isObject(actual) || actual.name !== role.name || actual.deleted || actual.stage !== "GA" ||
        !Array.isArray(actual.includedPermissions) || !same(sorted(actual.includedPermissions), sorted(role.includedPermissions))) fail();
  }
  const absentBuckets = [];
  for (const config of configs) {
    const actual = await request(`${STORAGE}/b/${config.name}`, { missing: true });
    if (actual === null) absentBuckets.push(config);
    else { validateBucket(actual, config); withBinding(await request(`${STORAGE}/b/${config.name}/iam?optionsRequestedPolicyVersion=3`), OBJECT_ROLE); }
  }
  const servicePolicy = await request(`${SA}:getIamPolicy`, { method: "POST", body: { options: { requestedPolicyVersion: 3 } } });
  withBinding(servicePolicy, SIGN_ROLE);
  log(`Storage plan validated: ${absentBuckets.length} buckets and ${absentRoles.length} custom roles need creation. Runtime receives object get/create/delete and self signBlob only.`);
  if (!apply) { log("Plan only; no resource or IAM policy was changed."); return; }
  for (const role of absentRoles) {
    await request(`${IAM}/projects/${PROJECT}/roles`, { method: "POST", body: { roleId: role.name.split("/").at(-1), role: { title: role.title, stage: "GA", includedPermissions: role.includedPermissions } } });
  }
  for (const config of absentBuckets) await request(`${STORAGE}/b?project=${PROJECT}`, { method: "POST", body: config });
  for (const config of configs) {
    validateBucket(await request(`${STORAGE}/b/${config.name}`), config);
    const policy = withBinding(await request(`${STORAGE}/b/${config.name}/iam?optionsRequestedPolicyVersion=3`), OBJECT_ROLE);
    if (policy) await request(`${STORAGE}/b/${config.name}/iam`, { method: "PUT", body: policy });
  }
  const signPolicy = withBinding(await request(`${SA}:getIamPolicy`, { method: "POST", body: { options: { requestedPolicyVersion: 3 } } }), SIGN_ROLE);
  if (signPolicy) await request(`${SA}:setIamPolicy`, { method: "POST", body: { policy: signPolicy } });
  // Post-read verifies the narrow policy and all data protection settings; no automatic retry on conflicts.
  for (const config of configs) {
    validateBucket(await request(`${STORAGE}/b/${config.name}`), config);
    if (withBinding(await request(`${STORAGE}/b/${config.name}/iam?optionsRequestedPolicyVersion=3`), OBJECT_ROLE)) fail();
  }
  if (withBinding(await request(`${SA}:getIamPolicy`, { method: "POST", body: { options: { requestedPolicyVersion: 3 } } }), SIGN_ROLE)) fail();
  log("Storage bootstrap verified: two private Tokyo buckets, incoming-only lifecycle, seven-day soft delete and narrowly scoped runtime IAM.");
}

async function main() {
  const args = process.argv.slice(2); const origins = []; let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply" && !apply) apply = true;
    else if (args[i] === "--origin" && args[i + 1]) origins.push(args[++i]);
    else fail();
  }
  storageBucketConfig(BUCKETS[0], origins);
  let token;
  try { const result = await promisify(execFile)("gcloud", ["auth", "print-access-token", "--quiet"], { encoding: "utf8", maxBuffer: 16_384 }); token = result.stdout.trim(); } catch { fail(); }
  await bootstrapStorage({ token, origins, apply });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Storage setup failed; credentials, input and API details withheld. Inspect before retrying."); process.exitCode = 1; });
}
