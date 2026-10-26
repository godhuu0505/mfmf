// Fixed-resource operator bootstrap; no app data, credentials files, keys or deploy-WIF updates.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const PROJECT = "mfmf-499612";
const NUMBER = "92772745697";
const IAM = "https://iam.googleapis.com/v1";
const STORAGE = "https://storage.googleapis.com/storage/v1";
export const OPERATOR_SA = `mfmf-storage-operator@${PROJECT}.iam.gserviceaccount.com`;
export const STORAGE_POOL = `projects/${NUMBER}/locations/global/workloadIdentityPools/mfmf-storage`;
export const STORAGE_PROVIDER = `${STORAGE_POOL}/providers/github-storage`;
export const OPERATOR_ROLE = `projects/${PROJECT}/roles/mfmfStorageOperator`;
export const OPERATOR_PERMISSIONS = ["storage.buckets.get", "storage.objects.create", "storage.objects.delete", "storage.objects.get", "storage.objects.list", "storage.objects.restore"];
export const STORAGE_CONDITION = "assertion.repository_id=='1271210275' && assertion.repository_owner_id=='19723431' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='godhuu0505/mfmf/.github/workflows/storage-migration.yml@refs/heads/main' && assertion.event_name in ['workflow_dispatch','schedule']";
const MAPPING = { "google.subject": "assertion.sub", "attribute.repository_id": "assertion.repository_id" };
const PRINCIPAL = `principalSet://iam.googleapis.com/${STORAGE_POOL}/attribute.repository_id/1271210275`;
const SA_RESOURCE = `projects/${PROJECT}/serviceAccounts/${OPERATOR_SA}`;
const MEMBER = `serviceAccount:${OPERATOR_SA}`;
const BUCKETS = [`${PROJECT}-photos`, `${PROJECT}-avatars`];
const fail = () => { throw new Error("Storage operator setup stopped; input, credentials and API details withheld. Inspect state before retrying."); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pairs = (value) => Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b));

function validatePool(pool) {
  if (pool.name !== STORAGE_POOL || pool.state !== "ACTIVE" || pool.disabled || pool.mode && pool.mode !== "DEFAULT") fail();
}
function validateProvider(provider) {
  if (provider.name !== STORAGE_PROVIDER || provider.state !== "ACTIVE" || provider.disabled ||
    provider.attributeCondition !== STORAGE_CONDITION || !same(pairs(provider.attributeMapping), pairs(MAPPING)) ||
    provider.oidc?.issuerUri !== "https://token.actions.githubusercontent.com" ||
    provider.oidc.allowedAudiences !== undefined && (!Array.isArray(provider.oidc.allowedAudiences) || provider.oidc.allowedAudiences.length !== 0) ||
    provider.oidc.jwksJson || provider.aws || provider.saml || provider.x509) fail();
}
function validateRole(role) {
  if (role.name !== OPERATOR_ROLE || role.deleted || role.stage !== "GA" || !Array.isArray(role.includedPermissions) ||
    !same([...role.includedPermissions].sort(), OPERATOR_PERMISSIONS)) fail();
}
function validateAccount(account) {
  if (account.email !== OPERATOR_SA || account.projectId !== PROJECT || account.disabled || typeof account.uniqueId !== "string" || !/^[0-9]+$/.test(account.uniqueId)) fail();
}
function addBinding(policy, role, member, strict = false) {
  if (!policy || typeof policy.etag !== "string" || !policy.etag || (policy.bindings !== undefined && !Array.isArray(policy.bindings))) fail();
  const bindings = policy.bindings ?? [];
  if (bindings.some((b) => !Array.isArray(b.members) || b.members.some((m) => ["allUsers", "allAuthenticatedUsers"].includes(m)))) fail();
  if (strict && bindings.some((b) => b.role !== role)) fail();
  const current = bindings.filter((b) => b.role === role);
  if (current.length > 1 || current.some((b) => b.condition || b.members.length !== 1 || b.members[0] !== member)) fail();
  if (current.length) return null;
  return { ...policy, version: 3, bindings: [...bindings, { role, members: [member] }] };
}

export async function bootstrapStorageOperator({ token, apply = false, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = console.log }) {
  if (typeof token !== "string" || !token || token.length > 16_384 || /[\r\n]/.test(token)) fail();
  const request = async (path, { method = "GET", body, missing = false, host = IAM } = {}) => {
    let response;
    try { response = await fetchImpl(`${host}/${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(30_000) }); } catch { fail(); }
    if (response.status === 404 && missing) { await response.body?.cancel(); return null; }
    if (!response.ok) { log(`Storage operator API stopped: ${method} HTTP ${response.status}; response details withheld.`); await response.body?.cancel(); fail(); }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 262_144) fail(); chunks.push(Buffer.from(chunk)); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { fail(); }
  };
  const finish = async (operation) => {
    const prefix = `projects/${NUMBER}/locations/global/`;
    if (typeof operation?.name !== "string" || !operation.name.startsWith(prefix) ||
      !/^(?:workloadIdentityPools\/mfmf-storage\/(?:providers\/github-storage\/)?)?operations\/[a-zA-Z0-9_-]+$/.test(operation.name.slice(prefix.length))) fail();
    const name = operation.name;
    for (let count = 0; count < 30; count++) {
      if (operation.name !== name) fail();
      if (operation.error) fail();
      if (operation.done === true) return;
      await sleep(1000); operation = await request(name);
    }
    fail();
  };
  const providerInventory = async () => {
    const list = await request(`${STORAGE_POOL}/providers?showDeleted=true`);
    if (list.nextPageToken || !Array.isArray(list.workloadIdentityPoolProviders ?? []) || (list.workloadIdentityPoolProviders ?? []).length > 1 ||
      (list.workloadIdentityPoolProviders ?? []).some((p) => p.name !== STORAGE_PROVIDER)) fail();
    for (const provider of list.workloadIdentityPoolProviders ?? []) validateProvider(provider);
  };
  const accountPolicy = () => request(`${SA_RESOURCE}:getIamPolicy`, { method: "POST", body: { options: { requestedPolicyVersion: 3 } } });
  const bucketPolicy = (bucket) => request(`b/${bucket}/iam?optionsRequestedPolicyVersion=3`, { host: STORAGE });
  // All current resources are checked before the first write; divergent policy is never repaired silently.
  const pool = await request(STORAGE_POOL, { missing: true });
  if (pool) { validatePool(pool); await providerInventory(); }
  const provider = pool ? await request(STORAGE_PROVIDER, { missing: true }) : null;
  if (provider) validateProvider(provider);
  const account = await request(SA_RESOURCE, { missing: true });
  if (account) { validateAccount(account); addBinding(await accountPolicy(), "roles/iam.workloadIdentityUser", PRINCIPAL, true); }
  const role = await request(OPERATOR_ROLE, { missing: true }); if (role) validateRole(role);
  for (const bucket of BUCKETS) {
    const config = await request(`b/${bucket}`, { host: STORAGE });
    if (config.name !== bucket || config.projectNumber !== NUMBER || config.location !== "ASIA-NORTHEAST1" || config.storageClass !== "STANDARD" ||
      config.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true || config.iamConfiguration?.publicAccessPrevention !== "enforced" ||
      config.versioning?.enabled || config.softDeletePolicy?.retentionDurationSeconds !== "604800") fail();
    addBinding(await bucketPolicy(bucket), OPERATOR_ROLE, MEMBER);
  }
  log(`Storage operator plan validated: ${[pool, provider, account, role].filter((value) => !value).length} fixed resources need creation; existing deploy identities remain outside this workflow.`);
  if (!apply) { log("Plan only; no IAM or resource changes."); return; }
  if (!pool) await finish(await request(`projects/${NUMBER}/locations/global/workloadIdentityPools?workloadIdentityPoolId=mfmf-storage`, { method: "POST", body: { displayName: "mfmf storage operations" } }));
  if (!provider) await finish(await request(`${STORAGE_POOL}/providers?workloadIdentityPoolProviderId=github-storage`, { method: "POST", body: {
    displayName: "GitHub storage main only", attributeMapping: MAPPING, attributeCondition: STORAGE_CONDITION, oidc: { issuerUri: "https://token.actions.githubusercontent.com" },
  } }));
  if (!account) validateAccount(await request(`projects/${PROJECT}/serviceAccounts`, { method: "POST", body: { accountId: "mfmf-storage-operator", serviceAccount: { displayName: "mfmf storage operator" } } }));
  if (!role) validateRole(await request(`projects/${PROJECT}/roles`, { method: "POST", body: { roleId: "mfmfStorageOperator", role: { title: "mfmf storage operator", stage: "GA", includedPermissions: OPERATOR_PERMISSIONS } } }));
  const saPolicy = addBinding(await accountPolicy(), "roles/iam.workloadIdentityUser", PRINCIPAL, true);
  if (saPolicy) await request(`${SA_RESOURCE}:setIamPolicy`, { method: "POST", body: { policy: saPolicy } });
  for (const bucket of BUCKETS) {
    const policy = addBinding(await bucketPolicy(bucket), OPERATOR_ROLE, MEMBER);
    if (policy) await request(`b/${bucket}/iam`, { host: STORAGE, method: "PUT", body: policy });
  }
  validatePool(await request(STORAGE_POOL)); await providerInventory(); validateProvider(await request(STORAGE_PROVIDER));
  validateAccount(await request(SA_RESOURCE)); validateRole(await request(OPERATOR_ROLE));
  if (addBinding(await accountPolicy(), "roles/iam.workloadIdentityUser", PRINCIPAL, true)) fail();
  for (const bucket of BUCKETS) if (addBinding(await bucketPolicy(bucket), OPERATOR_ROLE, MEMBER)) fail();
  log("Storage operator verified: dedicated main-only manual/schedule WIF, keyless SA, six permissions on two buckets only.");
}

async function main() {
  if (process.argv.length > 3 || process.argv[2] && process.argv[2] !== "--apply") fail();
  let token;
  try { token = (await promisify(execFile)("gcloud", ["auth", "print-access-token", "--quiet"], { encoding: "utf8", maxBuffer: 16_384 })).stdout.trim(); } catch { fail(); }
  await bootstrapStorageOperator({ token, apply: process.argv[2] === "--apply" });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error("Storage operator setup failed; credentials and API details withheld. Inspect state before retrying."); process.exitCode = 1;
});
