import { describe, expect, it, vi } from "vitest";
import { bootstrapStorageOperator, OPERATOR_PERMISSIONS, OPERATOR_ROLE, OPERATOR_SA, STORAGE_CONDITION, STORAGE_POOL, STORAGE_PROVIDER } from "../../scripts/gcp/bootstrap-storage-operator.mjs";
import { storageBucketConfig } from "../../scripts/gcp/bootstrap-storage.mjs";

const accountPath = `projects/mfmf-499612/serviceAccounts/${OPERATOR_SA}`;
type Policy = { etag: string; bindings: { role: string; members: string[]; condition?: object }[] };
function harness() {
  const resources = new Map<string, Record<string, unknown>>(); const policies = new Map<string, Policy>();
  for (const suffix of ["photos", "avatars"]) {
    const bucket = `mfmf-499612-${suffix}`;
    resources.set(`b/${bucket}`, { ...storageBucketConfig(bucket), projectNumber: "92772745697" });
    policies.set(`b/${bucket}/iam`, { etag: "bucket-etag", bindings: [{ role: "projects/mfmf-499612/roles/mfmfStorageObjectAccess", members: ["serviceAccount:mfmf-runtime@mfmf-499612.iam.gserviceaccount.com"] }] });
  }
  let conflict = false;
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], options: RequestInit = {}) => {
    const url = new URL(String(input)); const path = url.pathname.replace(/^\/(?:storage\/)?v1\//, "");
    const body = options.body ? JSON.parse(String(options.body)) : null;
    expect(options.redirect).toBe("error"); expect(options.headers).toHaveProperty("Authorization", "Bearer private-token-marker");
    if (path.endsWith("/providers") && options.method === "GET") return Response.json({ workloadIdentityPoolProviders: [...resources.values()].filter((v) => String(v.name).startsWith(`${STORAGE_POOL}/providers/`)) });
    if (path.endsWith("/iam") || path.endsWith(":getIamPolicy") || path.endsWith(":setIamPolicy")) {
      const key = path.replace(/:(get|set)IamPolicy$/, ":policy");
      const policy = policies.get(key) ?? { etag: "account-etag", bindings: [] };
      if (options.method === "PUT" || path.endsWith(":setIamPolicy")) {
        if (conflict) return new Response("private-api-marker", { status: 409 });
        const next = body.policy ?? body; expect(next.etag).toBe(policy.etag); policies.set(key, next); return Response.json(next);
      }
      return Response.json(policy);
    }
    if (options.method === "POST") {
      if (path.endsWith("/workloadIdentityPools")) {
        expect(url.searchParams.get("workloadIdentityPoolId")).toBe("mfmf-storage"); resources.set(STORAGE_POOL, { ...body, name: STORAGE_POOL, state: "ACTIVE" });
        return Response.json({ name: `${STORAGE_POOL}/operations/create`, done: true });
      }
      if (path.endsWith("/providers")) {
        expect(url.searchParams.get("workloadIdentityPoolProviderId")).toBe("github-storage"); resources.set(STORAGE_PROVIDER, { ...body, name: STORAGE_PROVIDER, state: "ACTIVE" });
        return Response.json({ name: `${STORAGE_PROVIDER}/operations/create`, done: true });
      }
      if (path.endsWith("/serviceAccounts")) {
        expect(body.accountId).toBe("mfmf-storage-operator"); resources.set(accountPath, { email: OPERATOR_SA, projectId: "mfmf-499612", uniqueId: "1234567890" }); return Response.json(resources.get(accountPath));
      }
      if (path.endsWith("/roles")) {
        expect(body.roleId).toBe("mfmfStorageOperator"); resources.set(OPERATOR_ROLE, { ...body.role, name: OPERATOR_ROLE }); return Response.json(resources.get(OPERATOR_ROLE));
      }
      throw new Error("unexpected mutation");
    }
    return resources.has(path) ? Response.json(resources.get(path)) : new Response(null, { status: 404 });
  });
  return { resources, policies, fetchImpl, log: vi.fn(), sleep: vi.fn(async () => {}), setConflict: () => { conflict = true; } };
}
const mutateCalls = (h: ReturnType<typeof harness>) => h.fetchImpl.mock.calls.filter(([input, options]) => options?.method !== "GET" && !String(input).endsWith(":getIamPolicy"));

describe("dedicated storage operator bootstrap", () => {
  it("plans with read-only calls and never creates deploy, runtime, secret or key resources", async () => {
    const h = harness(); await bootstrapStorageOperator({ ...h, token: "private-token-marker" });
    expect(mutateCalls(h)).toHaveLength(0); expect(h.resources.size).toBe(2);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("private-token-marker");
  });
  it("creates only fixed identities, exact six-permission role and bucket grants, then is idempotent", async () => {
    const h = harness(); await bootstrapStorageOperator({ ...h, token: "private-token-marker", apply: true });
    expect(h.resources.size).toBe(6); expect(h.resources.get(OPERATOR_ROLE)?.includedPermissions).toEqual(OPERATOR_PERMISSIONS);
    const provider = h.resources.get(STORAGE_PROVIDER)!;
    expect(provider.attributeMapping).toEqual({ "google.subject": "assertion.sub", "attribute.repository_id": "assertion.repository_id" });
    expect(provider.attributeCondition).toBe("assertion.repository_id=='1271210275' && assertion.repository_owner_id=='19723431' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='godhuu0505/mfmf/.github/workflows/storage-migration.yml@refs/heads/main' && assertion.event_name in ['workflow_dispatch','schedule']");
    expect(provider.attributeCondition).toBe(STORAGE_CONDITION);
    const policy = h.policies.get(`${accountPath}:policy`)!;
    expect(policy.bindings).toEqual([{ role: "roles/iam.workloadIdentityUser", members: [`principalSet://iam.googleapis.com/${STORAGE_POOL}/attribute.repository_id/1271210275`] }]);
    for (const suffix of ["photos", "avatars"]) expect(h.policies.get(`b/mfmf-499612-${suffix}/iam`)?.bindings).toHaveLength(2);
    expect(h.fetchImpl.mock.calls.some(([url]) => /mfmf-github|mfmf-deploy|\/keys|secretmanager|run.googleapis/.test(String(url)))).toBe(false);
    h.fetchImpl.mockClear(); await bootstrapStorageOperator({ ...h, token: "private-token-marker", apply: true }); expect(mutateCalls(h)).toHaveLength(0);
  });
  it.each(["condition", "issuer", "audience", "mapping", "disabled", "other-provider", "permissions", "principal", "public", "foreign-project"])("refuses divergent %s before mutating anything", async (failure) => {
    const h = harness(); await bootstrapStorageOperator({ ...h, token: "private-token-marker", apply: true });
    const provider = h.resources.get(STORAGE_PROVIDER)!;
    if (failure === "condition") provider.attributeCondition = "true";
    if (failure === "issuer") provider.oidc = { issuerUri: "https://attacker.invalid" };
    if (failure === "audience") provider.oidc = { issuerUri: "https://token.actions.githubusercontent.com", allowedAudiences: ["other"] };
    if (failure === "mapping") provider.attributeMapping = { "google.subject": "assertion.sub" };
    if (failure === "disabled") provider.disabled = true;
    if (failure === "other-provider") h.resources.set("other", { ...provider, name: `${STORAGE_POOL}/providers/other` });
    if (failure === "permissions") h.resources.get(OPERATOR_ROLE)!.includedPermissions = [...OPERATOR_PERMISSIONS, "storage.buckets.setIamPolicy"];
    if (failure === "principal") h.policies.get(`${accountPath}:policy`)!.bindings[0].members.push("user:other@example.invalid");
    if (failure === "public") h.policies.get("b/mfmf-499612-photos/iam")!.bindings[0].members.push("allUsers");
    if (failure === "foreign-project") h.resources.get("b/mfmf-499612-photos")!.projectNumber = "1";
    h.fetchImpl.mockClear(); await expect(bootstrapStorageOperator({ ...h, token: "private-token-marker", apply: true })).rejects.toThrow("details withheld"); expect(mutateCalls(h)).toHaveLength(0);
  });
  it("stops after one IAM conflict, preserves partial state and withholds response bodies", async () => {
    const h = harness(); h.setConflict(); await expect(bootstrapStorageOperator({ ...h, token: "private-token-marker", apply: true })).rejects.toThrow("details withheld");
    expect(mutateCalls(h)).toHaveLength(5); expect(JSON.stringify(h.log.mock.calls)).not.toMatch(/private-token-marker|private-api-marker/);
    expect(h.log).toHaveBeenCalledWith("Storage operator API stopped: POST HTTP 409; response details withheld.");
  });
  it("rejects an operation URL outside the fixed resource without following it", async () => {
    const h = harness(); const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (args[1]?.method === "POST" && String(args[0]).includes("workloadIdentityPoolId=")) return Response.json({ name: "https://attacker.invalid/private-marker", done: false });
      return h.fetchImpl(...args);
    });
    await expect(bootstrapStorageOperator({ ...h, fetchImpl, token: "private-token-marker", apply: true })).rejects.toThrow("details withheld");
    expect(fetchImpl.mock.calls.some(([url]) => String(url).startsWith("https://attacker.invalid"))).toBe(false);
  });
});
