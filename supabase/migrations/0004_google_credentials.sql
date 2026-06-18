-- =============================================================
-- mfmf / Google Drive 連携クレデンシャル
-- 共有方針 (A) を踏襲: household_id は持たず owner_id (= auth.uid()) ベースで RLS
--
-- Google ログイン (OAuth) の初回同意時に得られる refresh token を保存する。
-- 画像プロキシ (/api/photo/*) やアップロード用トークン発行で、保存済み
-- refresh token から短命の access token を都度発行するために使う。
--
-- ★ refresh token は「アプリ層で AES-256-GCM 暗号化した文字列」を保存する
--   (src/lib/google/crypto.ts)。RLS で自分の行だけに限定するが、ブラウザの
--   anon クライアントからも同一セッションでは行が見えてしまうため、平文では
--   保存しない。復号鍵 (TOKEN_ENC_KEY) はサーバー専用環境変数で、リポジトリ・
--   クライアントには置かない。service_role は本アプリでは使わない。
-- =============================================================

-- ---------------------------------------------------------------
-- 1. テーブル: google_credentials
-- ---------------------------------------------------------------
create table if not exists public.google_credentials (
  owner_id          uuid        primary key references auth.users (id) on delete cascade,
  refresh_token_enc text        not null,   -- AES-256-GCM 暗号化済み refresh token ("iv.tag.ciphertext" base64)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.google_credentials is 'Google Drive 連携用 OAuth refresh token (アプリ層で暗号化して保存)';
comment on column public.google_credentials.refresh_token_enc is 'AES-256-GCM 暗号化済み refresh token。復号鍵は TOKEN_ENC_KEY (サーバー専用)';

-- ---------------------------------------------------------------
-- 2. RLS (行レベルセキュリティ) — 自分の連携情報のみ参照・操作可能
-- ---------------------------------------------------------------
alter table public.google_credentials enable row level security;

drop policy if exists "google_credentials_select_own" on public.google_credentials;
create policy "google_credentials_select_own"
  on public.google_credentials for select
  using (auth.uid() = owner_id);

drop policy if exists "google_credentials_insert_own" on public.google_credentials;
create policy "google_credentials_insert_own"
  on public.google_credentials for insert
  with check (auth.uid() = owner_id);

drop policy if exists "google_credentials_update_own" on public.google_credentials;
create policy "google_credentials_update_own"
  on public.google_credentials for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "google_credentials_delete_own" on public.google_credentials;
create policy "google_credentials_delete_own"
  on public.google_credentials for delete
  using (auth.uid() = owner_id);
