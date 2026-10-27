export const RANKING_MAX_CANDIDATES = 100;
export const RANKING_MAX_QUERY = 200;
export const RANKING_MAX_TEXT = 600;

export type RankingCandidate = { id: string; title: string; content: string };
export type PreparedRanking = {
  query: string;
  records: { id: string; title: string; content: string }[];
  originalIds: Map<string, string>;
};

/** Conservative masking, not a guarantee that arbitrary prose is anonymous. */
export function maskRankingText(text: string, knownNames: readonly string[] = []): string {
  let result = text.normalize("NFKC");
  const names = [...new Set(knownNames.map((name) => name.normalize("NFKC").trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const name of names) result = result.split(name).join("[名前]");
  return result
    .replace(/(?:https?|ftp):\/\/\S+|www\.\S+/giu, "[URL]")
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[メール]")
    .replace(/\b[A-Z0-9][A-Z0-9-]*(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}(?:\/[^\s]*)?/giu, "[URL]")
    .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{1,12}(?:さん|様|ちゃん|くん|先生)/gu, "[名前]")
    .replace(/[\p{N}]+(?:[.,:/+−-][\p{N}]+)*/gu, "[数値]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function prepareRanking(
  query: string,
  candidates: readonly RankingCandidate[],
  knownNames: readonly string[] = [],
): PreparedRanking {
  if (typeof query !== "string" || !query.trim() || query.length > RANKING_MAX_QUERY ||
      candidates.length < 1 || candidates.length > RANKING_MAX_CANDIDATES || knownNames.length > 300 ||
      knownNames.some((name) => typeof name !== "string" || name.length > 200)) {
    throw new Error("Invalid ranking input; details withheld.");
  }
  const originalIds = new Map<string, string>();
  const seen = new Set<string>();
  const records = candidates.map((candidate, index) => {
    if (!candidate || typeof candidate.id !== "string" || !candidate.id || candidate.id.length > 200 || seen.has(candidate.id) ||
        typeof candidate.title !== "string" || typeof candidate.content !== "string" ||
        candidate.title.length > 20_000 || candidate.content.length > 100_000) {
      throw new Error("Invalid ranking candidate; details withheld.");
    }
    seen.add(candidate.id);
    const id = `candidate-${index}`;
    originalIds.set(id, candidate.id);
    return {
      id,
      title: maskRankingText(candidate.title, knownNames).slice(0, RANKING_MAX_TEXT),
      content: maskRankingText(candidate.content, knownNames).slice(0, RANKING_MAX_TEXT),
    };
  });
  const safeQuery = maskRankingText(query, knownNames).slice(0, RANKING_MAX_QUERY);
  if (!safeQuery) throw new Error("Invalid ranking query; details withheld.");
  return { query: safeQuery, records, originalIds };
}
