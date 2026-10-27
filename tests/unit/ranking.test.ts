import { describe, expect, it, vi } from "vitest";
import { createRanking, rankingEnabled, RANKING_HARD_STOP, RANKING_MODEL } from "@/lib/ranking";
import { maskRankingText, prepareRanking } from "@/lib/rankingPrivacy";

const enabled = { MFMF_RANKING_ENABLED: "true", MFMF_RANKING_EXPIRES_AT: "2027-06-23T00:00:00+09:00" };
const now = () => Date.parse("2026-10-28T00:00:00+09:00");
const candidates = [
  { id: "90a088a2-8e66-4f10-a11c-f57a3be9a171", title: "架空太郎の保育園 2026/10/27", content: "架空ポチは休息。架空太郎 test@example.com https://example.test/private?token=secret 体重4.2kg" },
  { id: "480ebb5a-31c6-48bf-b30c-50796633bfc5", title: "おうち", content: "室内で元気に遊んだ。" },
];
const names = ["架空太郎", "架空ポチ"];
function fake(value: unknown = { records: [{ id: "candidate-1", score: 0.2 }, { id: "candidate-0", score: 0.8 }] }) {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response(JSON.stringify(value)));
  const getAccessToken = vi.fn(async () => "synthetic-access-token");
  return { rank: createRanking({ fetchImpl, getAccessToken, env: enabled, now }), fetchImpl, getAccessToken };
}

describe("opt-in record ranking", () => {
  it("requires an explicit flag, valid expiry and an unexpired hard stop", () => {
    expect(rankingEnabled({}, now())).toBe(false);
    expect(rankingEnabled({ ...enabled, MFMF_RANKING_ENABLED: "TRUE" }, now())).toBe(false);
    for (const value of [undefined, "", "tomorrow", "2027-06-25T00:00:00+09:00", "2026-01-01T00:00:00Z", "2027-02-30T00:00:00Z", "2027-04-31T00:00:00+09:00"]) {
      expect(rankingEnabled({ ...enabled, MFMF_RANKING_EXPIRES_AT: value }, now())).toBe(false);
    }
    expect(rankingEnabled(enabled, now())).toBe(true);
    expect(rankingEnabled({ ...enabled, MFMF_RANKING_EXPIRES_AT: "2027-06-24T00:00:00+09:00" }, RANKING_HARD_STOP)).toBe(false);
  });
  it("makes no authentication or API call when disabled", async () => {
    const fetchImpl = vi.fn(); const token = vi.fn();
    const rank = createRanking({ fetchImpl, getAccessToken: token, env: {}, now });
    await expect(rank("休息", candidates)).rejects.toThrow("details withheld");
    expect(fetchImpl).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled();
  });
  it("masks known people/pet names, mail, URLs and numbers before sending and maps only opaque IDs back", async () => {
    const h = fake();
    expect(await h.rank("架空ポチが10月に休んだ日", candidates, names)).toEqual([candidates[0].id, candidates[1].id]);
    const [url, options] = h.fetchImpl.mock.calls[0];
    expect(url).toBe("https://discoveryengine.googleapis.com/v1/projects/mfmf-499612/locations/global/rankingConfigs/default_ranking_config:rank");
    expect(options?.redirect).toBe("error"); expect(options?.cache).toBe("no-store"); expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.headers).toHaveProperty("Authorization", "Bearer synthetic-access-token");
    expect(options?.headers).not.toHaveProperty("X-Goog-User-Project");
    const body = String(options?.body);
    for (const privateValue of [...names, "test@example.com", "https://example.test", "token=secret", "4.2", ...candidates.map((r) => r.id)]) expect(body).not.toContain(privateValue);
    expect(JSON.parse(body)).toMatchObject({ model: RANKING_MODEL, topN: 2, ignoreRecordDetailsInResponse: true });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("caps each outbound title/content at 600 and query at 200 characters", () => {
    const p = prepareRanking("休".repeat(200), [{ id: "local", title: "遊".repeat(700), content: "眠".repeat(700) }]);
    expect(p.records[0].title).toHaveLength(600); expect(p.records[0].content).toHaveLength(600); expect(p.query).toHaveLength(200);
    expect(() => prepareRanking("休".repeat(201), candidates)).toThrow();
    expect(() => prepareRanking("休", Array.from({ length: 101 }, (_, i) => ({ id: String(i), title: "", content: "休" })))).toThrow();
    expect(() => prepareRanking("休", [candidates[0], candidates[0]])).toThrow();
    expect(() => prepareRanking(" ", candidates)).toThrow();
  });
  it("normalizes full-width numbers and masks common honorific names and bare links", () => {
    const text = maskRankingText("架空さん １２３４ example.test/path a@example.test");
    expect(text).not.toMatch(/１２３４|1234|example|架空/);
    expect(maskRankingText("利用者@架空.jp 名前＠例え.日本")).toBe("[メール] [メール]");
  });
  it.each([
    { records: [{ id: "foreign-id", score: 0.4 }, { id: "candidate-0", score: 0.2 }] },
    { records: [{ id: "candidate-0", score: 0.4 }, { id: "candidate-0", score: 0.2 }] },
    { records: [{ id: "candidate-0", score: -1 }, { id: "candidate-1", score: 0.2 }] },
    { records: [{ id: "candidate-0", score: 1.1 }, { id: "candidate-1", score: 0.2 }] },
    { records: [{ id: "candidate-0", score: null }, { id: "candidate-1", score: 0.2 }] },
    { records: [] }, { unexpected: "private-server-details" },
  ])("rejects malformed ranking responses without echoing raw content", async (response) => {
    const h = fake(response);
    await expect(h.rank("休息", candidates)).rejects.toThrow("Ranking is unavailable; details withheld.");
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized streaming JSON and does not retry", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ private: "x".repeat(40_000) })));
    await expect(createRanking({ fetchImpl, getAccessToken: async () => "token", env: enabled, now })("休息", candidates)).rejects.toThrow("details withheld");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("does not retry HTTP errors or return response bodies", async () => {
    const fetchImpl = vi.fn(async () => new Response("private details", { status: 429 }));
    await expect(createRanking({ fetchImpl, getAccessToken: async () => "token", env: enabled, now })("休息", candidates)).rejects.toThrow("details withheld");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("uses only the fixed metadata server with the metadata header for keyless runtime credentials", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).startsWith("http://metadata.")
      ? new Response(JSON.stringify({ access_token: "runtime-token", token_type: "Bearer", expires_in: 300 }), { headers: { "Metadata-Flavor": "Google" } })
      : new Response(JSON.stringify({ records: [{ id: "candidate-0", score: 0.7 }, { id: "candidate-1", score: 0.3 }] })));
    const rank = createRanking({ fetchImpl, env: enabled, now });
    await rank("休息", candidates);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
  });
});
