-- =============================================================
-- mfmf / Phase 3.5 S4 (Issue #93 / #38) — 外部ゲスト（guest_grants）の pgTAP 証明
--
-- 20260705000000_guest_grants.sql の検証（D8 最厳格可視範囲）:
--   - ゲストに見えるのは担当ペットのプロフィール＋期間内の明示共有記録＋自分の記入のみ
--   - 期間外・失効（revoke）・他ペット・他世帯・写真は一切見えない（UC-G02/G04/G06）
--   - 書き込みは期間内・担当ペット・自分名義の追加のみ（UC-G03。更新/削除不可）
--   - 付与の管理は世帯 owner のみ（editor・ゲスト自身は不可 = 自己昇格不可 UC-G06）
--   - ゲストの記入は失効後も世帯に残る（UC-G07）/ ペット削除で付与は消える（UC-H11）
-- =============================================================

begin;

create extension if not exists pgtap with schema extensions;

select plan(28);

-- fixture: A = HA owner / E = HA editor / G = ゲスト / C = HB owner
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
  ('aaaa2222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'P2'),
  ('bbbb3333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   '22222222-2222-2222-2222-222222222222', 'P3');

-- g1 = 有効（今日を含む期間）/ g2 = 期限切れ（UC-G04）
insert into public.guest_grants
  (id, household_id, user_id, scope_pet_id, role, valid_from, valid_to, created_by) values
  ('77770000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '99999999-9999-9999-9999-999999999999', 'aaaa1111-1111-1111-1111-111111111111',
   'guest:daycare', current_date - 5, current_date + 5, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('77770000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   '99999999-9999-9999-9999-999999999999', 'aaaa2222-2222-2222-2222-222222222222',
   'guest:daycare', current_date - 10, current_date - 1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- r1 = 共有・期間内 / r2 = 非共有 / r3 = 共有だが期限切れ付与のペット /
-- r4 = 共有だが記録日が期間外 / r5 = 他世帯
insert into public.daycare_records
  (id, owner_id, household_id, pet_id, record_date, body, guest_visible) values
  ('11110000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'aaaa1111-1111-1111-1111-111111111111',
   current_date, 'r1 shared', true),
  ('11110000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'aaaa1111-1111-1111-1111-111111111111',
   current_date, 'r2 private', false),
  ('11110000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'aaaa2222-2222-2222-2222-222222222222',
   current_date, 'r3 shared but grant expired', true),
  ('11110000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'aaaa1111-1111-1111-1111-111111111111',
   current_date - 10, 'r4 shared but out of period', true),
  ('11110000-0000-0000-0000-000000000005', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   '22222222-2222-2222-2222-222222222222', 'bbbb3333-3333-3333-3333-333333333333',
   current_date, 'r5 other household', true);

-- 写真はゲスト対象外（D8。UC-S04 は未決）
insert into public.record_photos (id, record_id, household_id, storage_path) values
  ('1111ffff-0000-0000-0000-000000000001', '11110000-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-111111111111/11110000-0000-0000-0000-000000000001/a.jpg');

select is_definer('has_guest_access',
  'has_guest_access は SECURITY DEFINER（guest_grants のみ参照・再帰なし）');
select is_definer('has_guest_record_access',
  'has_guest_record_access は SECURITY DEFINER（期間 × 記録日の判定）');

-- ---------------------------------------------------------------
-- ゲスト G の可視範囲（D8 最厳格）
-- ---------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"99999999-9999-9999-9999-999999999999","email":"g@test.local","role":"authenticated"}', true);

select results_eq(
  $$select count(*)::int from public.pets$$, $$values (1)$$,
  'ゲストは担当ペット（有効な付与がある P1）だけが見える（UC-G02。期限切れ付与の P2・他世帯の P3 は不可視）');
select results_eq(
  $$select count(*)::int from public.households$$, $$values (0)$$,
  'ゲストは世帯メンバーではない（世帯情報・メンバー構成は不可視）');
select results_eq(
  $$select count(*)::int from public.daycare_records
    where id = '11110000-0000-0000-0000-000000000001'$$, $$values (1)$$,
  '期間内の明示共有記録（guest_visible）は見える（UC-G02）');
select results_eq(
  $$select count(*)::int from public.daycare_records
    where id = '11110000-0000-0000-0000-000000000002'$$, $$values (0)$$,
  '共有されていない記録は見えない（D8 既定 deny）');
select results_eq(
  $$select count(*)::int from public.daycare_records
    where id = '11110000-0000-0000-0000-000000000003'$$, $$values (0)$$,
  '期限切れの付与ではペットの共有記録も見えない（UC-G04 自動無効化）');
select results_eq(
  $$select count(*)::int from public.daycare_records
    where id = '11110000-0000-0000-0000-000000000004'$$, $$values (0)$$,
  '共有済みでも記録日が付与期間外なら見えない（D8: 預かり期間の記録のみ）');
select results_eq(
  $$select count(*)::int from public.daycare_records
    where id = '11110000-0000-0000-0000-000000000005'$$, $$values (0)$$,
  '他世帯の記録は見えない（クロステナント不可侵 UC-G06）');
select results_eq(
  $$select count(*)::int from public.record_photos$$, $$values (0)$$,
  '写真はゲスト共有の対象外（D8。UC-S04 は未決のため不可視）');

-- 書き込み（UC-G03: 期間内・担当ペット・自分名義の追加のみ）
select lives_ok(
  $$insert into public.daycare_records (id, owner_id, household_id, pet_id, body)
    values ('66660000-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999999',
            '11111111-1111-1111-1111-111111111111', 'aaaa1111-1111-1111-1111-111111111111',
            'guest note')$$,
  'ゲストは期間内に担当ペットの記録を追加できる（UC-G03）');
select results_eq(
  $$select count(*)::int from public.daycare_records
    where id = '66660000-0000-0000-0000-000000000001'$$, $$values (1)$$,
  '自分が書いた記録は共有フラグなしでも本人に見える');
select throws_ok(
  $$insert into public.daycare_records (id, owner_id, household_id, pet_id, body)
    values ('66660000-0000-0000-0000-000000000002', '99999999-9999-9999-9999-999999999999',
            '11111111-1111-1111-1111-111111111111', 'aaaa2222-2222-2222-2222-222222222222',
            'expired pet')$$,
  '42501', null,
  '期限切れの付与では記録を追加できない（UC-G04）');
select throws_ok(
  $$insert into public.daycare_records (id, owner_id, household_id, pet_id, record_date, body)
    values ('66660000-0000-0000-0000-000000000003', '99999999-9999-9999-9999-999999999999',
            '11111111-1111-1111-1111-111111111111', 'aaaa1111-1111-1111-1111-111111111111',
            current_date - 10, 'backdated')$$,
  '42501', null,
  '付与期間外の日付では記録を追加できない（D8）');
select throws_ok(
  $$insert into public.daycare_records (id, owner_id, household_id, pet_id, body, guest_visible)
    values ('66660000-0000-0000-0000-000000000004', '99999999-9999-9999-9999-999999999999',
            '11111111-1111-1111-1111-111111111111', 'aaaa1111-1111-1111-1111-111111111111',
            'self shared', true)$$,
  '42501', null,
  'ゲストは共有フラグ（guest_visible）を自分で立てられない（共有は世帯側の判断）');
select is_empty(
  $$update public.daycare_records set body = 'tampered'
    where id = '11110000-0000-0000-0000-000000000001' returning 1$$,
  'ゲストは世帯の記録を更新できない（追加のみ UC-G03）');
select is_empty(
  $$delete from public.daycare_records
    where id = '66660000-0000-0000-0000-000000000001' returning 1$$,
  'ゲストは自分の記録も削除できない（追加のみ UC-G03）');
select throws_ok(
  $$insert into public.guest_grants (household_id, user_id, scope_pet_id, role, created_by)
    values ('11111111-1111-1111-1111-111111111111', '99999999-9999-9999-9999-999999999999',
            'aaaa2222-2222-2222-2222-222222222222', 'guest:sitter',
            '99999999-9999-9999-9999-999999999999')$$,
  '42501', null,
  'ゲストは自分に付与を発行できない（自己昇格不可 UC-G06）');

-- ---------------------------------------------------------------
-- 付与の管理は owner のみ（editor 不可）
-- ---------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","email":"e@test.local","role":"authenticated"}', true);
select throws_ok(
  $$insert into public.guest_grants (household_id, user_id, scope_pet_id, role, created_by)
    values ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
            'aaaa1111-1111-1111-1111-111111111111', 'guest:sitter',
            'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')$$,
  '42501', null,
  'editor はゲスト付与を発行できない（owner のみ UC-G01）');
select results_eq(
  $$select count(*)::int from public.guest_grants$$, $$values (0)$$,
  'editor には世帯の付与一覧も見えない（owner とゲスト本人のみ）');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"a@test.local","role":"authenticated"}', true);
select results_eq(
  $$select count(*)::int from public.guest_grants$$, $$values (2)$$,
  'owner は自世帯の付与を一覧できる（UC-G01）');
select lives_ok(
  $$insert into public.guest_grants (id, household_id, user_id, scope_pet_id, role, created_by)
    values ('77770000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
            'cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaa2222-2222-2222-2222-222222222222',
            'guest:sitter', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  'owner はゲスト付与を発行できる（UC-G01）');
select throws_ok(
  $$insert into public.guest_grants (household_id, user_id, scope_pet_id, role, created_by)
    values ('11111111-1111-1111-1111-111111111111', '99999999-9999-9999-9999-999999999999',
            'bbbb3333-3333-3333-3333-333333333333', 'guest:sitter',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  '42501', null,
  '他世帯のペットを対象にした付与は発行できない（越境防止 UC-G06）');
select isnt_empty(
  $$update public.guest_grants set revoked_at = now()
    where id = '77770000-0000-0000-0000-000000000001' returning 1$$,
  'owner は付与を失効できる（UC-G04）');

-- ---------------------------------------------------------------
-- 失効後のゲスト（UC-G04）と記入の残置（UC-G07）
-- ---------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"99999999-9999-9999-9999-999999999999","email":"g@test.local","role":"authenticated"}', true);
select results_eq(
  $$select count(*)::int from public.daycare_records$$, $$values (0)$$,
  '失効後、ゲストは共有記録も自分の記入も見えない（UC-G04）');
select throws_ok(
  $$insert into public.daycare_records (id, owner_id, household_id, pet_id, body)
    values ('66660000-0000-0000-0000-000000000005', '99999999-9999-9999-9999-999999999999',
            '11111111-1111-1111-1111-111111111111', 'aaaa1111-1111-1111-1111-111111111111',
            'after revoke')$$,
  '42501', null,
  '失効後、ゲストは記録を追加できない（UC-G04）');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"a@test.local","role":"authenticated"}', true);
select results_eq(
  $$select count(*)::int from public.daycare_records
    where owner_id = '99999999-9999-9999-9999-999999999999'$$, $$values (1)$$,
  'ゲストの記入は失効後も世帯メンバーに見える（世帯に残置 UC-G07）');

-- ---------------------------------------------------------------
-- ペット削除で付与は消える（UC-H11 の決定 = CASCADE）
-- ---------------------------------------------------------------
reset role;
delete from public.pets where id = 'aaaa2222-2222-2222-2222-222222222222';
select results_eq(
  $$select count(*)::int from public.guest_grants
    where scope_pet_id = 'aaaa2222-2222-2222-2222-222222222222'$$, $$values (0)$$,
  'ペット削除で当該ペットへの付与は CASCADE で消える（UC-H11）');

select * from finish();
rollback;
