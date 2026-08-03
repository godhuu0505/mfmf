import { afterEach, describe, expect, it, vi } from "vitest";
import { isSignupEnabled } from "@/lib/signup";

// UC-O08: /signup は env フラグで既定クローズ。
// 「未設定 = 閉じる」が破れると公開前にサインアップが開く。

describe("isSignupEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("未設定なら false（既定はクローズ）", () => {
    vi.stubEnv("SIGNUP_ENABLED", undefined);
    expect(isSignupEnabled()).toBe(false);
  });

  it('"false" なら false', () => {
    vi.stubEnv("SIGNUP_ENABLED", "false");
    expect(isSignupEnabled()).toBe(false);
  });

  it('"true" のときだけ true', () => {
    vi.stubEnv("SIGNUP_ENABLED", "true");
    expect(isSignupEnabled()).toBe(true);
  });

  it('厳密比較: "TRUE" / "1" / " true" は開かない', () => {
    for (const v of ["TRUE", "True", "1", " true", "true "]) {
      vi.stubEnv("SIGNUP_ENABLED", v);
      expect(isSignupEnabled()).toBe(false);
    }
  });
});
