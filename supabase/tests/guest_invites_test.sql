-- =============================================================
-- mfmf / Phase 3.5 S4 (Issue #93) — ゲスト招待（S3 招待基盤の流用）の pgTAP 証明
--
-- 20260705010000_guest_invites.sql の検証:
--   - owner はゲスト招待（role guest:* + 対象ペット + 期間）を発行できる（UC-G01）
--   - 他世帯のペットを対象にした招待・ペットなしのゲスト招待は発行できない
--   - 受諾でメンバーではなく guest_grants が作られる（世帯情報は見えないまま）
--   - 冪等リトライ / 既存メンバーによるゲスト受諾の拒否
--   - get_household_guests は owner 限定でゲストのメールを解決する
-- =============================================================

begin;

create extension if not exists pgtap with schema extensions;

select plan(10);

-- fixture: A = HA owner / E = HA editor / G = ゲスト被招待者（未所属）/ C = HB owner
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a@test.local'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'e@test.local'),
  ('99999999-9999-9999-9999-999999999999', 'g@test.local'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c@test.local');

insert into public.households (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'HA'),
  ('22222222-2222-2222-2222-222222222222', 'HB');

insert into public.household_members (household_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'editor'),
  ('22222222-2222-2222-2222-222222222222', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'owner');

insert into public.pets (id, owner_id, household_id, name) values
  ('aaaa1111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'P1'),
  ('bbbb3333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   '22222222-2222-2222-2222-222222222222', 'P3');

insert into public.household_invites
  (household_id, email, role, token, invited_by, expires_at, scope_pet_id, valid_from, valid_to) values
  ('11111111-1111-1111-1111-111111111111', 'g@test.local', 'guest:daycare', 'gtok-valid',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() + interval '7 days',
   'aaaa1111-1111-1111-1111-111111111111', current_date, current_date + 14),
  ('11111111-1111-1111-1111-111111111111', 'a@test.local', 'guest:daycare', 'gtok-for-a',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() + interval '7 days',
   'aaaa1111-1111-1111-1111-111111111111', current_date, current_date + 14);

-- ---------------------------------------------------------------
-- owner A の発行（UC-G01）
-- ---------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"a@test.local","role":"authenticated"}', true);

select lives_ok(
  $$insert into public.household_invites
      (household_id, email, role, token, invited_by, expires_at, scope_pet_id, valid_from, valid_to)
    values ('11111111-1111-1111-1111-111111111111', 'sitter@test.local', 'guest:sitter',
            'gtok-by-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() + interval '7 days',
            'aaaa1111-1111-1111-1111-111111111111', current_date, current_date + 7)$$,
  'owner はゲスト招待（対象ペット + 期間つき）を発行できる（UC-G01）');
select throws_ok(
  $$insert into public.household_invites
      (household_id, email, role, token, invited_by, expires_at, scope_pet_id)
    values ('11111111-1111-1111-1111-111111111111', 'x@test.local', 'guest:sitter',
            'gtok-cross', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() + interval '7 days',
            'bbbb3333-3333-3333-3333-333333333333')$$,
  '42501', null,
  '他世帯のペットを対象にしたゲスト招待は発行できない（越境防止 UC-G06）');
select throws_ok(
  $$insert into public.household_invites
      (household_id, email, role, token, invited_by, expires_at)
    values ('11111111-1111-1111-1111-111111111111', 'x@test.local', 'guest:sitter',
            'gtok-nopet', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() + interval '7 days')$$,
  '23514', null,
  '対象ペットのないゲスト招待は発行できない（household_invites_guest_scope）');

-- ---------------------------------------------------------------
-- ゲスト G の受諾: メンバー化ではなく guest_grants が作られる
-- ---------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"99999999-9999-9999-9999-999999999999","email":"g@test.local","role":"authenticated"}', true);

select lives_ok(
  $$select public.accept_household_invite('gtok-valid')$$,
  'ゲスト招待を受諾できる（宛先メール一致 D12/D13 は内部招待と同一検証）');
select results_eq(
  $$select count(*)::int from public.guest_grants
    where user_id = '99999999-9999-9999-9999-999999999999'
      and scope_pet_id = 'aaaa1111-1111-1111-1111-111111111111'
      and role = 'guest:daycare'
      and valid_to = current_date + 14
      and revoked_at is null$$,
  $$values (1)$$,
  '受諾で招待どおりの対象ペット・期間の guest_grants が作られる');
select results_eq(
  $$select count(*)::int from public.household_members
    where user_id = '99999999-9999-9999-9999-999999999999'$$,
  $$values (0)$$,
  'ゲストは household_members には追加されない（世帯情報は見えないまま UC-G02）');
select lives_ok(
  $$select public.accept_household_invite('gtok-valid')$$,
  '本人による受諾済みゲスト招待の再試行は冪等に成功する');

-- 既にメンバーのユーザーはゲスト招待を受諾できない（メンバーの方が広い権限）
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"a@test.local","role":"authenticated"}', true);
select throws_ok(
  $$select public.accept_household_invite('gtok-for-a')$$,
  'P0001', null,
  '世帯メンバーはゲスト招待を受諾できない（二重の権限系統を作らない）');

-- ---------------------------------------------------------------
-- get_household_guests（owner 限定・メール解決）
-- ---------------------------------------------------------------
select results_eq(
  $$select count(*)::int from public.get_household_guests('11111111-1111-1111-1111-111111111111')
    where email = 'g@test.local'$$,
  $$values (1)$$,
  'owner は get_household_guests でゲストのメールを解決できる');
select set_config('request.jwt.claims',
  '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","email":"e@test.local","role":"authenticated"}', true);
select throws_ok(
  $$select * from public.get_household_guests('11111111-1111-1111-1111-111111111111')$$,
  '42501', null,
  'editor は get_household_guests を呼べない（ゲスト管理は owner のみ UC-G01）');

reset role;
select * from finish();
rollback;
