import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/google/crypto";

// Google refresh token の暗号化。守るのは 3 点:
// 往復できること・鍵が違えば復号できないこと・改竄が検知されること。

// base64 の 1 バイトを反転させて返す（改竄の再現）
function tamper(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  buf[0] ^= 0xff;
  return buf.toString("base64");
}

describe("encryptSecret / decryptSecret", () => {
  beforeEach(() => {
    vi.stubEnv("TOKEN_ENC_KEY", "test-passphrase-1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("往復で平文が戻る（マルチバイト含む）", () => {
    for (const plaintext of ["refresh-token-abc123", "秘密のトークン🐕", ""]) {
      expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
    }
  });

  it("出力は iv.tag.ciphertext（base64 3 分割）の形式", () => {
    const payload = encryptSecret("x");
    const parts = payload.split(".");
    expect(parts.length).toBe(3);
    expect(Buffer.from(parts[0], "base64").length).toBe(12); // GCM の IV
    expect(Buffer.from(parts[1], "base64").length).toBe(16); // 認証タグ
  });

  it("IV がランダムなので同じ平文でも暗号文は毎回異なる", () => {
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same");
    expect(decryptSecret(b)).toBe("same");
  });

  it("鍵が違うと復号は失敗する（黙って別の平文が返ったりしない）", () => {
    const payload = encryptSecret("secret");
    vi.stubEnv("TOKEN_ENC_KEY", "different-passphrase");
    expect(() => decryptSecret(payload)).toThrow();
  });

  it("暗号文の改竄は GCM の認証タグで検知される", () => {
    const [iv, tag, data] = encryptSecret("secret").split(".");
    expect(() => decryptSecret([iv, tag, tamper(data)].join("."))).toThrow();
  });

  it("認証タグ自体の改竄も検知される", () => {
    const [iv, tag, data] = encryptSecret("secret").split(".");
    expect(() => decryptSecret([iv, tamper(tag), data].join("."))).toThrow();
  });

  it("IV の差し替えも検知される", () => {
    const [iv, tag, data] = encryptSecret("secret").split(".");
    expect(() => decryptSecret([tamper(iv), tag, data].join("."))).toThrow();
  });

  it("形式が不正なペイロードは分かりやすいエラーで落ちる", () => {
    for (const bad of ["", "abc", "a.b", "..", "a.b.c.d.e"]) {
      expect(() => decryptSecret(bad)).toThrow();
    }
  });

  it("TOKEN_ENC_KEY 未設定では暗号化も復号もできない", () => {
    const payload = encryptSecret("secret");
    vi.stubEnv("TOKEN_ENC_KEY", "");
    expect(() => encryptSecret("x")).toThrow(/TOKEN_ENC_KEY/);
    expect(() => decryptSecret(payload)).toThrow(/TOKEN_ENC_KEY/);
  });
});
