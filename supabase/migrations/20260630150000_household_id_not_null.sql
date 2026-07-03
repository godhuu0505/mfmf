-- =============================================================
-- mfmf / Phase 3.5 S1 (Issue #92 手順6 / #43) — household_id を NOT NULL 化（S1 仕上げ）
--
-- 手順 6：業務テーブル（daycare_records / record_photos / feedback / pets）の
--   household_id を NOT NULL 化し、S1 のテナント分離を確定する。これで移行期の
--   「household_id が NULL 可（＝どの世帯にも属さない業務行があり得る）」状態が閉じる。
--
-- 前提（本 migration の適用条件）:
--   - S1-PR1〜PR3 がマージ済み。特に PR3 でアプリが全書き込みに household_id を
--     必ずセットする（旧 owner_id 単独パスは撤去済み）。
--   - 手順3のバックフィル（20260630130100）で既存行の household_id は充足済み。
--   - よって通常は NULL 行は残っていない。ただし本番では「バックフィル適用〜PR3
--     デプロイ完了」の窓で旧コードが NULL のまま挿入した業務行が残り得る。SET NOT
--     NULL は 1 行でも NULL があると失敗して migration が止まる（＝本番デプロイが
--     途中で失敗する）ため、直前に (1) 冪等なセーフティネット・バックフィル、
--     (2) NULL 行ゼロの assert、を挟んでから NOT NULL 化する（段階適用）。
--
-- 破壊的変更である点（PR 説明にも明記）:
--   - SET NOT NULL は制約強化。既存 NULL 行があると失敗し、また列定義変更のため
--     main マージ = 本番 db push で即時に本番へ作用する。マージ前に本番にも
--     household_id IS NULL の業務行が無いことを確認すること（下の assert が本番で
--     成立する＝ NULL 行ゼロであることが前提）。
--
-- ロールバック手順（本 migration を取り消す場合／段階適用を戻す場合）:
--   alter table public.pets            alter column household_id drop not null;
--   alter table public.feedback        alter column household_id drop not null;
--   alter table public.record_photos   alter column household_id drop not null;
--   alter table public.daycare_records alter column household_id drop not null;
--   （NULL を許すだけの可逆操作。バックフィル済みデータには影響しない。）
--
-- 非対象（本スライスでは NOT NULL 化しない）:
--   profiles / google_credentials / tags / record_tags / share_links … 20260630130100
--   の選定に揃える（household_id 列自体を持たない or 世帯共有の是非を #44 後半で判断）。
--   Storage パスの household 化（手順8）は別 Issue とする（残課題）。
-- =============================================================

-- ---------------------------------------------------------------
-- 1. セーフティネット・バックフィル（冪等）
--    通常は対象 0 行（バックフィル + PR3 済み）。本番の移行窓で紛れ込み得る NULL 行を
--    NOT NULL 化の直前に補填する。ロジックは 20260630130100 のバックフィルと同型
--    （owner の既定 household を再利用／無ければ作成し、所有行へ埋める。record_photos
--    は親 daycare_records から継承）。household_id は「埋める」だけで、既存の非 NULL
--    値は書き換えない（冪等・後方互換）。
--
--    updated_at の保全: daycare_records / pets には set_updated_at トリガがあり、素の
--    UPDATE で updated_at が migration 時刻に汚れる。20260630130100 と同様、本バック
--    フィルの間だけ当該トリガを無効化する（同一トランザクション内なので失敗時は
--    ロールバックで復元）。feedback / record_photos に updated_at は無く対象外。
-- ---------------------------------------------------------------
alter table public.daycare_records disable trigger daycare_records_set_updated_at;
alter table public.pets            disable trigger pets_set_updated_at;

do $$
declare
  r  record;
  hh uuid;
begin
  -- バックフィル全体を直列化（20260630130100 と同じキー。並行/再試行での household
  -- 二重作成を防ぐ）。
  perform pg_advisory_xact_lock(20260630130100);

  for r in
    select distinct owner_id
    from (
      select owner_id from public.daycare_records where household_id is null
      union
      select owner_id from public.feedback        where household_id is null
      union
      select owner_id from public.pets            where household_id is null
    ) s
    where owner_id is not null
  loop
    -- 冪等: 既にメンバーである household があれば再利用（owner を優先）、無ければ新規作成。
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

  -- record_photos は owner_id を持たないため親 daycare_records の household_id を継承。
  update public.record_photos p
    set household_id = dr.household_id
    from public.daycare_records dr
    where p.record_id = dr.id
      and p.household_id is null;
end $$;

alter table public.daycare_records enable trigger daycare_records_set_updated_at;
alter table public.pets            enable trigger pets_set_updated_at;

-- ---------------------------------------------------------------
-- 2. NULL 行ゼロの assert（段階適用の安全弁）
--    セーフティネット後もなお NULL が残る場合（例: owner_id も NULL の孤児行、親を
--    欠く record_photos 等）は、NOT NULL 化を沈黙で失敗させず、原因を示して明示的に
--    停止する。これにより「本番で SET NOT NULL が謎の 23502 で落ちる」状況を、件数
--    付きの分かりやすいエラーへ変える。
-- ---------------------------------------------------------------
do $$
declare
  n_records  bigint;
  n_photos   bigint;
  n_feedback bigint;
  n_pets     bigint;
begin
  select count(*) into n_records  from public.daycare_records where household_id is null;
  select count(*) into n_photos   from public.record_photos  where household_id is null;
  select count(*) into n_feedback from public.feedback        where household_id is null;
  select count(*) into n_pets     from public.pets            where household_id is null;

  if (n_records + n_photos + n_feedback + n_pets) > 0 then
    raise exception
      'household_id NOT NULL 化の前提未達: NULL 行が残存 (daycare_records=%, record_photos=%, feedback=%, pets=%). セーフティネット・バックフィルで埋まらない孤児行（owner_id NULL 等）を調査・解消してから再実行すること。',
      n_records, n_photos, n_feedback, n_pets;
  end if;
end $$;

-- ---------------------------------------------------------------
-- 3. NOT NULL 化（S1 のテナント分離を確定）
--    ここまでで全業務行の household_id が非 NULL であることを保証済み。
-- ---------------------------------------------------------------
alter table public.daycare_records alter column household_id set not null;
alter table public.record_photos   alter column household_id set not null;
alter table public.feedback        alter column household_id set not null;
alter table public.pets            alter column household_id set not null;

comment on column public.daycare_records.household_id is '所属世帯（NOT NULL・S1 手順6で確定）';
comment on column public.record_photos.household_id  is '所属世帯（NOT NULL・親 daycare_records から継承）';
comment on column public.feedback.household_id       is '所属世帯（NOT NULL・S1 手順6で確定）';
comment on column public.pets.household_id           is '所属世帯（NOT NULL・S1 手順6で確定）';
