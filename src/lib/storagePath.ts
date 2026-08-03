// Storage オブジェクトパスの生成・検証ユーティリティ（クライアント/サーバー共用）。
// 規約: {household_id}/{record_id}/{uuid}-{sanitized_filename}
//   （Phase 3.5 手順8 以降の新規アップロード。旧オブジェクトは owner_id 先頭のまま残る）
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
// **必ず household_id を渡すこと。** owner_id を渡したパスは insert ポリシーが無いので
// Storage RLS で落ちる（上の ⚠️）。「未所属時は owner_id」という旧い呼び方はもう成立しない。
export function buildStoragePath(
  householdId: string,
  recordId: string,
  fileName: string,
): string {
  return `${householdId}/${recordId}/${crypto.randomUUID()}-${sanitizeFileName(fileName)}`;
}

// アバター画像のアップロード先パスを生成する。
// 規約: {scope_id}/avatars/{uuid}-{sanitized_filename}
//   scope_id は household_id（ペット/世帯アバター）または owner_id（ユーザーアバター）。
// Storage RLS が先頭セグメント（scope_id）でメンバーシップ / 本人を判定する
// （20260706120000_avatars.sql）。
export function buildAvatarPath(scopeId: string, fileName: string): string {
  return `${scopeId}/avatars/${crypto.randomUUID()}-${sanitizeFileName(fileName)}`;
}

// クライアント由来のアバターパスが当該 scope_id/avatars 配下かを検証する（防御的サニタイズ）。
// 一次防衛線は Storage RLS だが、Server Action でも他 scope のパスを紐付けられないよう確認する。
export function isAvatarPathForScope(path: string, scopeId: string): boolean {
  return path.startsWith(`${scopeId}/avatars/`);
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
