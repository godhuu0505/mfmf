-- =============================================================
-- mfmf / ペット保育園記録アプリ  フェーズ2 読み取り専用の共有リンク
--   - 祖父母など第三者に、特定期間の記録を「閲覧のみ」で安全に共有する。
--   - 共有はトークンで行い、期限切れ / 失効で確実に無効化できる。
--   - 写真は含めない（private Storage の署名 URL を匿名に出すには service_role
--     等が必要になり「service_role を使わない」不変条件に反するため、本 MVP は
--     テキスト記録のみ。写真共有は将来の課題）。
-- 共有方針 (A) を踏襲: owner_id (= auth.uid()) ベースの RLS。
-- 既存テーブル / ポリシーは変更しない（追加のみ）。
-- =============================================================

-- ---------------------------------------------------------------
-- 1. テーブル: share_links
-- ---------------------------------------------------------------
create table if not exists public.share_links (
  id          uuid        primary key default gen_random_uuid(),
  owner_id    uuid        not null default auth.uid()
                          references auth.users (id) on delete cascade,
  token       text        not null unique,            -- 推測不能なランダム文字列
  label       text,                                   -- 共有相手のメモ（任意）
  from_date   date,                                   -- この日以降の記録のみ（任意）
  to_date     date,                                   -- この日以前の記録のみ（任意）
  expires_at  timestamptz,                            -- 期限（任意・null は無期限）
  revoked_at  timestamptz,                            -- 失効時刻（null は有効）
  created_at  timestamptz not null default now()
);

comment on table public.share_links is '読み取り専用の共有リンク (owner_id = auth.uid())';
comment on column public.share_links.token is '推測不能なランダムトークン（URL に載る）';
comment on column public.share_links.expires_at is '期限。null は無期限';
comment on column public.share_links.revoked_at is '失効時刻。null は有効';

create index if not exists share_links_owner_idx
  on public.share_links (owner_id, created_at desc);

-- ---------------------------------------------------------------
-- 2. RLS: 共有リンクの管理は本人のみ。匿名の直接アクセスは不可。
-- ---------------------------------------------------------------
alter table public.share_links enable row level security;

drop policy if exists "share_links_select_own" on public.share_links;
create policy "share_links_select_own"
  on public.share_links for select
  using (auth.uid() = owner_id);

drop policy if exists "share_links_insert_own" on public.share_links;
create policy "share_links_insert_own"
  on public.share_links for insert
  with check (auth.uid() = owner_id);

drop policy if exists "share_links_update_own" on public.share_links;
create policy "share_links_update_own"
  on public.share_links for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "share_links_delete_own" on public.share_links;
create policy "share_links_delete_own"
  on public.share_links for delete
  using (auth.uid() = owner_id);

-- ---------------------------------------------------------------
-- 3. 読み取り専用の共有ビューを返す SECURITY DEFINER 関数
--    匿名(anon)からも呼べるが、有効なトークンに紐づく owner の記録のみを返す。
--    search_path を固定し、完全修飾名で参照（権限昇格対策）。
-- ---------------------------------------------------------------
create or replace function public.get_shared_view(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  link  public.share_links;
  recs  jsonb;
begin
  select * into link
  from public.share_links
  where token = p_token
    and revoked_at is null
    and (expires_at is null or expires_at > now());

  -- 無効・期限切れ・失効済みは valid=false のみ返す（情報を漏らさない）。
  if not found then
    return jsonb_build_object('valid', false);
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'record_date', record_date,
        'source',      source,
        'author',      author,
        'weight_kg',   weight_kg,
        'body',        body
      )
      order by record_date desc, created_at desc
    ),
    '[]'::jsonb
  )
  into recs
  from public.daycare_records
  where owner_id = link.owner_id
    and (link.from_date is null or record_date >= link.from_date)
    and (link.to_date   is null or record_date <= link.to_date);

  return jsonb_build_object(
    'valid',   true,
    'label',   link.label,
    'records', recs
  );
end;
$$;

-- 匿名 / ログイン済みのいずれからも実行可能にする（関数内で token を検証）。
revoke all on function public.get_shared_view(text) from public;
grant execute on function public.get_shared_view(text) to anon, authenticated;
