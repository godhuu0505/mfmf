import { describe, expect, it } from "vitest";
import { feedbackPage, parseFeedbackContext } from "@/lib/feedbackContext";

describe("feedback context privacy", () => {
  it.each([
    ["/records/new?return=/invite/secret", "/records/new"],
    ["/records/private-id?name=private#secret", "/records/[id]"],
    ["/share/private-token", "/share/[token]"],
    ["/invite/private-token", "/invite/[token]"],
    ["//evil.example/records/id", "other"],
    ["/unexpected/private", "other"],
  ])("normalizes %s without retaining identifiers", (input, expected) => {
    expect(feedbackPage(input)).toBe(expected);
  });

  it("rebuilds untrusted context using only a bounded route and boolean flags", () => {
    expect(parseFeedbackContext(JSON.stringify({
      page_path: "/records/private?token=secret", page_url: "https://example.com/?secret",
      user_agent: "private", extra: { password: "private" }, online: true, standalone: false,
    }))).toEqual({ page_path: "/records/[id]", online: true, standalone: false });
    expect(parseFeedbackContext(JSON.stringify({ page_path: 1, online: "true" }))).toEqual({ page_path: "other" });
    expect(parseFeedbackContext("[]")).toBeNull();
    expect(parseFeedbackContext("{" + "a".repeat(4096))).toBeNull();
  });
});
