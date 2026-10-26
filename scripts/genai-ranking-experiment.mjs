// Synthetic-only, opt-in experiment. No application/DB client or user input is accepted.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const MODEL = "semantic-ranker-default-005";
const RECORDS = [
  {
    id: "synthetic-rest",
    title: "架空記録：保育園から帰った日の休息",
    content: "保育園でたくさん遊んだ。帰宅すると静かな場所で丸くなり、夕方の散歩は短めにして早く眠った。食事はいつもどおり。",
  },
  {
    id: "synthetic-rain",
    title: "架空記録：雨の日の室内遊び",
    content: "雨で外へ出られず、家でおもちゃを追いかけて遊んだ。昼寝のあとも元気に走り回っていた。保育園はお休み。",
  },
  {
    id: "synthetic-grooming",
    title: "架空記録：サロンに行った日",
    content: "サロンでシャンプーと爪切りをした。帰宅後は庭を歩き、夕食を食べた。保育園には行っていない。",
  },
];
const QUERY = "保育園のあと、くたびれてのんびり過ごしたのはどの記録？";
const HELP = "Usage: node scripts/genai-ranking-experiment.mjs [--execute --project=PROJECT_ID] [--gcloud=/path/to/gcloud]\nWithout --execute: no authentication or network call. With --execute: one synthetic-only ranking request, no retry.\n";
class SafeError extends Error {}

function parseArgs(args) {
  const options = { execute: false, project: undefined, gcloud: "gcloud", help: false };
  const seen = new Set();
  for (const arg of args) {
    const key = arg.split("=", 1)[0];
    if (seen.has(key)) throw new SafeError("Duplicate argument rejected.");
    seen.add(key);
    if (arg === "--help") options.help = true;
    else if (arg === "--execute") options.execute = true;
    else if (arg.startsWith("--project=")) options.project = arg.slice(10);
    else if (arg.startsWith("--gcloud=")) options.gcloud = arg.slice(9);
    else throw new SafeError("Unknown argument. Only the built-in synthetic fixture is supported.");
  }
  if (options.project !== undefined && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project)) {
    throw new SafeError("Invalid project ID.");
  }
  if (!options.gcloud || /[\r\n\0]/.test(options.gcloud)) throw new SafeError("Invalid gcloud executable.");
  if (options.execute && !options.project) throw new SafeError("--execute requires --project=PROJECT_ID.");
  return options;
}

function safeRecords(body) {
  const allowed = new Set(RECORDS.map(({ id }) => id));
  const seen = new Set();
  if (!Array.isArray(body?.records) || body.records.length !== RECORDS.length) {
    throw new SafeError("Unexpected ranking response shape; response withheld.");
  }
  return body.records.map((record) => {
    if (!record || !allowed.has(record.id) || seen.has(record.id)
      || !Number.isFinite(record.score) || record.score < 0 || record.score > 1) {
      throw new SafeError("Unexpected ranking record; response withheld.");
    }
    seen.add(record.id);
    // Explicit projection: never print raw response fields, request bodies, or auth data.
    return { id: record.id, score: record.score };
  });
}

export async function run(args, {
  exec = execFileAsync,
  request = fetch,
  out = (line) => process.stdout.write(line),
  err = (line) => process.stderr.write(line),
} = {}) {
  try {
    const options = parseArgs(args);
    if (options.help) { out(HELP); return 0; }
    if (!options.execute) {
      out(`${JSON.stringify({ dryRun: true, model: MODEL, recordIds: RECORDS.map(({ id }) => id), requestCount: 0 })}\n`);
      return 0;
    }
    let token;
    try {
      // Capture only in memory; never use shell expansion, argv, files, or inherited stdio for the token.
      const result = await exec(options.gcloud, ["auth", "print-access-token", "--quiet"], {
        encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024,
      });
      token = result.stdout.trim();
      if (!token || /\s/.test(token)) throw new Error();
    } catch {
      throw new SafeError("Could not obtain gcloud credentials; authentication output withheld.");
    }
    let response;
    try {
      response = await request(`https://discoveryengine.googleapis.com/v1/projects/${options.project}/locations/global/rankingConfigs/default_ranking_config:rank`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Goog-User-Project": options.project,
        },
        body: JSON.stringify({ model: MODEL, query: QUERY, records: RECORDS, topN: 3, ignoreRecordDetailsInResponse: true }),
      });
    } catch {
      throw new SafeError("Ranking request failed or timed out; no retry was sent. Details withheld.");
    } finally {
      token = undefined;
    }
    if (!response.ok) throw new SafeError(`Ranking API returned HTTP ${response.status}; response body withheld. No retry was sent.`);
    const records = safeRecords(await response.json());
    out(`${JSON.stringify({ records })}\n`);
    return 0;
  } catch (error) {
    err(`${error instanceof SafeError ? error.message : "Ranking experiment failed; diagnostic details withheld."}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
