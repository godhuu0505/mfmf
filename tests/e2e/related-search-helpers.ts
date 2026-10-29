import type { Page, Route } from "@playwright/test";
import type { RelatedSearchResponse } from "../../src/app/(app)/records/related-actions";

export const RELATED_FIXTURE: RelatedSearchResponse = {
  status: "ranked", candidateCount: 2, truncated: false,
  records: [
    { id: "923d0d02-cb1c-4dc1-9224-87439557bbd6", recordDate: "2026-10-18", source: "daycare", body: "架空の記録：保育園で遊び、帰宅後は静かな場所でゆっくり眠った。" },
    { id: "4b0ea642-1b9a-4694-96c7-d6881e3504b8", recordDate: "2026-10-16", source: "home", body: "架空の記録：雨の日に室内で遊び、ソファで昼寝をした。" },
  ],
};

export function relatedResponse(status: RelatedSearchResponse["status"]): RelatedSearchResponse {
  return { status, records: [], candidateCount: 0, truncated: false };
}

/** Browser-side interception only. Login and the rendered page keep real local auth. */
export async function interceptRelatedSearch(page: Page, reply: () => Promise<RelatedSearchResponse> | RelatedSearchResponse = () => RELATED_FIXTURE) {
  let calls = 0;
  const handler = async (route: Route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) return route.continue();
    calls++;
    const result = await reply();
    // Next 15's action reducer reads a=result and f=optional route patch. No
    // route patch or fake authenticated session is supplied by this fixture.
    await route.fulfill({ status: 200, contentType: "text/x-component", body: `0:${JSON.stringify({ a: result, f: [] })}\n` });
  };
  await page.route("**/*", handler);
  return { calls: () => calls, remove: () => page.unroute("**/*", handler) };
}
