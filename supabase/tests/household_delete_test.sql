-- =============================================================
-- mfmf / Phase 3.5 フォローアップ (Issue #117 §3) — 世帯削除（UC-H09）の pgTAP 証明
--
-- 20260705040000_household_delete.sql の検証:
--   - delete_own_household は owner だけが呼べる（非 owner は 42501）
--   - 参照データのある世帯は削除できない（P0001。#51 で対応予定）
--   - owner は参照データの無い世帯を削除でき、メンバー行も cascade で消える
--   - D6（最後の owner 保護）は世帯ごと削除に限って素通りするだけで、通常のメンバー
--     退出/削除では従来どおり最後の owner を守る（ガードが抜け道にならない）
-- =============================================================

begin;

create extension if not exists pgtap with schema extensions;

select plan(7);

-- fixture（postgres ロール = RLS 迂回で投入）:
--   HE = 空の世帯（owner AE / editor ED）, HD = 記録のある世帯（owner AD）, OT = 部外者
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ae@test.local'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'ed@test.local'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'ad@test.local'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'ot@test.local');

insert into public.households (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'HE'),
  ('22222222-2222-2222-2222-222222222222', 'HD');

insert into public.household_members (household_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'editor'),
  ('22222222-2222-2222-2222-222222222222', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'owner');

-- HD には記録が 1 件ある（= 参照データありの世帯）。HE は空のまま。
insert into public.daycare_records (id, owner_id, household_id, body) values
  ('22220000-0000-0000-0000-000000000001', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
   '22222222-2222-2222-2222-222222222222', 'HD record');

-- ---------------------------------------------------------------
-- 非 owner は削除できない（42501）
-- ---------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","role":"authenticated"}', true);
select throws_ok(
  $$select public.delete_own_household('11111111-1111-1111-1111-111111111111')$$,
  '42501',
  null,
  'editor（非 owner）は世帯を削除できない'
);

select set_config('request.jwt.claims',
  '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}', true);
select throws_ok(
  $$select public.delete_own_household('11111111-1111-1111-1111-111111111111')$$,
  '42501',
  null,
  '部外者は他人の世帯を削除できない'
);

-- ---------------------------------------------------------------
-- 参照データのある世帯は削除できない（P0001）
-- ---------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}', true);
select throws_ok(
  $$select public.delete_own_household('22222222-2222-2222-2222-222222222222')$$,
  'P0001',
  null,
  'owner でも記録のある世帯は削除できない（#51 で対応）'
);

-- ---------------------------------------------------------------
-- owner は空の世帯を削除できる（メンバー行も cascade で消える）
-- ---------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select lives_ok(
  $$select public.delete_own_household('11111111-1111-1111-1111-111111111111')$$,
  'owner は参照データの無い世帯を削除できる（D6 ガードで最後の owner 保護を素通り）'
);

reset role;
select results_eq(
  $$select count(*)::int from public.households
    where id = '11111111-1111-1111-1111-111111111111'$$,
  $$values (0)$$,
  '削除後、世帯 HE は存在しない'
);
select results_eq(
  $$select count(*)::int from public.household_members
    where household_id = '11111111-1111-1111-1111-111111111111'$$,
  $$values (0)$$,
  '削除後、HE のメンバー行は cascade で消えている'
);

-- ---------------------------------------------------------------
-- D6 は通常のメンバー削除では従来どおり最後の owner を守る（ガードは抜け道でない）
-- ---------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}', true);
select throws_ok(
  $$delete from public.household_members
    where household_id = '22222222-2222-2222-2222-222222222222'
      and user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'$$,
  'P0001',
  null,
  '世帯ごと削除以外の通常のメンバー削除では、最後の owner は退出できない（D6 維持）'
);

reset role;

select * from finish();
rollback;
