import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REGISTRY = "asia-northeast1-docker.pkg.dev";
const PUBLIC_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
export const SECRET_NAMES = {
  TOKEN_ENC_KEY: "mfmf-token-enc-key",
  GOOGLE_CLIENT_ID: "mfmf-google-client-id",
  GOOGLE_CLIENT_SECRET: "mfmf-google-client-secret",
  SENTRY_DSN: "mfmf-sentry-dsn",
};
const OPTIONAL_CONFIG = ["SIGNUP_ENABLED", "SENTRY_ENVIRONMENT", "SENTRY_TRACES_SAMPLE_RATE"];
const ALLOWED = new Set([...PUBLIC_KEYS, ...Object.keys(SECRET_NAMES), ...OPTIONAL_CONFIG]);
const PRESEEDED_KEYS = ["TOKEN_ENC_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
class CandidateError extends Error {}

function validSecretVersion(value, key, env) {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  return parts.length === 6 && parts[0] === "projects" &&
    [env.GCP_PROJECT_ID, env.GCP_PROJECT_NUMBER].filter(Boolean).includes(parts[1]) &&
    parts[2] === "secrets" && parts[3] === SECRET_NAMES[key] &&
    parts[4] === "versions" && /^[1-9][0-9]*$/.test(parts[5]);
}

export function parsePreseededSecretVersions(env) {
  const input = env.PRESEEDED_SECRET_VERSIONS ?? "";
  if (typeof input !== "string" || input.length > 4096) throw new CandidateError("Preseeded secret references are invalid.");
  if (!input.trim()) return {};
  let refs;
  try { refs = JSON.parse(input); } catch { throw new CandidateError("Preseeded secret references must be JSON; input withheld."); }
  if (!refs || typeof refs !== "object" || Array.isArray(refs) ||
      Object.entries(refs).some(([key, value]) => !PRESEEDED_KEYS.includes(key) || !validSecretVersion(value, key, env))) {
    throw new CandidateError("Preseeded secret references must use fixed names, this project, and positive numeric versions.");
  }
  return refs;
}

function productionEntries(response, preseeded = {}) {
  if (!Array.isArray(response?.envs) || response.pagination?.next != null || response.hiddenProductionEnvCount > 0) {
    throw new CandidateError("Vercel did not return a complete visible environment list.");
  }
  const entries = new Map();
  for (const item of response.envs) {
    if (!item || !ALLOWED.has(item.key)) continue;
    if (typeof item.target !== "string" && !Array.isArray(item.target)) {
      throw new CandidateError(`Environment scope is ambiguous: ${item.key}.`);
    }
    const targets = Array.isArray(item.target) ? item.target : [item.target];
    if (targets.some((target) => !["production", "preview", "development"].includes(target))) {
      throw new CandidateError(`Environment scope is ambiguous: ${item.key}.`);
    }
    if (!targets.includes("production") || item.gitBranch) continue;
    if (entries.has(item.key)) throw new CandidateError(`Duplicate production setting: ${item.key}.`);
    const knownType = ["plain", "encrypted", "secret", "sensitive"].includes(item.type);
    const knownVisibility = item.visibility === undefined || ["config", "secret"].includes(item.visibility);
    const readable = ["plain", "encrypted"].includes(item.type) && item.visibility !== "secret";
    if (!knownType || !knownVisibility || (!readable && !Object.hasOwn(preseeded, item.key))) {
      throw new CandidateError(`Production setting is not readable plaintext: ${item.key}.`);
    }
    entries.set(item.key, item);
  }
  return [...entries.values()];
}

export function selectProductionConfig(response, preseeded = {}) {
  const entries = productionEntries(response, preseeded);
  const present = new Set(entries.map((item) => item.key));
  for (const key of Object.keys(preseeded)) {
    if (!present.has(key)) throw new CandidateError("A preseeded reference has no matching production setting.");
  }
  const googleDriveConfigured = present.has("GOOGLE_CLIENT_ID");
  if (googleDriveConfigured !== present.has("GOOGLE_CLIENT_SECRET")) {
    throw new CandidateError("Google Drive client ID and secret must be configured together.");
  }
  const values = new Map();
  for (const item of entries) {
    if (Object.hasOwn(preseeded, item.key)) continue;
    if ((item.type === "encrypted" && item.decrypted !== true) || typeof item.value !== "string") {
      throw new CandidateError(`Production setting is not readable plaintext: ${item.key}.`);
    }
    values.set(item.key, item.value);
  }
  for (const key of [...PUBLIC_KEYS, "TOKEN_ENC_KEY", ...(googleDriveConfigured ? ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] : [])]) {
    if (Object.hasOwn(preseeded, key)) continue;
    const value = values.get(key);
    if (!value?.trim() || Buffer.byteLength(value) > 65_536 || value.includes("\0")) {
      throw new CandidateError(`Required production setting is missing or invalid: ${key}.`);
    }
  }
  const publicEnv = Object.fromEntries(PUBLIC_KEYS.map((key) => [key, values.get(key)]));
  let url;
  try { url = new URL(publicEnv.NEXT_PUBLIC_SUPABASE_URL); } catch { /* fail below */ }
  if (!url || url.protocol !== "https:" || !/^[a-z]{20}\.supabase\.co$/.test(url.hostname) ||
      url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new CandidateError("Supabase public URL must identify a hosted project over HTTPS.");
  }
  const key = publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    let claims;
    try { claims = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")); } catch { /* fail below */ }
    if (key.split(".").length !== 3 || claims?.role !== "anon" ||
        (claims.ref && claims.ref !== url.hostname.split(".")[0])) {
      throw new CandidateError("Supabase browser key must be anon or publishable; privileged keys are rejected.");
    }
  }
  if (googleDriveConfigured && !Object.hasOwn(preseeded, "GOOGLE_CLIENT_ID") &&
      !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(values.get("GOOGLE_CLIENT_ID"))) {
    throw new CandidateError("Google OAuth client identifier is invalid.");
  }
  const signup = values.get("SIGNUP_ENABLED") ?? "false";
  const environment = values.get("SENTRY_ENVIRONMENT") || "cloud-run-candidate";
  const sampleRate = values.get("SENTRY_TRACES_SAMPLE_RATE") || "0.1";
  if (!["true", "false"].includes(signup) || !/^[A-Za-z0-9._-]{1,64}$/.test(environment) ||
      !/^(0(\.\d+)?|1(\.0+)?)$/.test(sampleRate)) {
    throw new CandidateError("Optional runtime configuration is invalid.");
  }
  Object.assign(publicEnv, { SIGNUP_ENABLED: signup, SENTRY_ENVIRONMENT: environment, SENTRY_TRACES_SAMPLE_RATE: sampleRate });
  const secrets = Object.fromEntries(Object.keys(SECRET_NAMES).filter((name) => values.get(name)).map((name) => [name, values.get(name)]));
  for (const value of Object.values(secrets)) {
    if (!value.trim() || Buffer.byteLength(value) > 65_536 || value.includes("\0")) {
      throw new CandidateError("A server setting is invalid.");
    }
  }
  // 鍵は trim / 再生成しない。既存 refresh token を復号するため元の値をそのまま渡す。
  return { publicEnv, secrets, features: { googleDriveConfigured, sentryConfigured: Boolean(secrets.SENTRY_DSN) } };
}

async function requestJson(fetchImpl, url, token, body) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CandidateError("Cloud API request failed (network or timeout); no automatic retry was made.");
  }
  if (!response.ok) throw new CandidateError(`Cloud API request failed (HTTP ${response.status}); response body withheld.`);
  try { return await response.json(); } catch { throw new CandidateError("Cloud API returned invalid JSON."); }
}

function safeEnvironmentMetadata(item, key) {
  let publicKeyClass = "not_applicable";
  if (key === "NEXT_PUBLIC_SUPABASE_ANON_KEY") {
    publicKeyClass = "unrecognized";
    if (typeof item?.value === "string" && item.value.length <= 65_536) {
      if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(item.value)) publicKeyClass = "publishable";
      else if (item.value.startsWith("sb_secret_")) publicKeyClass = "privileged";
      else {
        try {
          const role = JSON.parse(Buffer.from(item.value.split(".")[1], "base64url").toString("utf8"))?.role;
          if (role === "anon") publicKeyClass = "anon_jwt";
          if (role === "service_role") publicKeyClass = "privileged";
        } catch { /* classify only; never print the input */ }
      }
    }
  }
  return JSON.stringify({
    key,
    type: ["plain", "encrypted", "secret", "sensitive", "system"].includes(item?.type) ? item.type : "unknown",
    decryptedPresent: Object.hasOwn(item ?? {}, "decrypted"),
    decryptedType: typeof item?.decrypted,
    decrypted: typeof item?.decrypted === "boolean" ? item.decrypted : null,
    valueType: typeof item?.value,
    publicKeyClass,
  });
}

async function readProductionConfig(env, fetchImpl, preseeded) {
  const project = encodeURIComponent(env.VERCEL_PROJECT_ID);
  const listUrl = new URL(`https://api.vercel.com/v10/projects/${project}/env`);
  listUrl.searchParams.set("teamId", env.VERCEL_ORG_ID);
  // v10 list の decrypted は optional。deprecated な decrypt query と list.value に依存しない。
  const entries = productionEntries(await requestJson(fetchImpl, listUrl.href, env.VERCEL_TOKEN), preseeded);
  const present = new Set(entries.map((item) => item.key));
  for (const key of [...PUBLIC_KEYS, "TOKEN_ENC_KEY"]) {
    if (!present.has(key)) throw new CandidateError(`Required production setting is missing or invalid: ${key}.`);
  }
  if (present.has("GOOGLE_CLIENT_ID") !== present.has("GOOGLE_CLIENT_SECRET")) {
    throw new CandidateError("Google Drive client ID and secret must be configured together.");
  }
  if (Object.keys(preseeded).some((key) => !present.has(key))) {
    throw new CandidateError("A preseeded reference has no matching production setting.");
  }
  const decrypted = [];
  for (const entry of entries) {
    if (Object.hasOwn(preseeded, entry.key)) {
      // 値は取得・代入しない。metadata と利用者が確認した固定 version 参照だけを保持する。
      decrypted.push(entry);
      continue;
    }
    if (typeof entry.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(entry.id)) {
      throw new CandidateError(`Environment ID is missing or invalid: ${entry.key}.`);
    }
    const detailUrl = new URL(`https://api.vercel.com/v1/projects/${project}/env/${encodeURIComponent(entry.id)}`);
    detailUrl.searchParams.set("teamId", env.VERCEL_ORG_ID);
    // 公式の「decrypted value」endpoint からだけ値を受け取る。value を持たない variant は拒否。
    // https://vercel.com/docs/rest-api/projects/retrieve-the-decrypted-value-of-an-environment-variable-of-a-project-by-id
    const detail = await requestJson(fetchImpl, detailUrl.href, env.VERCEL_TOKEN);
    const targets = Array.isArray(detail?.target) ? detail.target : [detail?.target];
    if (detail?.key !== entry.key || detail?.type !== entry.type ||
        (detail.visibility !== undefined && detail.visibility !== "config") ||
        (detail.id !== undefined && detail.id !== entry.id) || detail.gitBranch ||
        (detail.target !== undefined && !targets.includes("production")) ||
        (detail.decrypted !== undefined && typeof detail.decrypted !== "boolean") ||
        (detail.type === "encrypted" && detail.decrypted === false) || typeof detail.value !== "string") {
      throw new CandidateError(`Decrypted environment response rejected: ${safeEnvironmentMetadata(detail, entry.key)}`);
    }
    // 専用 endpoint の公式 schema は decrypted が省略される value:string variant も持つ。
    // list の ciphertext をここへフォールバックさせず、取得した平文だけを既存の値検証へ渡す。
    decrypted.push({ ...entry, value: detail.value, decrypted: true });
  }
  return selectProductionConfig({ envs: decrypted }, preseeded);
}

export async function prepareCandidate({ env, fetchImpl = fetch, docker, save, log = console.log }) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    throw new CandidateError("Candidate preparation requires a manual main workflow run.");
  }
  for (const key of ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "GCP_ACCESS_TOKEN"]) {
    if (!env[key] || /[\r\n]/.test(env[key])) throw new CandidateError("Required deployment credentials are missing or invalid.");
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(env.GCP_PROJECT_ID ?? "") ||
      !/^[1-9][0-9]{5,19}$/.test(env.GCP_PROJECT_NUMBER ?? "") ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
      !/^\d+$/.test(env.GITHUB_RUN_ID ?? "") || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? "")) {
    throw new CandidateError("Deployment project or workflow identity is invalid.");
  }
  const preseeded = parsePreseededSecretVersions(env);
  const { publicEnv, secrets, features } = await readProductionConfig(env, fetchImpl, preseeded);
  const imageBase = `${REGISTRY}/${env.GCP_PROJECT_ID}/mfmf/mfmf-candidate`;
  const image = `${imageBase}:${env.GITHUB_SHA}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  log("Production settings validated. Building candidate with public Supabase settings and signup flag only.");
  await docker(["build", "--platform", "linux/amd64", "-f", "Dockerfile.cloudrun",
    ...[...PUBLIC_KEYS, "SIGNUP_ENABLED"].flatMap((key) => ["--build-arg", `${key}=${publicEnv[key]}`]), "-t", image, "."], false);

  const secretVersions = { ...preseeded };
  for (const [key, value] of Object.entries(secrets)) {
    const parent = `projects/${env.GCP_PROJECT_ID}/secrets/${SECRET_NAMES[key]}`;
    // addVersion だけ。対象は bootstrap 済み固定名であり、secret 作成・読取・上書き権限は不要。
    const version = await requestJson(fetchImpl, `https://secretmanager.googleapis.com/v1/${parent}:addVersion`, env.GCP_ACCESS_TOKEN, {
      payload: { data: Buffer.from(value, "utf8").toString("base64") },
    });
    // API は request の project ID を canonical project number に正規化することがある。
    if (!validSecretVersion(version?.name, key, env)) {
      throw new CandidateError("Secret Manager returned an unexpected version reference.");
    }
    secretVersions[key] = version.name;
  }
  log("Server settings have fixed secret version references. Pushing candidate image.");
  await docker(["push", image], true);
  const result = await docker(["image", "inspect", image, "--format", "{{json .RepoDigests}}"], false);
  let digests;
  try { digests = JSON.parse(result); } catch { throw new CandidateError("Image digest could not be verified."); }
  const digest = Array.isArray(digests) && digests.find((item) => typeof item === "string" &&
    item.startsWith(`${imageBase}@sha256:`) && /^[a-f0-9]{64}$/.test(item.slice(`${imageBase}@sha256:`.length)));
  if (!digest) throw new CandidateError("Artifact Registry image digest is missing.");
  await save({ image: digest, region: "asia-northeast1", service: "mfmf-candidate", env: publicEnv, features, secretVersions });
  log("Candidate image and public configuration prepared. No Cloud Run service or traffic was changed.");
}

async function main() {
  if (!process.env.CANDIDATE_PUBLIC_CONFIG) throw new CandidateError("Public configuration output path is missing.");
  // workflow env へ input を直接展開すると runner が開始ログへ表示する。
  // GitHub が作成した event metadata からだけ読み、検証済み参照をメモリ内で渡す。
  let input;
  try {
    const path = process.env.GITHUB_EVENT_PATH;
    if (!path) throw new Error();
    const file = await stat(path);
    if (!file.isFile() || file.size > 65_536) throw new Error();
    const eventText = await readFile(path, "utf8");
    if (Buffer.byteLength(eventText) > 65_536) throw new Error();
    const event = JSON.parse(eventText);
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error();
    input = event.inputs?.preseeded_secret_versions ?? "";
  } catch {
    throw new CandidateError("Workflow event is missing, invalid, or too large; input withheld.");
  }
  const workflowEnv = { ...process.env, PRESEEDED_SECRET_VERSIONS: input };
  parsePreseededSecretVersions(workflowEnv);
  const scratch = await mkdtemp(join(tmpdir(), "mfmf-candidate-"));
  try {
    const bin = join(scratch, "bin");
    await mkdir(bin);
    const helper = join(bin, "docker-credential-mfmf-wif");
    await copyFile(fileURLToPath(new URL("./docker-credential-mfmf-wif.mjs", import.meta.url)), helper);
    await chmod(helper, 0o700);
    // 公開設定のみ。docker login は token をファイル保存するため使わない。
    await writeFile(join(scratch, "config.json"), JSON.stringify({ credHelpers: { [REGISTRY]: "mfmf-wif" } }), { mode: 0o600 });
    const dockerEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, DOCKER_CONFIG: scratch };
    await prepareCandidate({
      env: workflowEnv,
      docker: async (args, authenticate) => {
        try {
          const result = await execFileAsync("docker", args, {
            env: { ...dockerEnv, ...(authenticate ? { GCP_ACCESS_TOKEN: process.env.GCP_ACCESS_TOKEN } : {}) },
            timeout: 20 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
          });
          return result.stdout;
        } catch {
          // Docker/helper の出力や execFile の例外に認証情報が含まれてもログに転送しない。
          throw new CandidateError("Docker operation failed; output withheld. No Cloud Run deployment was attempted.");
        }
      },
      save: (manifest) => writeFile(process.env.CANDIDATE_PUBLIC_CONFIG, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }),
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof CandidateError ? error.message : "Candidate preparation failed; details withheld.");
    process.exitCode = 1;
  });
}
