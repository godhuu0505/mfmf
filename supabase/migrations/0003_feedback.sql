-- =============================================================
-- mfmf / 障害報告・機能要望フォーム (フィードバック)
-- 共有方針 (A) を踏襲: household_id は持たず owner_id (= auth.uid()) ベースで RLS
-- アプリ内のフローティングフォームから送信された内容を保存する。
-- （送信時に GitHub Issue へ自動転記するが、DB にも控えを残す）
-- =============================================================

-- ---------------------------------------------------------------
-- 1. テーブル: feedback (障害報告 / 機能要望)
-- ---------------------------------------------------------------
create table if not exists public.feedback (
  id                  uuid        primary key default gen_random_uuid(),
  owner_id            uuid        not null references auth.users (id) on delete cascade,
  -- 種類: 'bug'(うまく動かない) / 'request'(要望) / 'question'(質問・その他)
  kind                text        not null default 'bug',
  -- 困り度: 'blocker' / 'annoying' / 'minor' / 'idea' (任意)
  severity            text,
  -- 起きる頻度: 'always' / 'sometimes' / 'once' / 'unknown' (任意)
  frequency           text,
  title               text,                              -- 件名 (任意 / 空ならサーバー側で生成)
  body                text        not null default '',   -- 内容 (フォーム上の唯一の必須項目)
  when_happened       text,                              -- いつ起きたか (任意・自由記述)
  expected            text,                              -- 期待した動き (任意)
  actual              text,                              -- 実際に起きたこと (任意)
  reporter            text,                              -- 記入者 (任意)
  context             jsonb,                             -- 送信時に自動収集したアプリの状況
  github_issue_url    text,                              -- 転記した GitHub Issue の URL
  github_issue_number integer,                           -- 同 Issue 番号
  created_at          timestamptz not null default now()
);

comment on table public.feedback is 'アプリ内フォームから送信された障害報告・機能要望';
comment on column public.feedback.kind is '種類: bug / request / question';
comment on column public.feedback.context is '送信時に自動収集したアプリの状況 (画面パス・端末情報など)';
comment on column public.feedback.github_issue_url is '自動転記した GitHub Issue の URL (転記に失敗した場合は null)';

create index if not exists feedback_owner_created_idx
  on public.feedback (owner_id, created_at desc);

-- ---------------------------------------------------------------
-- 2. RLS (行レベルセキュリティ) — 自分の送信分のみ参照・操作可能
-- ---------------------------------------------------------------
alter table public.feedback enable row level security;

drop policy if exists "feedback_select_own" on public.feedback;
create policy "feedback_select_own"
  on public.feedback for select
  using (auth.uid() = owner_id);

drop policy if exists "feedback_insert_own" on public.feedback;
create policy "feedback_insert_own"
  on public.feedback for insert
  with check (auth.uid() = owner_id);

drop policy if exists "feedback_update_own" on public.feedback;
create policy "feedback_update_own"
  on public.feedback for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "feedback_delete_own" on public.feedback;
create policy "feedback_delete_own"
  on public.feedback for delete
  using (auth.uid() = owner_id);
