import { describe, expect, it } from "vitest";
import type { User } from "@supabase/supabase-js";
import { getAvatarInitial, getOAuthAvatarUrl } from "@/lib/userAvatar";

function userWith(metadata: Record<string, unknown>): User {
  return { user_metadata: metadata } as unknown as User;
}

describe("getOAuthAvatarUrl", () => {
  it("Google の avatar_url を拾う", () => {
    expect(
      getOAuthAvatarUrl(
        userWith({ avatar_url: "https://lh3.googleusercontent.com/a/abc=s96-c" }),
      ),
    ).toBe("https://lh3.googleusercontent.com/a/abc=s96-c");
  });

  it("avatar_url が無ければ picture を見る", () => {
    expect(getOAuthAvatarUrl(userWith({ picture: "https://example.com/p.jpg" }))).toBe(
      "https://example.com/p.jpg",
    );
  });

  it("http(s) 以外のスキームは使わない", () => {
    expect(getOAuthAvatarUrl(userWith({ avatar_url: "javascript:alert(1)" }))).toBeNull();
    expect(getOAuthAvatarUrl(userWith({ avatar_url: "data:image/png;base64,AA" }))).toBeNull();
  });

  it("未設定 / 不正な値 / user なしは null", () => {
    expect(getOAuthAvatarUrl(userWith({}))).toBeNull();
    expect(getOAuthAvatarUrl(userWith({ avatar_url: "   " }))).toBeNull();
    expect(getOAuthAvatarUrl(userWith({ avatar_url: 123 }))).toBeNull();
    expect(getOAuthAvatarUrl(userWith({ avatar_url: "not a url" }))).toBeNull();
    expect(getOAuthAvatarUrl(null)).toBeNull();
  });
});

describe("getAvatarInitial", () => {
  it("先に指定した値を優先する（表示名 > メール）", () => {
    expect(getAvatarInitial("ごど", "go.d@example.com")).toBe("ご");
    expect(getAvatarInitial(null, "go.d@example.com")).toBe("G");
    expect(getAvatarInitial("  ", "go.d@example.com")).toBe("G");
  });

  it("英字は大文字にする", () => {
    expect(getAvatarInitial("taro")).toBe("T");
  });

  it("サロゲートペアを壊さない", () => {
    expect(getAvatarInitial("𩸽の家")).toBe("𩸽");
    expect(getAvatarInitial("🐶ぽち")).toBe("🐶");
  });

  it("候補が無ければ空文字", () => {
    expect(getAvatarInitial(null, undefined, "")).toBe("");
  });
});
