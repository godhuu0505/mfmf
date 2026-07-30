// Storage オブジェクトパスの生成・検証ユーティリティ（クライアント/サーバー共用）。
// 規約: {scope_id}/{record_id}/{uuid}-{sanitized_filename}
//   scope_id は所属 household_id（Phase 3.5 手順8 以降の新規アップロード）。
//
// ⚠️ 旧規約（owner_id 先頭）への**アップロードはもう通らない**。
// daycare_photos_insert_own は 20260704000000_rbac_switch_and_management.sql で
// drop されており、生きている insert ポリシーは household パス用の
// daycare_photos_insert_household だけ（20260703170000_rbac_roles.sql）。
// 既存オブジェクトは daycare_photos_{select,delete}_shared_owner で
// 「その記録の世帯のメンバー」に読取/削除のみ開かれている。
// したがって scopeId に owner_id を渡す経路が残っていれば、それは insert が
// RLS で落ちる（未所属ユーザーは /onboarding で世帯作成へ回されるため通常は到達しない）。

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
