import { describe, expect, it } from "vitest";
import { siteRedirect, siteRelativeLocation } from "@/lib/siteRedirect";
import { isSameOriginPost } from "@/lib/sameOriginPost";

describe("siteRelativeLocation", () => {
  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "/a/..//evil.example", "/a/%2e%2e//evil.example", "/a/..\\/evil.example", "/\n/evil.example"])("rejects external or normalized authority boundary: %s", (path) => {
    expect(siteRelativeLocation(path)).toBe("/");
  });
  it.each(["/invite/token", "/records/1?edit=1#photo", "/%2f%2fevil.example", "/%5cevil.example"])("keeps a site path on the current origin: %s", (path) => {
    const location = siteRelativeLocation(path);
    expect(new URL(location, "https://public.example").origin).toBe("https://public.example");
  });
  it("encodes Unicode and preserves only a relative Location", () => {
    const response = siteRedirect("/記録?検索=写真#写真", 303);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/%E8%A8%98%E9%8C%B2?%E6%A4%9C%E7%B4%A2=%E5%86%99%E7%9C%9F#%E5%86%99%E7%9C%9F");
  });
});

describe("same-origin cookie POST", () => {
  function request(headers: Record<string, string>) {
    return { url: "https://0.0.0.0:18080/auth/next", headers: new Headers(headers) };
  }
  it("uses browser same-origin evidence when standalone has an internal URL", () => {
    expect(isSameOriginPost(request({ origin: "https://public.example", "sec-fetch-site": "same-origin" }))).toBe(true);
  });
  it.each(["cross-site", "same-site", "none", "unknown", "same-origin, same-origin", "Same-Origin"])("rejects %s even when Origin otherwise matches", (site) => {
    expect(isSameOriginPost(request({ origin: "https://0.0.0.0:18080", "sec-fetch-site": site }))).toBe(false);
  });
  it("requires an exact, present Origin when Fetch Metadata is missing", () => {
    expect(isSameOriginPost(request({ origin: "https://0.0.0.0:18080" }))).toBe(true);
    expect(isSameOriginPost(request({ origin: "https://public.example" }))).toBe(false);
    expect(isSameOriginPost(request({ origin: "null" }))).toBe(false);
    expect(isSameOriginPost(request({}))).toBe(false);
  });
  it("does not trust Host or Forwarded headers as same-origin evidence", () => {
    expect(isSameOriginPost(request({ origin: "https://evil.example", host: "evil.example",
      "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", forwarded: "host=evil.example;proto=https" }))).toBe(false);
  });
});
