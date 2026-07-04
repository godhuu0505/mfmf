-- =============================================================
-- mfmf / Phase 3.5 S5 (Issue #47) — 世帯プロビジョニングの pgTAP 証明
--
-- 20260704120000_household_provisioning.sql の検証:
--   - create_own_household は未所属ユーザーのみ新世帯を作成でき、owner になる（D7 / UC-O03）
--   - 既に所属があるユーザー・二重実行は拒否（世帯の乱造防止。追加参加は招待受諾のみ）
--   - 未ログイン（anon）は実行できない
-- =============================================================

begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

-- fixture: A = HA の owner（所属あり）/ B = 未所属（新規登録者相当）
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a@test.local'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b@test.local');

insert into public.households (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'HA');

insert into public.household_members (household_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner');

select is_definer(
  'create_own_household',
  'create_own_household は SECURITY DEFINER（deny by default の households / household_members へ書ける唯一の新世帯作成経路）'
);

-- ---------------------------------------------------------------
-- 未所属 B は新世帯を作成して owner になる（UC-O03）
-- ---------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","email":"b@test.local","role":"authenticated"}', true);

select lives_ok(
  $$select public.create_own_household('  うちの世帯  ')$$,
  '未所属ユーザーは新世帯を作成できる（D7 / UC-O03）'
);
select results_eq(
  $$select h.name, m.role
    from public.household_members m
    join public.households h on h.id = m.household_id
    where m.user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'$$,
  $$values ('うちの世帯'::text, 'owner'::text)$$,
  '作成者は新世帯の owner になり、世帯名は trim されて保存される'
);
select throws_ok(
  $$select public.create_own_household('二つ目')$$,
  'P0001', null,
  '既に世帯を持つユーザーは重ねて作成できない（二重送信・乱造防止）'
);

-- ---------------------------------------------------------------
-- 所属ありの A も作成不可 / 未ログインは実行不可
-- ---------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"a@test.local","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_own_household('HA2')$$,
  'P0001', null,
  '既存世帯のメンバーは新世帯を作成できない（追加参加は招待受諾 UC-H07 のみ）'
);

reset role;
set local role anon;
select throws_ok(
  $$select public.create_own_household('anon')$$,
  '42501', null,
  '未ログイン（anon）は create_own_household を実行できない'
);

reset role;
select * from finish();
rollback;
