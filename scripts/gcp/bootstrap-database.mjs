#!/usr/bin/env node
// Operator-only, create-or-verify. No IAM, password, SQL, API enable, patch or delete.
// Schema: https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances
// PSA: https://docs.cloud.google.com/service-infrastructure/docs/service-networking/reference/rest/v1/services.connections/create
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const PROJECT = "mfmf-499612";
export const PROJECT_NUMBER = "92772745697";
export const REGION = "asia-northeast1";
export const NETWORK = "mfmf-db-network";
export const SUBNET = "mfmf-app-tokyo";
export const RANGE = "mfmf-sql-peering";
export const INSTANCE = "mfmf-db";
const COMPUTE = `https://compute.googleapis.com/compute/v1/projects/${PROJECT}`;
const SQL = `https://sqladmin.googleapis.com/v1/projects/${PROJECT}`;
const SERVICE = "https://servicenetworking.googleapis.com/v1";
const PEERING = "servicenetworking-googleapis-com";
const NETWORK_NUMBER_PATH = `projects/${PROJECT_NUMBER}/global/networks/${NETWORK}`;
const NETWORK_ID_PATH = `projects/${PROJECT}/global/networks/${NETWORK}`;
const SERVICES = ["compute.googleapis.com", "sqladmin.googleapis.com", "servicenetworking.googleapis.com"];
const STAGES = new Set(["arguments", "credentials", "project", "apis", "network", "subnet", "range", "peering", "instance", "verify", "interrupted"]);
const CONFLICT = Symbol("conflict");
const clone = (value) => structuredClone(value);

export const URLS = Object.freeze({
  project: `https://cloudresourcemanager.googleapis.com/v3/projects/${PROJECT}`,
  network: `${COMPUTE}/global/networks/${NETWORK}`,
  subnet: `${COMPUTE}/regions/${REGION}/subnetworks/${SUBNET}`,
  range: `${COMPUTE}/global/addresses/${RANGE}`,
  peering: `${SERVICE}/services/servicenetworking.googleapis.com/connections?network=${encodeURIComponent(NETWORK_NUMBER_PATH)}`,
  instance: `${SQL}/instances/${INSTANCE}`,
});
const PAYLOADS = {
  network: { name: NETWORK, autoCreateSubnetworks: false, routingConfig: { routingMode: "REGIONAL" } },
  subnet: { name: SUBNET, network: URLS.network, ipCidrRange: "10.84.0.0/26",
    privateIpGoogleAccess: true, stackType: "IPV4_ONLY", purpose: "PRIVATE" },
  range: { name: RANGE, addressType: "INTERNAL", purpose: "VPC_PEERING", address: "10.85.0.0",
    prefixLength: 16, network: URLS.network, ipVersion: "IPV4" },
  peering: { network: NETWORK_NUMBER_PATH, reservedPeeringRanges: [RANGE] },
  instance: { name: INSTANCE, project: PROJECT, region: REGION, databaseVersion: "POSTGRES_17",
    settings: { tier: "db-f1-micro", edition: "ENTERPRISE", availabilityType: "ZONAL",
      activationPolicy: "ALWAYS", pricingPlan: "PER_USE", dataDiskType: "PD_SSD", dataDiskSizeGb: "10",
      storageAutoResize: true, storageAutoResizeLimit: "20", deletionProtectionEnabled: true,
      connectorEnforcement: "REQUIRED", retainBackupsOnDelete: true,
      finalBackupConfig: { enabled: true, retentionDays: 30 },
      ipConfiguration: { ipv4Enabled: false, authorizedNetworks: [], privateNetwork: URLS.network,
        allocatedIpRange: RANGE, sslMode: "ENCRYPTED_ONLY", enablePrivatePathForGoogleCloudServices: false },
      backupConfiguration: { enabled: true, startTime: "18:00", location: REGION,
        pointInTimeRecoveryEnabled: true, transactionLogRetentionDays: 7,
        backupRetentionSettings: { retentionUnit: "COUNT", retainedBackups: 14 } },
    } },
};

export function plan() {
  return { mode: "plan", project: PROJECT, projectNumber: PROJECT_NUMBER, resources: clone(PAYLOADS),
    budget: { targetJpyPerMonth: 3000, hardCap: false, autoResizeMaximumGiB: 20 },
    note: "No requests or credentials used. Existing resources and restore readiness are not verified." };
}
export class BootstrapError extends Error {
  constructor(stage, httpStatus) {
    super("Database bootstrap failed; inspect fixed stage and retry only after verifying existing resources.");
    this.stage = STAGES.has(stage) ? stage : "arguments";
    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) this.httpStatus = httpStatus;
  }
}
export function diagnostic(error) {
  return { status: "failed", stage: error instanceof BootstrapError ? error.stage : "arguments",
    ...(error instanceof BootstrapError && error.httpStatus ? { httpStatus: error.httpStatus } : {}) };
}
const requireValue = (ok, stage) => { if (!ok) throw new BootstrapError(stage); };
const empty = (value) => value === undefined || (Array.isArray(value) && value.length === 0);
const networkMatches = (value) => [URLS.network, NETWORK_ID_PATH, `/${NETWORK_ID_PATH}`,
  NETWORK_NUMBER_PATH, `https://www.googleapis.com/compute/v1/${NETWORK_ID_PATH}`].includes(value);
const resourceMatches = (value, expected) => value === expected
  || value === expected.replace("https://compute.googleapis.com/", "https://www.googleapis.com/");
const validId = (id) => typeof id === "string" && /^[1-9][0-9]{0,19}$/.test(id);

export function validateResource(kind, value, requirePeering = false) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), kind);
  if (kind === "network") {
    requireValue(validId(value.id) && value.name === NETWORK && resourceMatches(value.selfLink, URLS.network)
      && value.autoCreateSubnetworks === false && value.routingConfig?.routingMode === "REGIONAL", kind);
    requireValue(empty(value.subnetworks) || (Array.isArray(value.subnetworks) && value.subnetworks.length === 1
      && resourceMatches(value.subnetworks[0], URLS.subnet)), kind);
    requireValue(empty(value.peerings) || (Array.isArray(value.peerings) && value.peerings.length === 1
      && value.peerings[0].name === PEERING && value.peerings[0].importCustomRoutes !== true
      && value.peerings[0].exportCustomRoutes !== true), kind);
    if (requirePeering) requireValue(value.peerings?.length === 1 && value.peerings[0].state === "ACTIVE", kind);
  } else if (kind === "subnet") {
    requireValue(validId(value.id) && value.name === SUBNET && resourceMatches(value.selfLink, URLS.subnet)
      && networkMatches(value.network) && resourceMatches(value.region, `${COMPUTE}/regions/${REGION}`)
      && value.ipCidrRange === "10.84.0.0/26" && value.privateIpGoogleAccess === true
      && (value.stackType ?? "IPV4_ONLY") === "IPV4_ONLY" && (value.purpose ?? "PRIVATE") === "PRIVATE"
      && empty(value.secondaryIpRanges) && !value.externalIpv6Prefix && !value.internalIpv6Prefix
      && value.logConfig?.enable !== true && value.enableFlowLogs !== true, kind);
  } else if (kind === "range") {
    requireValue(validId(value.id) && value.name === RANGE && resourceMatches(value.selfLink, URLS.range)
      && networkMatches(value.network) && value.addressType === "INTERNAL" && value.purpose === "VPC_PEERING"
      && value.address === "10.85.0.0" && value.prefixLength === 16
      && (value.ipVersion ?? "IPV4") === "IPV4" && ["RESERVED", "IN_USE"].includes(value.status), kind);
  } else if (kind === "peering") {
    requireValue(value.network === NETWORK_NUMBER_PATH && value.service === "services/servicenetworking.googleapis.com"
      && value.peering === PEERING && Array.isArray(value.reservedPeeringRanges)
      && value.reservedPeeringRanges.length === 1 && value.reservedPeeringRanges[0] === RANGE, kind);
  } else if (kind === "instance") {
    const s = value.settings;
    const ip = s?.ipConfiguration;
    const backup = s?.backupConfiguration;
    requireValue(value.name === INSTANCE && value.project === PROJECT && value.region === REGION
      && value.databaseVersion === "POSTGRES_17" && value.backendType === "SECOND_GEN"
      && value.instanceType === "CLOUD_SQL_INSTANCE" && value.state === "RUNNABLE"
      && !value.masterInstanceName && empty(value.replicaNames) && !value.failoverReplica?.name, kind);
    requireValue(s?.tier === "db-f1-micro" && s.edition === "ENTERPRISE" && s.availabilityType === "ZONAL"
      && s.activationPolicy === "ALWAYS" && s.pricingPlan === "PER_USE" && s.dataDiskType === "PD_SSD"
      && typeof s.dataDiskSizeGb === "string" && /^(1[0-9]|20)$/.test(s.dataDiskSizeGb)
      && s.storageAutoResize === true && s.storageAutoResizeLimit === "20"
      && s.deletionProtectionEnabled === true && s.connectorEnforcement === "REQUIRED"
      && s.retainBackupsOnDelete === true && s.finalBackupConfig?.enabled === true
      && s.finalBackupConfig.retentionDays === 30 && empty(s.databaseFlags)
      && s.insightsConfig?.queryInsightsEnabled !== true && s.connectionPoolConfig?.connectionPoolingEnabled !== true, kind);
    requireValue(ip?.ipv4Enabled === false && empty(ip.authorizedNetworks) && networkMatches(ip.privateNetwork)
      && ip.allocatedIpRange === RANGE && ip.sslMode === "ENCRYPTED_ONLY"
      && ip.enablePrivatePathForGoogleCloudServices !== true && ip.pscConfig?.pscEnabled !== true, kind);
    requireValue(Array.isArray(value.ipAddresses) && value.ipAddresses.length === 1
      && value.ipAddresses[0].type === "PRIVATE"
      && /^10\.85\.(?:[0-9]{1,3})\.(?:[0-9]{1,3})$/.test(value.ipAddresses[0].ipAddress)
      && value.ipAddresses[0].ipAddress.split(".").every((part) => Number(part) <= 255), kind);
    requireValue(backup?.enabled === true && backup.startTime === "18:00" && backup.location === REGION
      && backup.pointInTimeRecoveryEnabled === true && backup.transactionLogRetentionDays === 7
      && backup.backupRetentionSettings?.retentionUnit === "COUNT"
      && backup.backupRetentionSettings.retainedBackups === 14, kind);
  } else throw new BootstrapError("arguments");
  return value;
}

// The default path is offline. Only --apply reads this token; no gcloud/ADC/env files.
export async function bootstrap({ apply = false, env = process.env, fetchImpl = fetch,
  signal = AbortSignal.timeout(45 * 60_000), sleepImpl = (ms) => sleep(ms, undefined, { signal }),
  maxPolls = 240, onProgress = () => {} } = {}) {
  if (!apply) return plan();
  let stage = "credentials";
  const token = env.GCP_ACCESS_TOKEN;
  const observedIds = new Map();
  const created = [];
  const reused = [];
  try {
    requireValue(typeof token === "string" && token.length > 0 && token.length <= 16384 && !/[\r\n\0]/.test(token), stage);
    async function api(url, { method = "GET", body, missing = false, conflict = false } = {}) {
      const response = await fetchImpl(url, { method, redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        headers: { Authorization: `Bearer ${token}`, "X-Goog-User-Project": PROJECT,
          ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.status === 404 && missing) { await response.body?.cancel().catch(() => {}); return null; }
      if (response.status === 409 && conflict) { await response.body?.cancel().catch(() => {}); return CONFLICT; }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new BootstrapError(stage, response.status); }
      const chunks = []; let bytes = 0;
      requireValue(response.body, stage);
      for await (const chunk of response.body) {
        bytes += chunk.length; requireValue(bytes <= 256 * 1024, stage); chunks.push(Buffer.from(chunk));
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    }
    function remember(kind, value, requiredPeering = false) {
      validateResource(kind, value, requiredPeering);
      if (value.id) {
        requireValue(!observedIds.has(kind) || observedIds.get(kind) === value.id, kind);
        observedIds.set(kind, value.id);
      }
      return value;
    }
    async function read(kind) {
      const value = await api(URLS[kind], { missing: kind !== "peering" });
      if (kind !== "peering") return value === null ? null : remember(kind, value);
      requireValue(value && (value.connections === undefined || Array.isArray(value.connections)), stage);
      const rows = value.connections ?? [];
      requireValue(rows.length <= 1, stage);
      return rows.length ? remember(kind, rows[0]) : null;
    }
    async function waitOperation(initial, family, scope, expectedTarget) {
      let op = initial;
      const name = initial?.name;
      const operationName = family === "peering" ? /^operations\/[A-Za-z0-9._-]{1,200}$/ : /^[A-Za-z0-9_-]{1,200}$/;
      requireValue(typeof name === "string" && operationName.test(name), stage);
      const url = family === "peering" ? `${SERVICE}/${name}`
        : family === "sql" ? `${SQL}/operations/${name}` : `${COMPUTE}/${scope}/operations/${name}`;
      for (let i = 0; i <= maxPolls; i++) {
        requireValue(op?.name === name && !op.error && !op.httpErrorStatusCode, stage);
        if (family === "peering") {
          if (op.done === true) return;
          requireValue(op.done === false || op.done === undefined, stage);
        } else {
          if (family === "sql") requireValue(op.targetProject === PROJECT && op.targetId === INSTANCE && op.operationType === "CREATE", stage);
          else requireValue(op.operationType === "insert" && resourceMatches(op.targetLink, expectedTarget), stage);
          requireValue(["PENDING", "RUNNING", "DONE"].includes(op.status), stage);
          if (op.status === "DONE") return;
        }
        requireValue(i < maxPolls && !signal.aborted, stage);
        await sleepImpl(5000);
        op = await api(url);
      }
    }
    stage = "project";
    const project = await api(URLS.project);
    requireValue(project.projectId === PROJECT && project.name === `projects/${PROJECT_NUMBER}` && project.state === "ACTIVE", stage);
    stage = "apis";
    for (const service of SERVICES) {
      // The full GetService response includes a large API discovery config.
      // Only identity and enabled state are needed; do not widen the body limit.
      const info = await api(`https://serviceusage.googleapis.com/v1/projects/${PROJECT_NUMBER}/services/${service}?fields=name,state`);
      requireValue(info.name === `projects/${PROJECT_NUMBER}/services/${service}` && info.state === "ENABLED", stage);
    }
    // Check all existing resources before the first create. Refuse drift, do not repair it.
    const before = {};
    for (const kind of ["network", "subnet", "range", "instance"]) { stage = kind; before[kind] = await read(kind); }
    stage = "peering";
    before.peering = before.network ? await read("peering") : null;
    requireValue(before.network || (!before.subnet && !before.range && !before.instance), "network");
    onProgress({ stage: "verify", status: "preflight-passed" });
    const specs = [
      ["network", `${COMPUTE}/global/networks`, "compute", "global"],
      ["subnet", `${COMPUTE}/regions/${REGION}/subnetworks`, "compute", `regions/${REGION}`],
      ["range", `${COMPUTE}/global/addresses`, "compute", "global"],
      ["peering", `${SERVICE}/services/servicenetworking.googleapis.com/connections`, "peering", null],
      ["instance", `${SQL}/instances`, "sql", null],
    ];
    for (const [kind, url, family, scope] of specs) {
      stage = kind;
      if (kind === "instance") {
        remember("network", await api(URLS.network), true);
        for (const dependency of ["subnet", "range", "peering"]) requireValue(await read(dependency), dependency);
      }
      const latest = await read(kind);
      if (latest) { reused.push(kind); onProgress({ stage: kind, status: "reused" }); continue; }
      requireValue(!before[kind], kind); // Do not recreate a resource deleted since preflight.
      const result = await api(url, { method: "POST", body: clone(PAYLOADS[kind]), conflict: true });
      if (result !== CONFLICT) await waitOperation(result, family, scope, URLS[kind]);
      requireValue(await read(kind), kind);
      (result === CONFLICT ? reused : created).push(kind);
      onProgress({ stage: kind, status: result === CONFLICT ? "reused" : "created" });
    }
    stage = "verify";
    for (const kind of ["network", "subnet", "range", "peering", "instance"]) {
      const value = await read(kind); requireValue(value, kind);
      if (kind === "network") remember(kind, value, true);
    }
    return { status: "verified", created, reused, restore: "not-verified", runtime: "not-configured" };
  } catch (error) {
    // No rollback: a timed-out create can still finish. Re-run verifies exact
    // existing resources before proceeding. Never downgrade security to retry.
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError(signal.aborted ? "interrupted" : stage);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  process.stdout.on("error", () => { controller.abort(); process.exitCode = 1; });
  process.stderr.on("error", () => { process.exitCode = 1; });
  try {
    const args = process.argv.slice(2);
    requireValue(args.length === 0 || (args.length === 1 && ["--plan", "--apply"].includes(args[0])), "arguments");
    const result = await bootstrap({ apply: args[0] === "--apply",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45 * 60_000)]),
      onProgress: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${JSON.stringify(diagnostic(error))}\n`); process.exitCode = 1; }
}
