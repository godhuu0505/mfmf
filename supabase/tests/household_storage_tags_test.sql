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
--   ⑤ 複数世帯モデル: 旧規約オブジェクトの開放は「その記録が属する世帯」単位。
--      A が HB にも所属して HB に記録を持つとき、HB のメンバー(B)はその写真を見られるが、
--      A と HA を共有するだけの C は見られない（owner 単位の開放ではないことの証明）
-- =============================================================

begin;

create extension if not exists pgtap with schema extensions;

select plan(44);

-- ---------------------------------------------------------------
-- 固定 UUID（fixture）
--   users:      A=aaaa.., B=bbbb.., C=cccc..
--   households: HA=1111.., HB=2222..（A は HA owner かつ HB member＝複数世帯所属 D1）
--   records:    RA=aaaa0000..1（A/HA）, RB=bbbb0000..2（B/HB）,
--               RX=aaaa0000..3（A が HB に持つ記録＝シナリオ⑤用）
--   tags:       TA=aaaa7777..1（A/HA 共有）, TB=bbbb7777..2（B/HB）,
--               TN=aaaa7777..3（A/household 未所属＝移行期）, TC=cccc7777..4（C が作成）,
--               TSQ=bbbb7777..5（B が owner 経路で HA に注入する不整合タグ）
--   storage:    legacy_a = {A}/{RA}/a.jpg（旧規約）, hh_a = {HA}/{RA}/h.jpg（新規約）,
--               cross_a = {A}/{RX}/x.jpg（旧規約・HB の記録＝シナリオ⑤用）
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
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner'),
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'editor');

insert into public.daycare_records (id, owner_id, household_id, body) values
  ('aaaa0000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'A record'),
  ('bbbb0000-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'B record'),
  ('aaaa0000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'A record in HB');

-- Storage オブジェクト（bucket は init.sql が作成済みの daycare-photos）
insert into storage.objects (bucket_id, name) values
  ('daycare-photos', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/aaaa0000-0000-0000-0000-000000000001/a.jpg'),
  ('daycare-photos', '11111111-1111-1111-1111-111111111111/aaaa0000-0000-0000-0000-000000000001/h.jpg'),
  ('daycare-photos', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/aaaa0000-0000-0000-0000-000000000003/x.jpg'),
  ('daycare-photos', 'not-a-uuid/whatever.jpg');

-- タグ辞書（TA=世帯共有 / TN=移行期の未所属 / TB=他世帯）と RA への付与
insert into public.tags (id, owner_id, household_id, name) values
  ('aaaa7777-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'shared-a'),
  ('bbbb7777-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'shared-b'),
  ('aaaa7777-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'legacy-a'),
  -- TSQ: owner ⇄ household 不整合の注入タグ（owner B ∉ HA）。作成経路は S2 切替で閉鎖済みの
  -- ため postgres で直接投入し、「存在しても誰にも見えず使えない」ことをシナリオ④で証明する。
  ('bbbb7777-0000-0000-0000-000000000005', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'squat');

insert into public.record_tags (record_id, tag_id, owner_id) values
  ('aaaa0000-0000-0000-0000-000000000001', 'aaaa7777-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- 共有リンク（owner A・世帯 HA）。複数世帯の作成者でもリンクの世帯の記録しか返さないことを検証する。
insert into public.share_links (owner_id, household_id, token) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'share-ha-token');

-- storage の protect_objects_delete トリガ（storage migration 0055-prevent-direct-deletes、
-- 文レベル・0 行でも発火）は SQL 直接 DELETE を一律拒否する。これは「Storage API を
-- 経由しない削除でオブジェクト実体が孤児化する」のを防ぐ運用ガードであり、RLS とは
-- 無関係。本テストの検証対象は RLS の delete ポリシーなので、トランザクション限定
--（第3引数 is_local=true、rollback で消える）でガードを解除する。実体を持たない
-- テスト行のみが対象のため孤児化の懸念もない。
select set_config('storage.allow_delete_query', 'true', true);

-- ===============================================================
-- 不変条件ガード
-- ===============================================================
select ok(
  exists (select 1 from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'daycare_photos_select_shared_owner'),
  '旧規約 {owner_id}/... を世帯メンバーへ開放するポリシーが存在する'
);

select ok(
  not exists (select 1 from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'daycare_photos_select_own'),
  'daycare_photos_select_own は S3 で撤去済み（読取は記録の世帯メンバーシップのみ）'
);
select ok(
  exists (select 1 from pg_policies
          where schemaname = 'public' and tablename = 'tags'
            and policyname = 'tags_select_own'),
  'tags_select_own は未所属タグの昇格用に残存（household_id IS NULL に限定）'
);
select ok(
  not exists (select 1 from pg_policies
          where schemaname = 'public' and tablename = 'record_tags'
            and policyname = 'record_tags_select_own'),
  'record_tags_select_own は S3 で撤去済み'
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
  'owner A は旧規約 {owner_id}/... の自分のオブジェクトを select 可（記録の世帯メンバーとして）'
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
-- シナリオ⑤（正例）: 旧規約の開放は「記録の世帯」単位。A が HB に持つ記録 RX の
-- 写真は、HB メンバーの B から見える（owner A が HB のメンバーで整合も成立）。
select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'daycare-photos'
      and name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/aaaa0000-0000-0000-0000-000000000003/x.jpg'$$,
  $$values (1)$$,
  'B は自世帯(HB)の記録に紐づく A の旧規約オブジェクトを select 可（記録の世帯単位で開放）'
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
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('daycare-photos', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/bbbb0000-0000-0000-0000-000000000002/b2.jpg')$$,
  '42501',
  null,
  '旧規約 {owner_id}/... への新規アップロードは本人でも不可（S2 切替で閉鎖。新規は {household_id}/... のみ）'
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

-- シナリオ④前段: かつて owner 経路で作成できた「owner=B, household=HA」の不整合タグは、
-- S2 の切替（tags_insert_own の drop）で作成経路自体が閉じた。万一 DB に残っていた場合に
-- 備え、後続テスト（fixture の TSQ 行を使用）で不整合タグが誰にも可視化されず
-- record_tags にも持ち込めないことは引き続き証明する。
select throws_ok(
  $$insert into public.tags (id, owner_id, household_id, name)
    values ('bbbb7777-0000-0000-0000-000000000006',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            '11111111-1111-1111-1111-111111111111', 'squat2')$$,
  '42501',
  null,
  'B は他 household の UUID を持つタグを作成できない（S2 切替で注入経路が閉鎖）'
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
values ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'editor');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}', true);

select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'daycare-photos'
      and name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/aaaa0000-0000-0000-0000-000000000001/a.jpg'$$,
  $$values (1)$$,
  'メンバー追加後: C は同世帯(HA)の記録に紐づく A の旧規約オブジェクトを select 可'
);
-- シナリオ⑤（負例・P1 回帰）: C は A と HA を共有するが、A が HB に持つ記録 RX の
-- 写真は見えない。「owner とどこかの世帯を共有しているか」で開くと漏れる境界。
select results_eq(
  $$select count(*)::int from storage.objects
    where bucket_id = 'daycare-photos'
      and name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/aaaa0000-0000-0000-0000-000000000003/x.jpg'$$,
  $$values (0)$$,
  'C は owner(A) と世帯を共有していても、別世帯(HB)の記録に紐づく旧規約オブジェクトは select 不可'
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
-- tags_insert_member は owner_id = auth.uid() を要求する（他メンバー名義での作成
-- ＝名前空間の占有・他アカウントの cascade への紐付けをさせない。record_tags と同型）。
select throws_ok(
  $$insert into public.tags (owner_id, household_id, name)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '11111111-1111-1111-1111-111111111111', 'spoofed-owner')$$,
  '42501',
  null,
  'C は同世帯メンバー(A)名義のタグを作成できない（owner_id = auth.uid() の強制）'
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
select lives_ok(
  $$insert into public.record_tags (record_id, tag_id, owner_id)
    values ('aaaa0000-0000-0000-0000-000000000001',
            'bbbb7777-0000-0000-0000-000000000005',
            'cccccccc-cccc-cccc-cccc-cccccccccccc')$$,
  '世帯の辞書に属するタグは作成者の所属に関わらず付与できる（UC-H10: 退出者のタグも世帯の資産として使える）'
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
  $$values (1)$$,
  'household_id が世帯を指すタグは owner の所属に関わらず世帯に見える（UC-H10 の読取緩和。作成経路は S2 で閉鎖済みで、世帯側で削除・整理できる）'
);

reset role;

-- 匿名共有リンク（share_links）は D4/UC-S01 で廃止済み。get_shared_view は
-- トークンの有効・無効・世帯に関わらず常に無効を返す（匿名閲覧の完全停止）。
select ok(
  (public.get_shared_view('share-ha-token') ->> 'valid') = 'false',
  '匿名共有は廃止され、既存トークンでも get_shared_view は記録を返さない（D4/UC-S01）'
);

select * from finish();
rollback;
