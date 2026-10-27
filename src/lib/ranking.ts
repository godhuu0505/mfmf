import "server-only";
import { prepareRanking, type RankingCandidate } from "@/lib/rankingPrivacy";

export const RANKING_PROJECT = "mfmf-499612";
export const RANKING_MODEL = "semantic-ranker-default-005";
export const RANKING_HARD_STOP = Date.parse("2027-06-24T00:00:00+09:00");
const TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const RANK_URL = `https://discoveryengine.googleapis.com/v1/projects/${RANKING_PROJECT}/locations/global/rankingConfigs/default_ranking_config:rank`;
const MAX_RESPONSE_BYTES = 32_768;

export class RankingUnavailable extends Error {
  constructor() { super("Ranking is unavailable; details withheld."); this.name = "RankingUnavailable"; }
}
const unavailable = (): never => { throw new RankingUnavailable(); };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function rankingEnabled(env: Readonly<Record<string, string | undefined>> = process.env, now = Date.now()): boolean {
  const raw = env.MFMF_RANKING_EXPIRES_AT;
  if (env.MFMF_RANKING_ENABLED !== "true" || !raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return false;
  const expires = Date.parse(raw);
  return Number.isFinite(expires) && now < expires && expires <= RANKING_HARD_STOP;
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return unavailable();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return unavailable(); }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return unavailable(); }
  finally { reader.releaseLock(); }
}

export function createRanking(dependencies: {
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string>;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
} = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? Date.now;
  return async function rank(query: string, candidates: readonly RankingCandidate[], knownNames: readonly string[] = []): Promise<string[]> {
    if (!rankingEnabled(dependencies.env ?? process.env, now())) return unavailable();
    const prepared = prepareRanking(query, candidates, knownNames);
    // One deadline covers metadata authentication and the sole ranking request. No retries.
    const signal = AbortSignal.timeout(8_000);
    try {
      let token: string;
      if (dependencies.getAccessToken) token = await dependencies.getAccessToken();
      else {
        const metadata = await fetchImpl(TOKEN_URL, { headers: { "Metadata-Flavor": "Google" }, redirect: "error", signal, cache: "no-store" });
        if (!metadata.ok || metadata.headers.get("metadata-flavor") !== "Google") return unavailable();
        const value = await readJson(metadata, 16_384);
        if (!object(value) || typeof value.access_token !== "string" || value.token_type !== "Bearer" ||
            typeof value.expires_in !== "number" || value.expires_in < 1 || value.expires_in > 3600) return unavailable();
        token = value.access_token;
      }
      if (!token || token.length > 16_384 || /\s/.test(token)) return unavailable();
      if (!rankingEnabled(dependencies.env ?? process.env, now())) return unavailable();
      const response = await fetchImpl(RANK_URL, {
        method: "POST", redirect: "error", signal, cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Goog-User-Project": RANKING_PROJECT },
        body: JSON.stringify({ model: RANKING_MODEL, query: prepared.query, records: prepared.records,
          topN: prepared.records.length, ignoreRecordDetailsInResponse: true }),
      });
      token = "";
      if (!response.ok) { await response.body?.cancel(); return unavailable(); }
      const result = await readJson(response, MAX_RESPONSE_BYTES);
      if (!object(result) || !Array.isArray(result.records) || result.records.length !== prepared.records.length) return unavailable();
      const seen = new Set<string>();
      const rows = result.records.map((row) => {
        if (!object(row) || typeof row.id !== "string" || !prepared.originalIds.has(row.id) || seen.has(row.id) ||
            typeof row.score !== "number" || !Number.isFinite(row.score) || row.score < 0 || row.score > 1) return unavailable();
        seen.add(row.id);
        return { id: prepared.originalIds.get(row.id)!, score: row.score };
      });
      return rows.toSorted((a, b) => b.score - a.score).map((row) => row.id);
    } catch { return unavailable(); }
  };
}
