-- =============================================================
-- mfmf / Phase 3.5 S2 (Issue #46 / #38) — RBAC（owner / editor / viewer）の pgTAP 証明
--
-- 20260703170000_rbac_roles.sql の検証:
--   - role は 'owner' / 'editor' / 'viewer' のみ（CHECK 制約）
--   - viewer は閲覧のみ（UC-A01）: member 経路の write が一切通らない
--   - editor は他人の記録も編集・削除できる（UC-A02 / UC-A03, D5 / D11）
--   - viewer 自身のフィードバック送信は owner 経路で引き続き可（設計どおり）
--
-- 既知の移行期挙動（S2-PR2 の切替で閉じる・本テストの対象外）:
--   旧 owner_id ベースの write ポリシーが併存しているため、viewer も「自分名義の行」
--   だけは owner 経路で作成できる。viewer ロールの実利用は S3 招待の導入後であり、
--   その前に owner 経路 write の切替（drop）を行う。
-- =============================================================

begin;

create extension if not exists pgtap with schema extensions;

select plan(17);

-- fixture: HA に A(owner) / E(editor) / V(viewer)。record RA・tag TA・photo PH は A 作成。
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a@test.local'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'e@test.local'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'v@test.local');

insert into public.households (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'HA');

insert into public.household_members (household_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'editor'),
  ('11111111-1111-1111-1111-111111111111', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'viewer');

insert into public.daycare_records (id, owner_id, household_id, body) values
  ('aaaa0000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'A record');

insert into public.record_photos (id, record_id, household_id, storage_path) values
  ('aaaaffff-0000-0000-0000-000000000001', 'aaaa0000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-111111111111/aaaa0000-0000-0000-0000-000000000001/h.jpg');

insert into public.tags (id, owner_id, household_id, name) values
  ('aaaa7777-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'shared-a');

insert into storage.objects (bucket_id, name) values
  ('daycare-photos', '11111111-1111-1111-1111-111111111111/aaaa0000-0000-0000-0000-000000000001/h.jpg');

-- ---------------------------------------------------------------
-- role 制約
-- ---------------------------------------------------------------
select ok(
  exists (select 1 from pg_constraint
          where conname = 'household_members_role_check'
            and conrelid = 'public.household_members'::regclass),
  'household_members.role の CHECK 制約が存在する'
);
select throws_ok(
  $$insert into public.household_members (household_id, user_id, role)
    values ('11111111-1111-1111-1111-111111111111', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'member')$$,
  '23514',
  null,
  'role は owner / editor / viewer 以外を受け付けない（旧 member も不可）'
);

-- ---------------------------------------------------------------
-- viewer V: 閲覧のみ（UC-A01）
-- ---------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}', true);

select results_eq(
  $$select count(*)::int from public.daycare_records where id = 'aaaa0000-0000-0000-0000-000000000001'$$,
  $$values (1)$$,
  'viewer は世帯の記録を select 可'
);
select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'daycare-photos'
      and name = '11111111-1111-1111-1111-111111111111/aaaa0000-0000-0000-0000-000000000001/h.jpg'$$,
  $$values (1)$$,
  'viewer は世帯の Storage オブジェクトを select 可（署名付き URL の発行が可能）'
);
select results_eq(
  $$select count(*)::int from public.tags where id = 'aaaa7777-0000-0000-0000-000000000001'$$,
  $$values (1)$$,
  'viewer は世帯の共有タグを select 可'
);

select is_empty(
  $$update public.daycare_records set body = 'edited by viewer'
    where id = 'aaaa0000-0000-0000-0000-000000000001' returning 1$$,
  'viewer は他人の記録を update できない（no-op）'
);
select is_empty(
  $$delete from public.daycare_records
    where id = 'aaaa0000-0000-0000-0000-000000000001' returning 1$$,
  'viewer は記録を delete できない（no-op）'
);
select throws_ok(
  $$insert into public.daycare_records (owner_id, household_id, body)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'by viewer')$$,
  '42501',
  null,
  'viewer は世帯へ記録を insert できない（member 経路はロール不足）'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('daycare-photos', '11111111-1111-1111-1111-111111111111/aaaa0000-0000-0000-0000-000000000001/v.jpg')$$,
  '42501',
  null,
  'viewer は Storage へ insert できない'
);
select throws_ok(
  $$insert into public.record_tags (record_id, tag_id, owner_id)
    values ('aaaa0000-0000-0000-0000-000000000001',
            'aaaa7777-0000-0000-0000-000000000001',
            'dddddddd-dddd-dddd-dddd-dddddddddddd')$$,
  '42501',
  null,
  'viewer は記録へタグ付けできない'
);
select is_empty(
  $$delete from public.record_photos
    where id = 'aaaaffff-0000-0000-0000-000000000001' returning 1$$,
  'viewer は写真行を delete できない（no-op）'
);
select lives_ok(
  $$insert into public.feedback (owner_id, household_id, body)
    values ('dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111', 'viewer feedback')$$,
  'viewer も自分名義のフィードバックは送信できる（owner 経路・設計どおり）'
);

-- ---------------------------------------------------------------
-- editor E: 他人の記録も編集・削除できる（D5 / D11）
-- ---------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","role":"authenticated"}', true);

select lives_ok(
  $$insert into public.daycare_records (owner_id, household_id, body)
    values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111', 'by editor')$$,
  'editor は世帯へ記録を insert 可'
);
select isnt_empty(
  $$update public.daycare_records set body = 'edited by editor'
    where id = 'aaaa0000-0000-0000-0000-000000000001' returning 1$$,
  'editor は他人(owner A)の記録を update 可（D5）'
);
select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('daycare-photos', '11111111-1111-1111-1111-111111111111/aaaa0000-0000-0000-0000-000000000001/e.jpg')$$,
  'editor は Storage の新規約パスへ insert 可'
);
select isnt_empty(
  $$delete from public.record_photos
    where id = 'aaaaffff-0000-0000-0000-000000000001' returning 1$$,
  'editor は他人の記録の写真行を delete 可（D11）'
);
select isnt_empty(
  $$delete from public.daycare_records
    where id = 'aaaa0000-0000-0000-0000-000000000001' returning 1$$,
  'editor は他人の記録を delete 可（D11）'
);

reset role;
select * from finish();
rollback;
