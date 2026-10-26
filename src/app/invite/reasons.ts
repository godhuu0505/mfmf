// 受諾に失敗した理由（/invite/{token}?error=... で受け渡す固定コード）。
// URL 由来の文字列をそのまま画面に出さないため、コード → 文言はここで引く。
export const INVITE_ERROR_REASONS = [
  "mismatch",
  "invalid",
  "already_member",
  "unknown",
] as const;

export type InviteErrorReason = (typeof INVITE_ERROR_REASONS)[number];

const MESSAGES: Record<InviteErrorReason, string> = {
  mismatch:
    "ログイン中のアカウントのメールアドレスが、招待の宛先と一致しませんでした。",
  invalid:
    "この招待は受け付けられませんでした（期限切れ・取消済み・使用済み、または対象のペットが削除されています）。",
  already_member:
    "既にこの世帯のメンバーのため、ゲストとして参加する必要はありません。",
  unknown:
    "招待を受諾できませんでした。時間をおいて再度お試しください。",
};

export function inviteErrorMessage(raw: string | undefined): string | null {
  if (!raw) return null;
  return (INVITE_ERROR_REASONS as readonly string[]).includes(raw)
    ? MESSAGES[raw as InviteErrorReason]
    : MESSAGES.unknown;
}
