import { pathToFileURL } from "node:url";

// Management API の pause/resume。SQL・バックアップ復元・設定変更は実行しない。
// https://supabase.com/docs/reference/api/v1-restore-a-project
// https://supabase.com/docs/reference/api/v1-get-services-health
const SERVICES = ["db", "auth", "rest", "storage"];
const PROJECT_STATUSES = new Set([
  "INACTIVE", "ACTIVE_HEALTHY", "ACTIVE_UNHEALTHY", "COMING_UP", "UNKNOWN",
  "GOING_DOWN", "INIT_FAILED", "REMOVED", "RESTORING", "UPGRADING", "PAUSING",
  "RESTORE_FAILED", "RESTARTING", "PAUSE_FAILED", "RESIZING",
]);
const SERVICE_STATUSES = new Set(["COMING_UP", "ACTIVE_HEALTHY", "UNHEALTHY"]);

class ResumeError extends Error {}

export async function resumeProject({
  token,
  projectRef,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  log = console.log,
  timeoutMs = 20 * 60 * 1000,
  pollMs = 15 * 1000,
  verifyOnly = false,
}) {
  if (!token || /[\r\n]/.test(token) || !/^[a-z]{20}$/.test(projectRef ?? "")) {
    throw new ResumeError("Required Supabase secrets are missing or invalid.");
  }
  if (typeof verifyOnly !== "boolean") throw new ResumeError("Verification mode must be a boolean.");
  const baseUrl = `https://api.supabase.com/v1/projects/${projectRef}`;
  const deadline = now() + timeoutMs;

  async function request(path, method = "GET") {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // fetch の error / API の応答本文は secret や接続情報を含み得るため出力しない。
      throw new ResumeError("Supabase API request failed (network or timeout). Check project status before retrying.");
    }
    if (!response.ok) {
      throw new ResumeError(`Supabase API ${method} failed (HTTP ${response.status}). Check Dashboard access and restore eligibility; no automatic retry was made.`);
    }
    if (method === "POST") return;
    try {
      return await response.json();
    } catch {
      throw new ResumeError("Supabase API returned invalid JSON.");
    }
  }

  async function getStatus() {
    const project = await request("");
    if (project?.ref !== projectRef || !PROJECT_STATUSES.has(project?.status)) {
      throw new ResumeError("Supabase API returned an unexpected project or status.");
    }
    return project.status;
  }

  async function servicesHealthy() {
    // 2026-10-27 の実 GET 診断で timeout_ms=5000 だけが invalid_type / HTTP 400。
    // 任意パラメータを省略した同じ配列形式は 200。通信上限は request の AbortSignal で保持。
    const query = new URLSearchParams(SERVICES.map((service) => ["services", service]));
    const services = await request(`/health?${query}`);
    if (!Array.isArray(services) || services.some((service) =>
      !service || typeof service.name !== "string" || !SERVICE_STATUSES.has(service.status))) {
      throw new ResumeError("Supabase API returned an unexpected service health response.");
    }
    // 空配列・一部サービス欠落を成功扱いしない。deprecated な healthy は使わない。
    return SERVICES.every((name) => {
      const matches = services.filter((service) => service.name === name);
      return matches.length === 1 && matches[0].status === "ACTIVE_HEALTHY";
    });
  }

  let status = await getStatus();
  log(`Initial project status: ${status}`);
  if (verifyOnly) log("Verification-only mode: no restore request will be sent.");
  if (status === "INACTIVE") {
    if (verifyOnly) throw new ResumeError("Project is INACTIVE; verification-only mode did not request resume.");
    // Supabase の paused 状態は INACTIVE。POST は一度だけで、通信失敗時にも再送しない。
    await request("/restore", "POST");
    log("Resume request accepted. Waiting for project and service health.");
  } else if (!["ACTIVE_HEALTHY", "RESTORING", "COMING_UP"].includes(status)) {
    throw new ResumeError(`Project is ${status}; resume was not requested. Inspect the Dashboard.`);
  }

  let previousStatus = status;
  while (now() < deadline) {
    status = await getStatus();
    if (status !== previousStatus) log(`Project status: ${status}`);
    previousStatus = status;
    if (status === "ACTIVE_HEALTHY" && await servicesHealthy()) {
      log("Project and db/auth/rest/storage are ACTIVE_HEALTHY. No migration or deployment was performed.");
      return;
    }
    if (!["INACTIVE", "RESTORING", "COMING_UP", "ACTIVE_HEALTHY", "ACTIVE_UNHEALTHY"].includes(status)) {
      throw new ResumeError(`Project entered ${status}; stopped without further changes.`);
    }
    await sleep(pollMs);
  }
  throw new ResumeError("Timed out waiting for project and service health. Inspect the Dashboard before retrying; no further changes were made.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const verifyOnly = process.env.SUPABASE_VERIFY_ONLY ?? "false";
  if (!["true", "false"].includes(verifyOnly)) {
    console.error("Verification mode must be true or false.");
    process.exitCode = 1;
  } else {
    resumeProject({
      token: process.env.SUPABASE_ACCESS_TOKEN,
      projectRef: process.env.SUPABASE_PROJECT_ID,
      verifyOnly: verifyOnly === "true",
    }).catch((error) => {
      console.error(error instanceof ResumeError ? error.message : "Unexpected error; resume verification stopped.");
      process.exitCode = 1;
    });
  }
}
