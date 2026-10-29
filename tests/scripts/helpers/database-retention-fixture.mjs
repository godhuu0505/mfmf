import { plan } from "../../../scripts/gcp/bootstrap-database.mjs";
import { RETENTION, retentionImplementationSha256 } from "../../../scripts/gcp/database-backup-retention.mjs";
export const CLOCK = Date.parse("2026-10-28T00:00:00Z");
export const SHA = "a".repeat(40);
export const BIRTH = "2026-01-01T00:00:00Z";
export const API = "https://sqladmin.googleapis.com/v1/projects/mfmf-499612";
export const META = `https://storage.googleapis.com/storage/v1/b/${RETENTION.bucket}/o/${encodeURIComponent(RETENTION.object)}`;
export function instance() {
  return { ...structuredClone(plan().resources.instance), createTime: BIRTH, state: "RUNNABLE", backendType: "SECOND_GEN",
    instanceType: "CLOUD_SQL_INSTANCE", ipAddresses: [{ type: "PRIVATE", ipAddress: "10.85.0.3" }],
    settings: { ...structuredClone(plan().resources.instance.settings), settingsVersion: "1" } };
}
export async function receipt(extra = {}) {
  return { format: RETENTION.format, policy: RETENTION.policy, implementationSha256: await retentionImplementationSha256(), sourceCommit: SHA,
    project: RETENTION.project, instance: RETENTION.instance, instanceCreateTime: BIRTH, status: "success",
    startedAt: new Date(CLOCK - 60000).toISOString(), completedAt: new Date(CLOCK - 30000).toISOString(),
    listedCount: 1, deletedCount: 0, onDemandCount: 0, onDemandBytes: "0", ...extra };
}
export function backup(id = "fixture-backup", ageDays = 0, extra = {}) {
  return { name: `projects/mfmf-499612/backups/${id}`, instance: "mfmf-db", description: `mfmf-managed-preupgrade-v1:${SHA}`,
    type: "ON_DEMAND", state: "SUCCESSFUL", location: "asia-northeast1", databaseVersion: "POSTGRES_17", backupKind: "SNAPSHOT",
    maxChargeableBytes: "1000", backupInterval: { startTime: new Date(CLOCK - ageDays * 86400000 - 30000).toISOString(),
      endTime: new Date(CLOCK - ageDays * 86400000).toISOString() }, ...extra };
}
export async function fixture({ rows = [], saved = backup(), proof, resource = instance(), hook, summaryOnly = true, operation = {} } = {}) {
  if (proof === undefined) proof = await receipt();
  const state = { rows: new Map(rows.map(b => [b.name, structuredClone(b)])), resource, proof, generation: proof ? "100" : "0", calls: [], deleted: [], writes: [] };
  const metadata = () => ({ bucket: RETENTION.bucket, name: RETENTION.object, generation: state.generation,
    contentType: "application/json", size: String(Buffer.byteLength(JSON.stringify(state.proof))) });
  const fetchImpl = async (url, init) => {
    state.calls.push({ url, init });
    if (hook) { const response = await hook(url, init, state); if (response !== undefined) return response; }
    if (url === `${API}/instances/mfmf-db`) return Response.json(state.resource);
    if (url.startsWith(`${API}/operations?`)) return Response.json({ items: [] });
    if (url === META) return state.proof ? Response.json(metadata()) : new Response(null, { status: 404 });
    if (url.startsWith(`${META}?`)) {
      if (new URL(url).searchParams.get("generation") !== state.generation) return new Response(null, { status: 404 });
      return Response.json(state.proof);
    }
    if (url.startsWith(`https://storage.googleapis.com/upload/storage/v1/b/${RETENTION.bucket}/o?`)) {
      if (new URL(url).searchParams.get("ifGenerationMatch") !== state.generation) return new Response(null, { status: 412 });
      state.proof = JSON.parse(init.body); state.generation = String(Number(state.generation) + 1); state.writes.push(structuredClone(state.proof));
      return Response.json(metadata());
    }
    if (url.startsWith(`${API}/backups?`)) return Response.json({ backups: [...state.rows.values()].map(b => summaryOnly ? { name: b.name, instance: b.instance, type: b.type } : b) });
    if (url === `${API}/backups` && init.method === "POST") {
      state.rows.set(saved.name, structuredClone(saved));
      return Response.json({ name: "create-op", targetProject: "mfmf-499612", targetId: "mfmf-db", operationType: "BACKUP_VOLUME", status: "DONE", backupContext: { name: saved.name }, ...operation });
    }
    if (url.startsWith(`${API}/backups/`)) {
      const name = url.slice("https://sqladmin.googleapis.com/v1/".length);
      if (init.method === "DELETE") {
        state.deleted.push(name); state.rows.delete(name);
        return Response.json({ name: "delete-op", targetProject: "mfmf-499612", targetId: "mfmf-db", operationType: "DELETE_BACKUP", status: "DONE", ...operation });
      }
      return state.rows.has(name) ? Response.json(state.rows.get(name)) : new Response(null, { status: 404 });
    }
    if (url.includes("/operations/")) return Response.json({ name: "delete-op", targetProject: "mfmf-499612", targetId: "mfmf-db", operationType: "DELETE_BACKUP", status: "DONE", ...operation });
    throw new Error("PRIVATE_UNEXPECTED_URL");
  };
  return { state, fetchImpl };
}
