# アイデンティティ連携の方針（Google と email/password の同一メール）

Issue [#117](https://github.com/godhuu0505/mfmf/issues/117) §4 / [#35](https://github.com/godhuu0505/mfmf/issues/35) 認証強化と連携。
一般公開（`SIGNUP_ENABLED` 開放）前に、同一人物が **Google** と **email/password** の
両方でログインしたときの挙動を確定しておくためのメモ。設計・決定の経緯は
[phase-3-5-use-cases.md](./phase-3-5-use-cases.md) §7（未決事項）を参照。

## 論点

mfmf は**世帯（household）単位で共有し、各自が自分のアカウントで参加する**前提で、認証は Google OAuth と
email/password（S5 で追加、`drive.file` 非依存の外部ゲスト向け D3）の 2 系統がある。
同じメールアドレスの人が両方でログインしたとき、**1 つのユーザーに統合されるのか、
別々のユーザーになるのか**を把握しておかないと、「片方で入ると自分の記録が見えない」
といった事故につながる。

## Supabase の挙動（結論）

Supabase Auth は **同一メールアドレスのアイデンティティを自動的に 1 ユーザーへリンクする**
（Automatic Linking）。出典: [Supabase Docs — Identity Linking](https://supabase.com/docs/guides/auth/auth-identity-linking)。

> "Supabase Auth automatically links identities with the same email address to a single user. […] When a new user signs in with OAuth, Supabase Auth will attempt to look for an existing user that uses the same email address. If a match is found, the new identity is linked to the user."

重要な前提と安全策:

- **メール検証が前提**。未検証メールへの自動リンクは pre-account-takeover（先回り乗っ取り）
  の危険があるため行わない。新しいアイデンティティをリンクする際、既存ユーザーに紐づく
  **未確認（unconfirmed）のアイデンティティは除去される**。
  > "It would also be an insecure practice to automatically link an identity to a user with an unverified email address since that could lead to pre-account takeover attacks. […] Supabase Auth will remove any other unconfirmed identities linked to an existing user."
- **列挙攻撃対策**。OAuth で登録済みのメールで後から email 登録を試みると、検証メールは
  送られず難読化されたレスポンスが返る（成功可否を漏らさない）。
  > "If you try to create an email account after previously signing up with OAuth using the same email, you'll receive an obfuscated user response with no verification email sent."
- **SAML SSO** のユーザーはリンク対象外（本アプリは未使用）。
- `getUserIdentities()` で、あるユーザーに紐づくアイデンティティ一覧を確認できる。

## mfmf での前提と整合

- OAuth（Google）が返すメールは検証済み。email/password 側は
  `enable_confirmations = true`（`supabase/config.toml` [auth.email]）でメール確認必須。
  → **両系統とも「検証済みメール」になるため、同一メールなら自動リンクで 1 アカウントに
  統合される**。これは共用アカウント前提の mfmf にとって望ましい挙動。
- 手動リンク（`linkIdentity()` / `unlinkIdentity()`）は使わない。
  `enable_manual_linking = false`（`config.toml` [auth]）のまま。自動リンクだけで
  同一メールの統合は成立し、手動リンク API を開けると攻撃面が増えるため閉じておく。

## 決定（方針）

1. **自動リンクに委ねる**。同一メールの Google / email 統合は Supabase の Automatic Linking で
   成立させ、アプリ側で明示的なマージ処理は実装しない。
2. **`enable_manual_linking = false` を維持**する（ローカル `config.toml` と本番ダッシュボードの
   両方）。手動リンク UI は提供しない。
3. **email 確認を必須のままにする**（`enable_confirmations = true`）。未検証メールが
   自動リンクの対象にならない安全策の前提を崩さない。
4. 詳細な多要素・再認証・パスワードレスの強化は [#35](https://github.com/godhuu0505/mfmf/issues/35)
   （Phase 4）で扱う。本メモは「同一メールの統合挙動の確定」までを範囲とする。

## 公開前の実挙動チェックリスト（本番 or ステージングで手動確認）

コードだけでは確定できないため、公開（`SIGNUP_ENABLED` 開放）前に実プロジェクトで確認する:

- [ ] 本番ダッシュボードの Authentication 設定で **Manual linking が無効**であることを確認。
- [ ] 同一メールで **先に email/password 登録 → 後から Google ログイン** したとき、
      同じユーザーになり、既存の世帯・記録がそのまま見えること。
- [ ] 逆順（**先に Google → 後から email/password**）でも同一ユーザーに統合されること
      （必要なら OAuth アカウントに `updateUser({ password })` で email/password を付与）。
- [ ] メール未確認のまま OAuth ログインした場合に、未確認アイデンティティが除去され
      不整合な二重アカウントが残らないこと。
- [ ] `getUserIdentities()` で、統合後に `google` と `email` の両アイデンティティが
      1 ユーザーに紐づいて見えること。

## 参照

- Supabase Docs — [Identity Linking](https://supabase.com/docs/guides/auth/auth-identity-linking)
- 認証まわりの設定: `supabase/config.toml` [auth] / [auth.email]
- Phase 3.5 の未決事項一覧: [phase-3-5-use-cases.md](./phase-3-5-use-cases.md) §7
