// Storage オブジェクトパスの生成・検証ユーティリティ（クライアント/サーバー共用）。
// 規約: {scope_id}/{record_id}/{uuid}-{sanitized_filename}
//   scope_id は所属 household_id（Phase 3.5 手順8 以降の新規アップロード）。
//   household 未所属時と既存オブジェクトは旧規約どおり owner_id が先頭に入る。
// 先頭セグメントが household_id / owner_id のどちらであっても Storage RLS が
// メンバーシップ判定する前提（20260703120000_storage_household_paths.sql）。

// 入力由来のファイル名をサニタイズする。
export function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// アップロード先パスを生成する（衝突回避に uuid を付与）。
// scopeId には household_id（未所属時は owner_id）を渡す。
export function buildStoragePath(
  scopeId: string,
  recordId: string,
  fileName: string,
): string {
  return `${scopeId}/${recordId}/${crypto.randomUUID()}-${sanitizeFileName(fileName)}`;
}

// クライアント由来のパスが当該 scope_id / record_id 配下かを検証する（防御的サニタイズ）。
// scope プレフィックスだけだと別 record のパスを紐付けられてしまうため、
// 規約 {scope_id}/{record_id}/... の 2 セグメントまで一致を要求する。
export function isPathForRecord(
  path: string,
  scopeId: string,
  recordId: string,
): boolean {
  return path.startsWith(`${scopeId}/${recordId}/`);
}
