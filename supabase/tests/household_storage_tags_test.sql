-- =============================================================
-- mfmf / Phase 3.5 S1 (Issue #38 / #92 手順8, UC-M01 / UC-M02) —
--   Storage パス household 化と tags/record_tags 世帯共有の pgTAP 証明
--
-- 目的: 20260703120000（Storage 併存ポリシー）/ 20260703120100（tags 世帯共有）が
--   「世帯メンバーには開き、他 household には一切漏らさない」ことを継続的に証明する。
--   household_rls_test.sql（業務 4 表）と同じ流儀:
--     fixture は postgres（RLS 迂回）で投入し、検証だけ authenticated に降格する。
--
-- シナリオ:
--   ② owner 経由の既存アクセスは従来どおり可（own ポリシー不変の確認）
--   ① 別 household のユーザー(B)は A の Storage オブジェクト / タグに一切触れない
--   ③ メンバー追加(C を HA へ)で旧規約 {owner_id}/... と新規約 {household_id}/... の
--      両方・共有タグ辞書にアクセスできるようになる
--   ④ owner 経路で注入された「owner ⇄ household 不整合」タグは誰にも可視化されず、
--      record_tags にも持ち込めない（整合強制）
-- =============================================================

begin;

create extension if not exists pgtap with schema extensions;

select plan(40);

-- ---------------------------------------------------------------
-- 固定 UUID（fixture）
--   users:      A=aaaa.., B=bbbb.., C=cccc..
--   households: HA=1111.., HB=2222..
--   records:    RA=aaaa0000..1（A/HA）, RB=bbbb0000..2（B/HB）
--   tags:       TA=aaaa7777..1（A/HA 共有）, TB=bbbb7777..2（B/HB）,
--               TN=aaaa7777..3（A/household 未所属＝移行期）, TC=cccc7777..4（C が作成）,
--               TSQ=bbbb7777..5（B が owner 経路で HA に注入する不整合タグ）
--   storage:    legacy_a = {A}/{RA}/a.jpg（旧規約）, hh_a = {HA}/{RA}/h.jpg（新規約）
-- ---------------------------------------------------------------
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a@test.local'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b@test.local'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c@test.local');

insert into public.households (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'HA'),
  ('22222222-2222-2222-2222-222222222222', 'HB');

insert into public.household_members (household_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner');

insert into public.daycare_records (id, owner_id, household_id, body) values
  ('aaaa0000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'A record'),
  ('bbbb0000-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'B record');

-- Storage オブジェクト（bucket は init.sql が作成済みの daycare-photos）
insert into storage.objects (bucket_id, name) values
  ('daycare-photos', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/aaaa0000-0000-0000-0000-000000000001/a.jpg'),
  ('daycare-photos', '11111111-1111-1111-1111-111111111111/aaaa0000-0000-0000-0000-000000000001/h.jpg'),
  ('daycare-photos', 'not-a-uuid/whatever.jpg');

-- タグ辞書（TA=世帯共有 / TN=移行期の未所属 / TB=他世帯）と RA への付与
insert into public.tags (id, owner_id, household_id, name) values
  ('aaaa7777-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'shared-a'),
  ('bbbb7777-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'shared-b'),
  ('aaaa7777-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'legacy-a');

insert into public.record_tags (record_id, tag_id, owner_id) values
  ('aaaa0000-0000-0000-0000-000000000001', 'aaaa7777-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- ===============================================================
-- 不変条件ガード
-- ===============================================================
select is_definer(
  'shares_household_with',
  'shares_household_with は SECURITY DEFINER（household_members の RLS 迂回・boolean のみ返す）'
);

select ok(
  exists (select 1 from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'daycare_photos_select_own'),
  '既存 Storage own ポリシー daycare_photos_select_own が併存追加後も残存している'
);
select ok(
  exists (select 1 from pg_policies
          where schemaname = 'public' and tablename = 'tags'
            and policyname = 'tags_select_own'),
  '既存 owner_id ポリシー tags_select_own が残存している'
);
select ok(
  exists (select 1 from pg_policies
          where schemaname = 'public' and tablename = 'record_tags'
            and policyname = 'record_tags_select_own'),
  '既存 owner_id ポリシー record_tags_select_own が残存している'
);

select ok(
  public.try_cast_uuid('not-a-uuid') is null
    and public.try_cast_uuid('11111111-1111-1111-1111-111111111111')
        = '11111111-1111-1111-1111-111111111111'::uuid,
  'try_cast_uuid は不正値で null / 正常値で uuid を返す（エラーにしない）'
);

-- ===============================================================
-- シナリオ②: owner(A) は自分のデータへ従来どおり + 新規約でもアクセスできる
-- ===============================================================
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);

select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'daycare-photos'
      and name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/aaaa0000-0000-0000-0000-000000000001/a.jpg'$$,
  $$values (1)$$,
  'owner A は旧規約 {owner_id}/... の自分のオブジェクトを従来どおり select 可（own ポリシー）'
);
select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('daycare-photos', '11111111-1111-1111-1111-111111111111/aaaa0000-0000-0000-0000-000000000001/new-by-a.jpg')$$,
  'A は新規約 {household_id}/... へ insert 可（household insert ポリシー。own ポリシーでは不成立なパス）'
);
select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'daycare-photos'
      and name = '11111111-1111-1111-1111-111111111111/aaaa0000-0000-0000-0000-000000000001/h.jpg'$$,
  $$values (1)$$,
  'A は新規約 {household_id}/... のオブジェクトを select 可（household select ポリシー）'
);
select results_eq(
  $$select count(*)::int from public.tags where id = 'aaaa7777-0000-0000-0000-000000000003'$$,
  $$values (1)$$,
  'A は household 未所属の自分のタグを従来どおり select 可（own ポリシー不変）'
);

-- ===============================================================
-- シナリオ①: 別 household のユーザー B は A のオブジェクト / タグに一切触れない
-- ===============================================================
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}', true);

select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'daycare-photos'
      and name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/aaaa0000-0000-0000-0000-000000000001/a.jpg'$$,
  $$values (0)$$,
  'B は他 household(A) の旧規約オブジェクトを select 不可'
);
select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'daycare-photos'
      and name = '11111111-1111-1111-1111-111111111111/aaaa0000-0000-0000-0000-000000000001/h.jpg'$$,
  $$values (0)$$,
  'B は他 household(HA) の新規約オブジェクトを select 不可'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('daycare-photos', '11111111-1111-1111-1111-111111111111/bbbb0000-0000-0000-0000-000000000002/evil.jpg')$$,
  '42501',
  null,
  'B は非メンバーの household(HA) プレフィックスへ insert 不可'
);
select is_empty(
  $$delete from storage.objects
    where bucket_id = 'daycare-photos'
      and name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/aaaa0000-0000-0000-0000-000000000001/a.jpg'
    returning 1$$,
  'B は他 household(A) の旧規約オブジェクトを delete できない（no-op）'
);
select is_empty(
  $$delete from storage.objects
    where bucket_id = 'daycare-photos'
      and name = '11111111-1111-1111-1111-111111111111/aaaa0000-0000-0000-0000-000000000001/h.jpg'
    returning 1$$,
  'B は他 household(HA) の新規約オブジェクトを delete できない（no-op）'
);
select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('daycare-photos', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/bbbb0000-0000-0000-0000-000000000002/b2.jpg')$$,
  'B は旧規約 {自分の owner_id}/... へ従来どおり insert 可（own insert ポリシー不変・弱めない）'
);

select results_eq(
  $$select count(*)::int from public.tags where id = 'aaaa7777-0000-0000-0000-000000000001'$$,
  $$values (0)$$,
  'B は他 household(HA) の共有タグを select 不可'
);
select results_eq(
  $$select count(*)::int from public.tags where id = 'aaaa7777-0000-0000-0000-000000000003'$$,
  $$values (0)$$,
  'B は A の未所属タグを select 不可'
);
select results_eq(
  $$select count(*)::int from public.record_tags
    where record_id = 'aaaa0000-0000-0000-0000-000000000001'$$,
  $$values (0)$$,
  'B は他 household(HA) の record_tags を select 不可'
);
select throws_ok(
  $$insert into public.record_tags (record_id, tag_id, owner_id)
    values ('aaaa0000-0000-0000-0000-000000000001',
            'aaaa7777-0000-0000-0000-000000000001',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$,
  '42501',
  null,
  'B は他 household(HA) の記録へタグ付けできない'
);

-- 既知の未強制（シナリオ④前段）: B は owner 経路で「owner=B, household=HA」の不整合
-- タグを作成できてしまう（household_id は移行期クライアント書込み可能・20260630130100 注記）。
-- 後続テストでこの注入タグが誰にも可視化されず、record_tags にも持ち込めないことを証明する。
select lives_ok(
  $$insert into public.tags (id, owner_id, household_id, name)
    values ('bbbb7777-0000-0000-0000-000000000005',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            '11111111-1111-1111-1111-111111111111', 'squat')$$,
  'B は owner 経路で他 household の UUID を持つ自分のタグを作成できる（owner_id 経路は不変・未強制）'
);

-- ===============================================================
-- シナリオ③: C を HA に追加すると旧規約・新規約・共有タグ辞書にアクセスできる
-- ===============================================================
select set_config('request.jwt.claims',
  '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}', true);

select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'daycare-photos'
      and name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/aaaa0000-0000-0000-0000-000000000001/a.jpg'$$,
  $$values (0)$$,
  'メンバー追加前: C は A の旧規約オブジェクトを select 不可'
);
select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'daycare-photos'
      and name = '11111111-1111-1111-1111-111111111111/aaaa0000-0000-0000-0000-000000000001/h.jpg'$$,
  $$values (0)$$,
  'メンバー追加前: C は HA の新規約オブジェクトを select 不可'
);
select results_eq(
  $$select count(*)::int from public.tags where id = 'aaaa7777-0000-0000-0000-000000000001'$$,
  $$values (0)$$,
  'メンバー追加前: C は HA の共有タグを select 不可'
);

-- C を HA のメンバーに追加（postgres へ戻して RLS 迂回で投入）
reset role;
insert into public.household_members (household_id, user_id, role)
values ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}', true);

select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'daycare-photos'
      and name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/aaaa0000-0000-0000-0000-000000000001/a.jpg'$$,
  $$values (1)$$,
  'メンバー追加後: C は同世帯オーナー(A)の旧規約オブジェクトを select 可（shares_household_with）'
);
select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'daycare-photos'
      and name = '11111111-1111-1111-1111-111111111111/aaaa0000-0000-0000-0000-000000000001/h.jpg'$$,
  $$values (1)$$,
  'メンバー追加後: C は HA の新規約オブジェクトを select 可'
);
select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('daycare-photos', '11111111-1111-1111-1111-111111111111/aaaa0000-0000-0000-0000-000000000001/by-c.jpg')$$,
  'メンバー追加後: C は新規約 {household_id}/... へ insert 可'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('daycare-photos', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/aaaa0000-0000-0000-0000-000000000001/c2.jpg')$$,
  '42501',
  null,
  'C は他人(A)の owner プレフィックス配下へは insert 不可（旧規約への新規作成は本人のみ）'
);

select results_eq(
  $$select count(*)::int from public.tags where id = 'aaaa7777-0000-0000-0000-000000000001'$$,
  $$values (1)$$,
  'メンバー追加後: C は HA の共有タグを select 可'
);
select results_eq(
  $$select count(*)::int from public.tags where id = 'aaaa7777-0000-0000-0000-000000000003'$$,
  $$values (0)$$,
  'household 未所属のタグは共有されない（作成者本人のみ・個人スコープ維持）'
);
select results_eq(
  $$select count(*)::int from public.tags where id = 'bbbb7777-0000-0000-0000-000000000002'$$,
  $$values (0)$$,
  'C は非メンバーの HB のタグは select 不可'
);
select lives_ok(
  $$insert into public.tags (id, owner_id, household_id, name)
    values ('cccc7777-0000-0000-0000-000000000004',
            'cccccccc-cccc-cccc-cccc-cccccccccccc',
            '11111111-1111-1111-1111-111111111111', 'by-c')$$,
  'C は HA の共有辞書へタグを追加できる'
);
select isnt_empty(
  $$update public.tags set name = 'shared-a-renamed'
    where id = 'aaaa7777-0000-0000-0000-000000000001' returning 1$$,
  'C は共有タグ（他メンバー作成）を rename できる（tags_update_member）'
);

select results_eq(
  $$select count(*)::int from public.record_tags
    where record_id = 'aaaa0000-0000-0000-0000-000000000001'
      and tag_id = 'aaaa7777-0000-0000-0000-000000000001'$$,
  $$values (1)$$,
  'メンバー追加後: C は HA の record_tags を select 可'
);
select lives_ok(
  $$insert into public.record_tags (record_id, tag_id, owner_id)
    values ('aaaa0000-0000-0000-0000-000000000001',
            'cccc7777-0000-0000-0000-000000000004',
            'cccccccc-cccc-cccc-cccc-cccccccccccc')$$,
  'C は同世帯の記録へ共有辞書のタグを付与できる（record_tags_insert_member）'
);
select throws_ok(
  $$insert into public.record_tags (record_id, tag_id, owner_id)
    values ('aaaa0000-0000-0000-0000-000000000001',
            'aaaa7777-0000-0000-0000-000000000003',
            'cccccccc-cccc-cccc-cccc-cccccccccccc')$$,
  '42501',
  null,
  'household 未所属のタグは他メンバーの記録へ持ち込めない（t.household_id = r.household_id を要求）'
);
select throws_ok(
  $$insert into public.record_tags (record_id, tag_id, owner_id)
    values ('aaaa0000-0000-0000-0000-000000000001',
            'bbbb7777-0000-0000-0000-000000000005',
            'cccccccc-cccc-cccc-cccc-cccccccccccc')$$,
  '42501',
  null,
  '注入された不整合タグ（owner ∉ household）は record_tags へ持ち込めない（整合強制）'
);
select isnt_empty(
  $$delete from public.record_tags
    where record_id = 'aaaa0000-0000-0000-0000-000000000001'
      and tag_id = 'aaaa7777-0000-0000-0000-000000000001'
    returning 1$$,
  'C は同世帯のタグ付与を削除できる（record_tags_delete_member）'
);
select isnt_empty(
  $$delete from storage.objects
    where bucket_id = 'daycare-photos'
      and name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/aaaa0000-0000-0000-0000-000000000001/a.jpg'
    returning 1$$,
  'C は同世帯オーナー(A)の旧規約オブジェクトを delete 可（記録削除時の片付け）'
);
select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'daycare-photos' and name = 'not-a-uuid/whatever.jpg'$$,
  $$values (0)$$,
  '先頭セグメントが uuid でないパスはエラーにならず単に不可視（try_cast_uuid ガード）'
);

-- ===============================================================
-- シナリオ④: 注入された不整合タグは世帯メンバーにも可視化されない（整合強制）
-- ===============================================================
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select results_eq(
  $$select count(*)::int from public.tags where id = 'bbbb7777-0000-0000-0000-000000000005'$$,
  $$values (0)$$,
  'HA メンバー(A)にも B の注入タグは見えない（is_household_member による owner ⇄ household 整合の強制）'
);

reset role;
select * from finish();
rollback;
