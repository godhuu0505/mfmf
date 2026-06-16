// Storage オブジェクトパスの生成・検証ユーティリティ（クライアント/サーバー共用）。
// 規約: {owner_id}/{record_id}/{uuid}-{sanitized_filename}
// 先頭セグメントが owner_id であることが Storage RLS の前提。

// 入力由来のファイル名をサニタイズする。
export function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// アップロード先パスを生成する（衝突回避に uuid を付与）。
export function buildStoragePath(
  ownerId: string,
  recordId: string,
  fileName: string,
): string {
  return `${ownerId}/${recordId}/${crypto.randomUUID()}-${sanitizeFileName(fileName)}`;
}

// クライアント由来のパスが本人フォルダ配下かを検証する（防御的サニタイズ）。
export function isOwnedStoragePath(path: string, ownerId: string): boolean {
  return path.startsWith(`${ownerId}/`);
}
