-- =============================================================
-- mfmf / アバター画像（20260706120000_avatars.sql）の Storage RLS pgTAP 証明
--
-- 目的: private バケット avatars のパス規約 {scope_id}/avatars/{uuid}-{filename} が
--   「先頭セグメント（scope_id）= 自分の uid または自分がメンバーの household」の
--   ときだけ select / insert / delete を許し、他人 uid・非メンバー世帯のスコープには
--   一切開かないことを継続的に証明する。
--   household_storage_tags_test.sql と同じ流儀:
--     fixture は postgres（RLS 迂回）で投入し、検証だけ authenticated に降格する。
--
-- シナリオ:
--   ② 本人(A)は「自分の uid スコープ」と「自世帯(HA)スコープ」の両方に
--      select / insert / delete でき、他人(B)の uid・非メンバー世帯(HB)には触れない。
--      判定は先頭セグメントのみで行われるため、2 セグメント目以降に自分の uid を
--      置いても権限は生まれない（パス規約の 2 セグメント目までを敵対的に検証）。
--   ① 別世帯のユーザー(B)は対称に、自分のスコープしか触れない。
--   ③ メンバー追加(C を HA へ)で世帯スコープが開く。ただしユーザーアバター
--      （uid スコープ）は個人のままで、同世帯メンバーにも開かない。
-- =============================================================

begin;

create extension if not exists pgtap with schema extensions;

select plan(28);

-- ---------------------------------------------------------------
-- 固定 UUID（fixture）
--   users:      A=aaaa.., B=bbbb.., C=cccc..
--   households: HA=1111..（A owner）, HB=2222..（B owner）
--   storage:    a_user = {A}/avatars/..-a.jpg（A のユーザーアバター）
--               b_user = {B}/avatars/..-b.jpg（B のユーザーアバター）
--               ha_av  = {HA}/avatars/..-ha.jpg（HA の世帯/ペットアバター）
--               hb_av  = {HB}/avatars/..-hb.jpg（HB の世帯/ペットアバター）
--               bad    = not-a-uuid/avatars/x.jpg（先頭が uuid でないパス）
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

insert into storage.objects (bucket_id, name) values
  ('avatars', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/avatars/00000000-0000-0000-0000-00000000000a-a.jpg'),
  ('avatars', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/avatars/00000000-0000-0000-0000-00000000000b-b.jpg'),
  ('avatars', '11111111-1111-1111-1111-111111111111/avatars/00000000-0000-0000-0000-0000000000a1-ha.jpg'),
  ('avatars', '22222222-2222-2222-2222-222222222222/avatars/00000000-0000-0000-0000-0000000000b2-hb.jpg'),
  ('avatars', 'not-a-uuid/avatars/x.jpg');

-- storage の protect_objects_delete トリガ（文レベル・0 行でも発火）は SQL 直接 DELETE を
-- 一律拒否する運用ガードで、RLS とは無関係。検証対象は delete ポリシーなので
-- トランザクション限定（is_local=true、rollback で消える）で解除する。
-- 実体を持たないテスト行のみが対象のため孤児化の懸念もない
-- （household_storage_tags_test.sql と同じ扱い）。
select set_config('storage.allow_delete_query', 'true', true);

-- ===============================================================
-- 不変条件ガード
-- ===============================================================
select results_eq(
  $$select public from storage.buckets where id = 'avatars'$$,
  $$values (false)$$,
  'avatars バケットは private（配信は署名付き URL のみ、の前提）'
);

select has_column('public', 'pets', 'avatar_path', 'pets.avatar_path 列が存在する');
select has_column('public', 'households', 'avatar_path', 'households.avatar_path 列が存在する');
select has_column('public', 'profiles', 'avatar_path', 'profiles.avatar_path 列が存在する');

select ok(
  exists (select 1 from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'avatars_select_scope'),
  'avatars_select_scope ポリシーが存在する'
);
select ok(
  exists (select 1 from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'avatars_insert_scope'),
  'avatars_insert_scope ポリシーが存在する'
);
select ok(
  exists (select 1 from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'avatars_delete_scope'),
  'avatars_delete_scope ポリシーが存在する'
);

-- ===============================================================
-- シナリオ②: 本人(A)は自分の uid スコープと自世帯(HA)スコープだけに触れる
-- ===============================================================
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);

select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'avatars'
      and name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/avatars/00000000-0000-0000-0000-00000000000a-a.jpg'$$,
  $$values (1)$$,
  'A は自分の uid スコープのアバターを select 可（署名付き URL 発行の前提）'
);
select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'avatars'
      and name = '11111111-1111-1111-1111-111111111111/avatars/00000000-0000-0000-0000-0000000000a1-ha.jpg'$$,
  $$values (1)$$,
  'A は自世帯(HA)スコープのアバターを select 可'
);
select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'avatars'
      and name = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/avatars/00000000-0000-0000-0000-00000000000b-b.jpg'$$,
  $$values (0)$$,
  'A は他人(B)の uid スコープのアバターを select 不可'
);
select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'avatars'
      and name = '22222222-2222-2222-2222-222222222222/avatars/00000000-0000-0000-0000-0000000000b2-hb.jpg'$$,
  $$values (0)$$,
  'A は非メンバー世帯(HB)スコープのアバターを select 不可'
);

select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('avatars', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/avatars/00000000-0000-0000-0000-0000000000c1-new-a.jpg')$$,
  'A は自分の uid スコープへ insert 可（ユーザーアバターのアップロード）'
);
select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('avatars', '11111111-1111-1111-1111-111111111111/avatars/00000000-0000-0000-0000-0000000000c2-new-ha.jpg')$$,
  'A は自世帯(HA)スコープへ insert 可（ペット/世帯アバターのアップロード）'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('avatars', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/avatars/00000000-0000-0000-0000-0000000000c3-evil.jpg')$$,
  '42501',
  null,
  'A は他人(B)の uid スコープへ insert 不可'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('avatars', '22222222-2222-2222-2222-222222222222/avatars/00000000-0000-0000-0000-0000000000c4-evil.jpg')$$,
  '42501',
  null,
  'A は非メンバー世帯(HB)スコープへ insert 不可'
);
-- パス規約の 2 セグメント目までの敵対的検証: 判定は先頭セグメントのみで行われるため、
-- 2 セグメント目に自分の uid を置いても非メンバー世帯(HB)スコープは開かない。
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('avatars', '22222222-2222-2222-2222-222222222222/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/evil.jpg')$$,
  '42501',
  null,
  'A は 2 セグメント目に自分の uid を置いても HB スコープへ insert 不可（判定は先頭 scope_id のみ）'
);

select isnt_empty(
  $$delete from storage.objects
    where bucket_id = 'avatars'
      and name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/avatars/00000000-0000-0000-0000-0000000000c1-new-a.jpg'
    returning 1$$,
  'A は自分の uid スコープのアバターを delete 可（差し替え時の旧オブジェクト片付け）'
);
select isnt_empty(
  $$delete from storage.objects
    where bucket_id = 'avatars'
      and name = '11111111-1111-1111-1111-111111111111/avatars/00000000-0000-0000-0000-0000000000c2-new-ha.jpg'
    returning 1$$,
  'A は自世帯(HA)スコープのアバターを delete 可'
);
select is_empty(
  $$delete from storage.objects
    where bucket_id = 'avatars'
      and name = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/avatars/00000000-0000-0000-0000-00000000000b-b.jpg'
    returning 1$$,
  'A は他人(B)の uid スコープのアバターを delete できない（no-op）'
);
select is_empty(
  $$delete from storage.objects
    where bucket_id = 'avatars'
      and name = '22222222-2222-2222-2222-222222222222/avatars/00000000-0000-0000-0000-0000000000b2-hb.jpg'
    returning 1$$,
  'A は非メンバー世帯(HB)スコープのアバターを delete できない（no-op）'
);
select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'avatars' and name = 'not-a-uuid/avatars/x.jpg'$$,
  $$values (0)$$,
  '先頭セグメントが uuid でないパスはエラーにならず単に不可視（try_cast_uuid ガード）'
);

-- ===============================================================
-- シナリオ③: メンバー追加(C を HA へ)で世帯スコープは開くが、
--             ユーザーアバター（uid スコープ）は個人のまま
-- ===============================================================
select set_config('request.jwt.claims',
  '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}', true);

select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'avatars'
      and name = '11111111-1111-1111-1111-111111111111/avatars/00000000-0000-0000-0000-0000000000a1-ha.jpg'$$,
  $$values (0)$$,
  'メンバー追加前: C は HA スコープのアバターを select 不可'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('avatars', '11111111-1111-1111-1111-111111111111/avatars/00000000-0000-0000-0000-0000000000c5-by-c.jpg')$$,
  '42501',
  null,
  'メンバー追加前: C は HA スコープへ insert 不可'
);

-- C を HA のメンバーに追加（postgres へ戻して RLS 迂回で投入）
reset role;
insert into public.household_members (household_id, user_id, role)
values ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'editor');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}', true);

select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'avatars'
      and name = '11111111-1111-1111-1111-111111111111/avatars/00000000-0000-0000-0000-0000000000a1-ha.jpg'$$,
  $$values (1)$$,
  'メンバー追加後: C は HA スコープのアバターを select 可（ペット/世帯アバターは世帯共有）'
);
select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('avatars', '11111111-1111-1111-1111-111111111111/avatars/00000000-0000-0000-0000-0000000000c6-by-c.jpg')$$,
  'メンバー追加後: C は HA スコープへ insert 可'
);
select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'avatars'
      and name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/avatars/00000000-0000-0000-0000-00000000000a-a.jpg'$$,
  $$values (0)$$,
  '同世帯メンバーになっても A のユーザーアバター（uid スコープ）は select 不可（個人スコープ維持）'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('avatars', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/avatars/00000000-0000-0000-0000-0000000000c7-evil.jpg')$$,
  '42501',
  null,
  '同世帯メンバーでも他人(A)の uid スコープへは insert 不可'
);
select isnt_empty(
  $$delete from storage.objects
    where bucket_id = 'avatars'
      and name = '11111111-1111-1111-1111-111111111111/avatars/00000000-0000-0000-0000-0000000000a1-ha.jpg'
    returning 1$$,
  'メンバー追加後: C は HA スコープのアバターを delete 可（差し替え時の片付けを世帯メンバーが行える）'
);

reset role;

select * from finish();
rollback;
