# Managed authentication boundary

The default remains Supabase. `GCP_AUTH_ENABLED` and the build-time
`NEXT_PUBLIC_GCP_AUTH_ENABLED` must both be `true` to enable this implementation;
invalid or mismatched settings fail closed. UI markup is unchanged. Browser
Supabase access is disabled in the new mode; only the server's loopback PostgREST
bridge may access the database.

Required server settings: `GCP_PROJECT_ID`, `IDENTITY_PLATFORM_API_KEY`,
`GCP_AUTH_ORIGIN` (canonical origin, no path), and `GOOGLE_CLIENT_ID`. Production
uses HTTPS, ADC, and Node middleware. No Firebase emulator or service-account key
is needed. The runtime needs `firebaseauth.users.get` to check revocation and
`firebaseauth.users.update` for global signout and signup consent claims. The
existing `GOOGLE_CLIENT_SECRET` is used only by the separate Drive refresh helper.

## Session and admission

The browser receives only host-bound, Secure, HttpOnly, SameSite=Lax ID-token and
refresh-token cookies. It never receives an IdP token in JSON, localStorage, or
client state. Firebase Admin verifies signature/project and revocation before an
identity can reach the database. Only a known expired token can refresh; the
new token is verified and its subject must match. Disabled/revoked tokens cannot
refresh. A provider outage fails closed instead of falling back to Supabase.

Before issuing a verified session, `admit` must successfully map the identity
through `createGcpDataClient`. When signup is closed, Identity Platform must have
`disabledUserSignup=true`, and `sync_identity` must reject absent mappings with
`p_allow_create=false`. The `isNewUser` OAuth response alone is **not** a durable
signup restriction: a rejected first attempt can leave an IdP account behind.
Unverified signup cookies have no database identity; they only support completing
email verification in the same browser.

Signout revokes all refresh sessions before clearing local cookies. If revocation
fails, the local session is retained so retry can still authenticate and revoke
the account's other sessions. Password changes use the user's ID token and the
provider's recent-login checks, never an Admin password-update bypass.

## Google and email setup

Google uses the official `accounts:createAuthUri` code flow followed by
`accounts:signInWithIdp`. The fixed callback is `${GCP_AUTH_ORIGIN}/auth/callback`;
add it to the Google OAuth client's redirect URIs without removing existing
entries. The returned authorization URI must be on `accounts.google.com`, use
the configured client/callback, and include the requested nonce. A ten-minute
HttpOnly cookie binds `sessionId`, provider `state`, and nonce. Every callback
consumes that cookie, including cancellation. Google ID-token signature,
audience, nonce, and linked subject are checked before accepting the IdP session.
An optional provider refresh token is saved using the **mapped internal UUID**
and the existing encryption helper; it never reaches browser JavaScript.
In the GCP migration candidate, the server reads `get_media_storage_mode` before
saving a new provider refresh token. Explicit `frozen` preserves the restored
ciphertext and permits read-only sign-in; `gcs` performs the usual encrypted
save. Any mode-read error, unknown mode, or ordinary save failure fails closed.
The operator changes this mode and the full database write gate in one transaction;
the database guard remains authoritative if freezing races with a save.

Identity Platform's custom action-handler setting is **not configured**: the
production API rejected that update with `EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`.
Use Google's managed email verification and password-reset pages; no extra SMTP
service or relaxed permissions are required. `sendOobCode` fixes `continueUrl` to
`${GCP_AUTH_ORIGIN}/auth/identity/continue`. This route consumes no action code,
state, token, or query-string destination. It can only refresh the current
HttpOnly session while preserving its subject, then return to the sanitized
invite cookie. A missing, invalid, or revoked session returns to login.

Email verification in the same browser can resume automatically. Password reset
uses Google's new-password form and invalidates the old sessions; the user logs
in again on the app after returning. A different browser also logs in again.
The existing app's Supabase reset screen remains unchanged while the flag is
false; it is not the managed-email entry point. Invite `next` cookies remain
available throughout recovery. No action code reaches the application's new
continuation route or its logs.

All JSON mutations require the configured Origin, acceptable Fetch Metadata,
and a browser-bound CSRF token obtained from the same-origin endpoint. Request
and provider-response sizes are bounded. Errors return fixed classifications;
upstream bodies and tokens are not logged.

## Acceptance before cutover

Unit tests and placeholder builds cover request boundaries and both flags; they
do not prove production provider configuration. Confirm imported password login,
Google success/cancel and retained invite, Google-hosted email verification/reset
and used-code rejection, old-session revocation and re-login, same-value settings save, and closed-signup
first/repeated attempts against the private candidate before enabling production.
Keep the existing auth/database backup and explicit rollback gate intact.

Official contracts:
- https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/createAuthUri
- https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/signInWithIdp
- https://firebase.google.com/docs/reference/rest/auth
- https://firebase.google.com/docs/auth/admin/manage-sessions
- https://firebase.google.com/docs/auth/custom-email-handler
