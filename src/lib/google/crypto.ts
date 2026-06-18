import crypto from "node:crypto";

// Google の refresh token をアプリ層で暗号化／復号するユーティリティ。
// node:crypto を使うためサーバー (Route Handler / Server Action) 専用。
// クライアントにバンドルされるとビルド時に解決できず弾かれる。

const ALGO = "aes-256-gcm";

// パスフレーズ (TOKEN_ENC_KEY) から 32 byte 鍵を導出する。
// 用途が単一なのでソルトは固定。任意長の文字列を鍵に使えるようにする。
function getKey(): Buffer {
  const secret = process.env.TOKEN_ENC_KEY;
  if (!secret) {
    throw new Error("TOKEN_ENC_KEY が設定されていません。");
  }
  return crypto.scryptSync(secret, "mfmf-google-cred", 32);
}

// 平文を AES-256-GCM で暗号化し "iv.tag.ciphertext" (いずれも base64) を返す。
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

// encryptSecret が返した文字列を復号する。改ざんは GCM の認証タグで検出される。
export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("暗号化データの形式が不正です。");
  }
  const decipher = crypto.createDecipheriv(
    ALGO,
    getKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
