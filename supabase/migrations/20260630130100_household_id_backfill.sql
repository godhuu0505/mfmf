-- =============================================================
-- mfmf / Phase 3.5 S1 (Issue #92 / #43) — 業務テーブルへ household_id 追加 + バックフィル
--
-- 手順 2：業務テーブルへ household_id を nullable で追加（後方互換・無停止）。
-- 手順 3：既存ユーザー（owner_id の distinct）ごとに既定 household を作成し、
--         household_members に role='owner' で登録、所有行へ household_id を埋める。
--
-- 対象テーブルの選定根拠（init.sql 等のスキーマ実態に基づく）:
--   - daycare_records / feedback / pets … owner_id を直接持つ業務データ。
--     owner_id から既定 household を引いて household_id を埋める。
--   - record_photos … owner_id を持たず、親 daycare_records の RLS に従う子テーブル。
--     親レコードの household_id を「継承」してバックフィルする（親に追随）。
--   除外（本 PR では household_id を付けない）:
--     profiles / google_credentials … ユーザー個人のアカウント設定・認証情報で
--       世帯共有の対象ではない（1 ユーザー 1 行・auth.users 直結）。
--     tags / record_tags / share_links … 世帯共有の是非を含めメンバーシップ RLS の
--       再設計 (#44) と併せて判断するため、本スライスの対象外（owner_id のまま）。
--
-- 不変条件:
--   - household_id は nullable のまま（NOT NULL 化は後続 PR）。既存 owner_id RLS は不変更。
--   - FK on delete は既定（NO ACTION）。世帯削除は参照行があると弾かれ、孤児化を防ぐ。
--   - バックフィルは冪等（household_id is null の行と未登録メンバーシップのみ対象）。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   alter table public.record_photos   drop column if exists household_id;
--   alter table public.pets            drop column if exists household_id;
--   alter table public.feedback        drop column if exists household_id;
--   alter table public.daycare_records drop column if exists household_id;
--   （投入済みの households / household_members 行は 20260630130000 のロールバックで消す。）
-- =============================================================

-- ---------------------------------------------------------------
-- 1. household_id 列の追加（nullable）
-- ---------------------------------------------------------------
alter table public.daycare_records
  add column if not exists household_id uuid references public.households (id);
alter table public.record_photos
  add column if not exists household_id uuid references public.households (id);
alter table public.feedback
  add column if not exists household_id uuid references public.households (id);
alter table public.pets
  add column if not exists household_id uuid references public.households (id);

comment on column public.daycare_records.household_id is '所属世帯。移行期は nullable（NOT NULL 化は後続 PR）';
comment on column public.record_photos.household_id  is '所属世帯。親 daycare_records から継承';
comment on column public.feedback.household_id       is '所属世帯。移行期は nullable';
comment on column public.pets.household_id           is '所属世帯。移行期は nullable';

-- 世帯スコープでの絞り込みに備えた索引（将来の household ベース RLS 用）。
create index if not exists daycare_records_household_idx on public.daycare_records (household_id);
create index if not exists record_photos_household_idx  on public.record_photos  (household_id);
create index if not exists feedback_household_idx        on public.feedback        (household_id);
create index if not exists pets_household_idx            on public.pets            (household_id);

-- ---------------------------------------------------------------
-- 2. バックフィル
--    既存ユーザーごとに既定 household を 1 つ用意し、role='owner' で登録、
--    当該ユーザー所有の業務行へ household_id を埋める。
--
--    冪等性について:
--    - 通常運用では Supabase の migration ランナーが本ファイルを「一度だけ」適用
--      する（schema_migrations で追跡）。`supabase db reset` は空 DB に対して走る。
--    - それでも安全側に倒し、再実行されても重複 household を作らないよう以下を担保:
--      (a) トランザクション内アドバイザリロックでバックフィル全体を直列化し、
--          同一オーナーへの households 二重作成（PK が (household_id,user_id) のため
--          on conflict では防げない競合）を防ぐ。
--      (b) 既存メンバーシップがあれば household を再利用（role は owner を優先）。
--          並び順に決定的なタイブレークを入れ、再実行時の選択を安定させる。
-- ---------------------------------------------------------------
do $$
declare
  r  record;
  hh uuid;
begin
  -- バックフィル全体を直列化（並行/再試行実行での household 二重作成を防ぐ）。
  perform pg_advisory_xact_lock(20260630130100);

  -- owner_id を持つ全業務テーブルから distinct なオーナーを集める。
  for r in
    select distinct owner_id
    from (
      select owner_id from public.daycare_records
      union
      select owner_id from public.feedback
      union
      select owner_id from public.pets
    ) s
    where owner_id is not null
  loop
    -- 冪等: 既にメンバーである household があれば再利用（owner を優先）、無ければ新規作成。
    -- role を WHERE で固定せず ORDER BY で優先することで、将来 role が変化した
    -- ユーザーを再実行しても新たな重複 household を作らない。タイブレークは決定的。
    select m.household_id into hh
    from public.household_members m
    where m.user_id = r.owner_id
    order by (m.role = 'owner') desc, m.created_at, m.household_id
    limit 1;

    if hh is null then
      insert into public.households (name) values ('') returning id into hh;
      insert into public.household_members (household_id, user_id, role)
      values (hh, r.owner_id, 'owner')
      on conflict (household_id, user_id) do nothing;
    end if;

    update public.daycare_records
      set household_id = hh
      where owner_id = r.owner_id and household_id is null;
    update public.feedback
      set household_id = hh
      where owner_id = r.owner_id and household_id is null;
    update public.pets
      set household_id = hh
      where owner_id = r.owner_id and household_id is null;
  end loop;

  -- record_photos は owner_id を持たないため、親 daycare_records の household_id を
  -- 継承する（親は上のループで必ず埋まっている）。冪等（null の行のみ対象）。
  update public.record_photos p
    set household_id = dr.household_id
    from public.daycare_records dr
    where p.record_id = dr.id
      and p.household_id is null;
end $$;

-- 注: 本 PR ではアプリの書き込みを変更しないため、本 migration 適用後〜
-- household_id を埋めるアプリ改修（#44）までの間に作成される行は household_id が
-- NULL のまま残る（移行期は nullable なので許容）。後続の NOT NULL 化 PR は
-- 「同等のバックフィル（record_photos の親継承を含む）を再実行してから NOT NULL を
-- 課す」こと。本 PR 単体では既存データのみを対象とする（後方互換・無停止）。
