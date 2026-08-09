import { describe, expect, it } from "vitest";
import { sanitizeNextPath } from "@/lib/nextPath";

describe("sanitizeNextPath", () => {
  it("サイト内の絶対パスはそのまま通す（招待リンクの deep link）", () => {
    expect(sanitizeNextPath("/invite/abc123")).toBe("/invite/abc123");
    expect(sanitizeNextPath("/records/1?edit=1")).toBe("/records/1?edit=1");
  });

  it("未指定・空文字はフォールバックへ", () => {
    expect(sanitizeNextPath(null)).toBe("/");
    expect(sanitizeNextPath(undefined)).toBe("/");
    expect(sanitizeNextPath("")).toBe("/");
    expect(sanitizeNextPath(null, "/login")).toBe("/login");
  });

  it("外部オリジンへのリダイレクトは弾く（オープンリダイレクト防止）", () => {
    expect(sanitizeNextPath("https://evil.example")).toBe("/");
    expect(sanitizeNextPath("//evil.example")).toBe("/");
    expect(sanitizeNextPath("/\\evil.example")).toBe("/");
    expect(sanitizeNextPath("javascript:alert(1)")).toBe("/");
    expect(sanitizeNextPath("invite/abc")).toBe("/");
  });

  it("制御文字入りのパスは弾く", () => {
    expect(sanitizeNextPath("/\n/evil.example")).toBe("/");
    expect(sanitizeNextPath("/\t/evil.example")).toBe("/");
  });
});
