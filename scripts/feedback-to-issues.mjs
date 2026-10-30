// Manual GCP feedback export -> private GitHub Issues. Default is offline dry-run.
// No app password, session cookie, Supabase API, DB write, or dotenv file is used.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FEEDBACK_REPOSITORY = "godhuu0505/app-operations";
export const FEEDBACK_REPOSITORY_ID = 1437903210;
const FEEDBACK_PAGE = "https://mfmf-candidate-wspqvmhj6q-an.a.run.app/feedback";
const HEX = /^[a-f0-9]{64}$/;
const LIMIT = 128 * 1024;
const KINDS = { bug: "不具合", request: "要望", question: "質問・その他" };
const SEVERITIES = { blocker: "利用できない", annoying: "利用できるが困っている", minor: "軽微", idea: "アイデア" };
const FREQUENCIES = { always: "毎回", sometimes: "時々", once: "一度", unknown: "不明" };
const PAGES = { home: "一覧", "record-new": "記録作成", "record-detail": "記録詳細", calendar: "カレンダー",
  gallery: "ギャラリー", pets: "ペット", weight: "体重", settings: "設定", account: "アカウント設定",
  feedback: "フィードバック", onboarding: "初期設定", guest: "ゲスト", "guest-record-new": "ゲスト記録作成", share: "共有案内", invite: "招待", authentication: "認証", api: "API", other: "その他" };
const has = (object, key) => typeof key === "string" && Object.hasOwn(object, key);
const requireValue = (condition) => { if (!condition) throw new Error("Feedback operation stopped; details withheld."); };
const exact = (object, keys) => object && typeof object === "object" && !Array.isArray(object) &&
  Object.keys(object).sort().join(",") === [...keys].sort().join(",");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const plans = new WeakSet();
export const marker = (reference) => `<!-- mfmf-feedback:v1:${reference} -->`;

export function validateExport(value) {
  requireValue(exact(value, ["schema", "source", "hasMore", "records"]) && value.schema === 1 &&
    value.source === "mfmf-gcp-feedback" && typeof value.hasMore === "boolean" &&
    Array.isArray(value.records) && value.records.length <= 100);
  const seen = new Set();
  const records = value.records.map((row) => {
    requireValue(exact(row, ["reference", "kind", "severity", "frequency", "page", "date"]) &&
      typeof row.reference === "string" && HEX.test(row.reference) && !seen.has(row.reference) &&
      has(KINDS, row.kind) && (row.severity === null || has(SEVERITIES, row.severity)) &&
      (row.frequency === null || has(FREQUENCIES, row.frequency)) && has(PAGES, row.page) &&
      typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
      Number.isFinite(Date.parse(`${row.date}T00:00:00Z`)) && new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) === row.date);
    seen.add(row.reference);
    return { reference: row.reference, kind: row.kind, severity: row.severity, frequency: row.frequency, page: row.page, date: row.date };
  });
  return { schema: 1, source: "mfmf-gcp-feedback", hasMore: value.hasMore, records };
}

export function createPlan(input, repository = FEEDBACK_REPOSITORY) {
  requireValue(repository === FEEDBACK_REPOSITORY);
  const data = validateExport(input);
  const issues = data.records.map((row) => ({ reference: row.reference,
    title: `[mfmf ${KINDS[row.kind]}] ${PAGES[row.page]} (${row.reference.slice(0, 8)})`,
    body: ["アプリ内の本人投稿から、次の分類だけを手動転記しました。", "",
      `- 種類: ${KINDS[row.kind]}`, `- 画面: ${PAGES[row.page]}`, `- 送信日（日本時間）: ${row.date}`,
      `- 困り度: ${row.severity === null ? "未指定" : SEVERITIES[row.severity]}`,
      `- 頻度: ${row.frequency === null ? "未指定" : FREQUENCIES[row.frequency]}`, "",
      "自由記述・記入者・URL・アカウント/世帯情報・端末情報は転記していません。",
      "詳細は投稿者がアプリ内で確認し、必要な情報だけを見直して追記してください。",
      `[本人のフィードバック一覧](${FEEDBACK_PAGE})（ログインが必要です）`, "", marker(row.reference)].join("\n"),
  }));
  const plan = { schema: 1, repo: repository, hasMore: data.hasMore, issues: Object.freeze(issues.map(Object.freeze)) };
  const result = Object.freeze({ ...plan, sha256: hash(JSON.stringify(plan)) });
  plans.add(result);
  return result;
}

async function boundedJson(response, max = 2 * 1024 * 1024) {
  const reader = response.body?.getReader();
  requireValue(reader);
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      requireValue(bytes <= max);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    try { await reader.cancel(); } catch { /* No provider body/exception output. */ }
    throw new Error("Feedback operation stopped; details withheld.");
  }
}

function github(token, fetchImpl) {
  requireValue(typeof token === "string" && token.length >= 10 && token.length <= 1024 && !/[\s\u0000-\u001f\u007f]/.test(token));
  return async (path, body) => {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", credentials: "omit", cache: "no-store",
        signal: AbortSignal.timeout(15_000),
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error("Feedback operation stopped; details withheld."); }
    if (response.status !== (body === undefined ? 200 : 201)) {
      try { await response.body?.cancel(); } catch { /* Withhold response details. */ }
      throw new Error("Feedback operation stopped; details withheld.");
    }
    return boundedJson(response);
  };
}

export function validatePrivateRepository(value, expectedId) {
  requireValue(value && value.private === true && value.visibility === "private" && value.archived === false &&
    value.disabled === false && value.has_issues === true && typeof value.full_name === "string" &&
    value.full_name.toLowerCase() === FEEDBACK_REPOSITORY && value.id === FEEDBACK_REPOSITORY_ID &&
    (!expectedId || value.id === expectedId));
  return value.id;
}

async function existingIssues(api, references) {
  const found = new Map();
  for (let page = 1; page <= 100; page++) {
    const rows = await api(`/repos/${FEEDBACK_REPOSITORY}/issues?state=all&per_page=100&sort=created&direction=asc&page=${page}`);
    requireValue(Array.isArray(rows) && rows.length <= 100);
    for (const row of rows) {
      requireValue(row && Number.isSafeInteger(row.number) && row.number > 0 &&
        (row.body === null || typeof row.body === "string") && (row.body?.length ?? 0) <= 65536);
      if (row.pull_request) continue;
      for (const reference of references) {
        if ((row.body ?? "").split(/\r?\n/).includes(marker(reference))) {
          requireValue(!found.has(reference));
          found.set(reference, row.number);
        }
      }
    }
    if (rows.length < 100) return found;
  }
  throw new Error("Feedback operation stopped; details withheld.");
}

/** Repository/list GETs only. This is also repeated before each explicit POST. */
export async function checkPlan(plan, { token, fetchImpl = fetch }) {
  requireValue(plans.has(plan));
  const api = github(token, fetchImpl);
  const repoId = validatePrivateRepository(await api(`/repos/${FEEDBACK_REPOSITORY}`));
  const found = await existingIssues(api, plan.issues.map((issue) => issue.reference));
  return { repoId, existing: found };
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function privateState(directory) {
  const path = resolve(directory);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 &&
    (process.getuid === undefined || stat.uid === process.getuid()));
  return {
    async write(name, value) {
      requireValue(/^[a-z0-9.-]+\.json$/.test(name));
      const file = await open(`${path}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); } finally { await file.close(); }
      await syncDirectory(path);
    },
  };
}

/** No automatic retry. An ambiguous POST leaves its durable intent in place. */
export async function executePlan(plan, { approvedSha, token, state, fetchImpl = fetch, now = () => new Date().toISOString() }) {
  requireValue(plans.has(plan) && typeof approvedSha === "string" && HEX.test(approvedSha) && plan.sha256 === approvedSha && !plan.hasMore);
  const api = github(token, fetchImpl);
  let repoId; let created = 0; let skipped = 0;
  for (const issue of plan.issues) {
    repoId = validatePrivateRepository(await api(`/repos/${FEEDBACK_REPOSITORY}`), repoId);
    const found = await existingIssues(api, [issue.reference]);
    if (found.has(issue.reference)) { skipped++; continue; }
    const name = `issue-${repoId}-${issue.reference}`;
    // The immutable intent stops retries across process crashes, network errors,
    // response validation failures, and a successful POST with a lost response.
    await state.write(`${name}.intent.json`, { schema: 1, repoId, reference: issue.reference, planSha: plan.sha256, state: "attempted", at: now() });
    const result = await api(`/repos/${FEEDBACK_REPOSITORY}/issues`, { title: issue.title, body: issue.body });
    requireValue(result && Number.isSafeInteger(result.number) && result.number > 0 &&
      result.html_url === `https://github.com/${FEEDBACK_REPOSITORY}/issues/${result.number}` &&
      typeof result.body === "string" && result.body.split(/\r?\n/).includes(marker(issue.reference)) && !result.pull_request);
    await state.write(`${name}.completed.json`, { schema: 1, repoId, reference: issue.reference, issueNumber: result.number, state: "created", at: now() });
    created++;
  }
  return { created, skipped };
}

export function argumentsFor(argv) {
  const options = { mode: "dry-run" };
  const seen = new Set();
  for (const arg of argv) {
    const match = /^(--[a-z-]+)(?:=(.*))?$/.exec(arg);
    requireValue(match && !seen.has(match[1])); seen.add(match[1]);
    const [, key, value] = match;
    if (["--dry-run", "--check", "--execute"].includes(key)) {
      requireValue(value === undefined && !seen.has("mode")); seen.add("mode"); options.mode = key.slice(2);
    } else {
      requireValue(["--input", "--repo", "--approve-plan", "--state-dir"].includes(key) && value?.length);
      options[key.slice(2)] = value;
    }
  }
  requireValue(options.input && (!options.repo || options.repo === FEEDBACK_REPOSITORY) &&
    (options.mode === "execute" ? HEX.test(options["approve-plan"] ?? "") : !options["approve-plan"]));
  return options;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = argumentsFor(argv);
  const file = await open(resolve(options.input), constants.O_RDONLY | constants.O_NOFOLLOW);
  let input;
  try {
    const stat = await file.stat(); requireValue(stat.isFile() && stat.size > 0 && stat.size <= LIMIT);
    const bytes = Buffer.alloc(LIMIT + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    requireValue(bytesRead <= LIMIT); input = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
  const plan = createPlan(input, options.repo);
  if (options.mode === "dry-run") return { mode: "dry-run", ...plan };
  if (options.mode === "check") {
    const result = await checkPlan(plan, { token: env.GITHUB_TOKEN });
    return { mode: "check", privateVerified: true, planSha: plan.sha256, total: plan.issues.length, existing: result.existing.size, hasMore: plan.hasMore };
  }
  const state = await privateState(options["state-dir"] ?? `${homedir()}/.local/state/mfmf-feedback`);
  return { mode: "execute", ...await executePlan(plan, { approvedSha: options["approve-plan"], token: env.GITHUB_TOKEN, state }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((result) => console.log(JSON.stringify(result, null, 2))).catch(() => {
    console.error("Feedback operation stopped; details withheld. Review the private journal before any retry.");
    process.exitCode = 1;
  });
}
