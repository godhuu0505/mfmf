-- =============================================================
-- mfmf / Phase 3.5 S2 (Issue #46 / #38) — RBAC（owner / editor / viewer）の pgTAP 証明
--
-- 20260703170000_rbac_roles.sql / 20260704000000_rbac_switch_and_management.sql の検証:
--   - role は 'owner' / 'editor' / 'viewer' のみ（CHECK 制約）
--   - viewer は閲覧のみ（UC-A01）: member 経路の write も owner 経路（S2 切替で drop 済み）
--     も一切通らない
--   - editor は他人の記録も編集・削除できる（UC-A02 / UC-A03, D5 / D11）
--   - viewer 自身のフィードバック送信は owner 経路で引き続き可（設計どおり）
--   - メンバー一覧は世帯内で共有（UC-H03）、role 変更・メンバー削除は owner のみ
--     （UC-H04/H05）、本人退出は可（UC-H06）、最後の owner は降格・削除・退出不可（D6）
-- =============================================================

begin;

create extension if not exists pgtap with schema extensions;

select plan(35);

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
-- S2 切替（owner 経路 write の drop）により、viewer は「自分名義の行」も作成できない
select throws_ok(
  $$insert into public.daycare_records (owner_id, household_id, body)
    values ('dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111', 'own by viewer')$$,
  '42501',
  null,
  'viewer は自分名義の記録も insert できない（S2 切替で owner 経路が閉鎖）'
);
select throws_ok(
  $$insert into public.tags (owner_id, household_id, name)
    values ('dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111', 'by-viewer')$$,
  '42501',
  null,
  'viewer は自分名義のタグも insert できない（同上）'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('daycare-photos', 'dddddddd-dddd-dddd-dddd-dddddddddddd/aaaa0000-0000-0000-0000-000000000001/own.jpg')$$,
  '42501',
  null,
  'viewer は旧規約 {自分の owner_id}/... へもアップロードできない（同上）'
);
select results_eq(
  $$select count(*)::int from public.household_members
    where household_id = '11111111-1111-1111-1111-111111111111'$$,
  $$values (3)$$,
  'viewer も世帯のメンバー一覧（role 含む）を参照できる（UC-H03）'
);
select lives_ok(
  $$insert into public.feedback (owner_id, household_id, body)
    values ('dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111', 'viewer feedback')$$,
  'viewer も自分名義のフィードバックは送信できる（owner 経路・設計どおり）'
);
select throws_ok(
  $$insert into public.share_links (owner_id, token)
    values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'token-by-viewer')$$,
  '42501',
  null,
  'viewer は匿名共有リンクを新規発行できない（share_links_insert_own の editor+ 限定）'
);

-- ---------------------------------------------------------------
-- editor E: 他人の記録も編集・削除できる（D5 / D11）
-- ---------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","role":"authenticated"}', true);

select lives_ok(
  $$insert into public.daycare_records (id, owner_id, household_id, body)
    values ('eeee0000-0000-0000-0000-000000000001',
            'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111', 'by editor')$$,
  'editor は世帯へ記録を insert 可'
);
select lives_ok(
  $$insert into public.share_links (owner_id, household_id, token)
    values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
            '11111111-1111-1111-1111-111111111111', 'token-by-editor')$$,
  'editor は自分が editor+ の世帯を指定して共有リンクを発行できる'
);
select throws_ok(
  $$insert into public.share_links (owner_id, token)
    values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'token-no-household')$$,
  '42501',
  null,
  '世帯未指定（household_id null）の共有リンクは作成できない（移行期分岐による全世帯露出の防止）'
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

-- ---------------------------------------------------------------
-- 世帯管理: role 変更/メンバー削除は owner のみ・D6（最後の owner 保護）
-- ---------------------------------------------------------------
-- editor E は他メンバーの role を変更できない（update は owner のみ → no-op）
select is_empty(
  $$update public.household_members set role = 'editor'
    where household_id = '11111111-1111-1111-1111-111111111111'
      and user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd' returning 1$$,
  'editor はメンバーの role を変更できない（owner のみ・no-op）'
);
-- editor E は世帯名を変更できない（update は owner のみ → no-op）
select is_empty(
  $$update public.households set name = 'renamed by editor'
    where id = '11111111-1111-1111-1111-111111111111' returning 1$$,
  'editor は世帯名を変更できない（owner のみ・no-op）'
);

-- owner A で検証
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);

select isnt_empty(
  $$update public.household_members set role = 'editor'
    where household_id = '11111111-1111-1111-1111-111111111111'
      and user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd' returning 1$$,
  'owner はメンバー(V)の role を変更できる（UC-H04: viewer → editor）'
);
select throws_ok(
  $$update public.household_members set role = 'editor'
    where household_id = '11111111-1111-1111-1111-111111111111'
      and user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  'P0001',
  null,
  '最後の owner は自分を降格できない（D6）'
);
select throws_ok(
  $$delete from public.household_members
    where household_id = '11111111-1111-1111-1111-111111111111'
      and user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  'P0001',
  null,
  '最後の owner は退出・削除できない（D6。S3 で delete 解禁後もトリガが保護）'
);
select throws_ok(
  $$update public.household_members set user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    where household_id = '11111111-1111-1111-1111-111111111111'
      and user_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'$$,
  'P0001',
  null,
  'membership の user_id / household_id は付け替え不可（owner 数の抜け道防止）'
);
select isnt_empty(
  $$update public.households set name = 'renamed by owner'
    where id = '11111111-1111-1111-1111-111111111111' returning 1$$,
  'owner は世帯名を変更できる（UC-H02）'
);

-- 本人退出（UC-H06）と UC-H10（退出者の記録は世帯に残る・本人は不可視になる）
select set_config('request.jwt.claims',
  '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","role":"authenticated"}', true);
select isnt_empty(
  $$delete from public.household_members
    where household_id = '11111111-1111-1111-1111-111111111111'
      and user_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' returning 1$$,
  'メンバー本人は世帯から退出できる（UC-H06。最後の owner ではないので D6 に触れない）'
);
select results_eq(
  $$select count(*)::int from public.daycare_records
    where id = 'eeee0000-0000-0000-0000-000000000001'$$,
  $$values (0)$$,
  '退出した本人は自分が書いた世帯の記録も見えない（own select 撤去 = UC-H05/H06 の遮断）'
);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select results_eq(
  $$select count(*)::int from public.daycare_records
    where id = 'eeee0000-0000-0000-0000-000000000001'$$,
  $$values (1)$$,
  '退出メンバーが作った記録は世帯に残り、残ったメンバーから見える（UC-H10）'
);

reset role;

-- 退出した発行者（E）の共有リンクは自動的に無効になる（get_shared_view が
-- 「発行者がリンクの世帯のメンバーであること」を要求するため）。
select ok(
  (public.get_shared_view('token-by-editor') ->> 'valid') = 'false',
  '発行者が世帯を退出すると、その共有リンクは無効になる（UC-H05/H06 のリンク残置防止）'
);

select * from finish();
rollback;
