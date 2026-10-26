import { describe, expect, it } from "vitest";
import { callbackRetryNext, sanitizeNextPath, withNext } from "@/lib/nextPath";

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

describe("withNext", () => {
  it("戻り先が無いときはパスをそのまま返す", () => {
    expect(withNext("/login", "/")).toBe("/login");
  });

  it("戻り先をクエリに載せる（エンコードする）", () => {
    expect(withNext("/login", "/invite/abc123")).toBe(
      "/login?next=%2Finvite%2Fabc123",
    );
    expect(withNext("/signup", "/records/1?edit=1")).toBe(
      "/signup?next=%2Frecords%2F1%3Fedit%3D1",
    );
  });
});

describe("callbackRetryNext", () => {
  it("OAuth の失敗時は Cookie の元の招待へ戻す", () => {
    expect(callbackRetryNext(null, "/invite/original")).toBe("/invite/original");
  });

  it("通常の明示的な戻り先は Cookie より優先する", () => {
    expect(callbackRetryNext("/invite/current", "/invite/previous")).toBe(
      "/invite/current",
    );
  });

  it("回復リンクに失敗したときは再設定画面でなく元の招待へ戻す", () => {
    expect(callbackRetryNext("/reset-password", "/invite/original")).toBe(
      "/invite/original",
    );
    expect(callbackRetryNext("/reset-password", undefined)).toBe("/");
  });

  it("回復経路でも外部 URL を戻り先にしない", () => {
    expect(callbackRetryNext("/reset-password", "//evil.example")).toBe("/");
    expect(callbackRetryNext(null, "/\\evil.example")).toBe("/");
    expect(callbackRetryNext("https://evil.example", "/invite/safe")).toBe("/");
  });
});
