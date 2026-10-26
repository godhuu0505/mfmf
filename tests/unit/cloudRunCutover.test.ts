import { describe, expect, it } from "vitest";
import { cloudRunCutoverRoute } from "@/lib/cloudRunCutover";

const input = { vercel: true, readBackend: "gcs" as const, method: "GET", pathname: "/gallery", search: "?page=2" };
describe("Cloud Run storage cutover", () => {
  it("preserves the app path and query at the fixed GCP origin", () => {
    expect(cloudRunCutoverRoute(input)).toEqual({ kind: "redirect", location: "https://mfmf-candidate-wspqvmhj6q-an.a.run.app/gallery?page=2" });
  });
  it.each(["//evil.invalid", "/\\evil.invalid", "/%2f%2fevil.invalid"])("cannot turn %s into a destination host", (pathname) => {
    const result = cloudRunCutoverRoute({ ...input, pathname });
    expect(result.kind).toBe("redirect");
    if (result.kind === "redirect") expect(new URL(result.location).origin).toBe("https://mfmf-candidate-wspqvmhj6q-an.a.run.app");
  });
  it.each(["POST", "PUT", "PATCH", "DELETE"])("refuses forwarding an old %s body", (method) => {
    expect(cloudRunCutoverRoute({ ...input, method })).toEqual({ kind: "reload" });
  });
  it("keeps the source origin while its read backend is Supabase", () => {
    expect(cloudRunCutoverRoute({ ...input, readBackend: "supabase" })).toEqual({ kind: "continue" });
  });
  it("keeps GCP routing during a write freeze after cutover", () => {
    // The database returns gcs for read_backend even when mode is frozen.
    expect(cloudRunCutoverRoute(input).kind).toBe("redirect");
  });
  it("never redirects the Cloud Run runtime back to itself", () => {
    expect(cloudRunCutoverRoute({ ...input, vercel: false })).toEqual({ kind: "continue" });
  });
  it.each(["/auth/callback", "/reset-password"])("preserves an existing recovery session at %s", (pathname) => {
    expect(cloudRunCutoverRoute({ ...input, pathname })).toEqual({ kind: "continue" });
    expect(cloudRunCutoverRoute({ ...input, pathname: pathname + "/other" }).kind).toBe("redirect");
  });
  it.each(["/auth/next", "/auth/signout"])("preserves the original cookie-origin auth POST at %s", (pathname) => {
    expect(cloudRunCutoverRoute({ ...input, pathname, method: "POST" })).toEqual({ kind: "continue" });
  });
});
