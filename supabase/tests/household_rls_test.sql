-- =============================================================
-- mfmf / Phase 3.5 S1 (Issue #38 / #92 手順5) — household テナント分離の pgTAP 証明
--
-- 目的: owner_id ポリシーと household メンバー判定ポリシーを *併存* させた状態で、
--   「他 household のデータに一切アクセスできない」ことを継続的に証明する（旧 #48 吸収）。
--   RLS を弱める変更が入ると本テストが赤くなり、CI が PR を落とす。
--
-- 実行: supabase start 後に `supabase test db`（pg_prove が postgres 接続で実行）。
--   各テストは独自トランザクションで begin/rollback され、DB を汚さない。
--
-- 認可の切替: set local role authenticated + request.jwt.claims.sub で auth.uid() を
--   差し替える（Supabase 公式 pgTAP ガイドと同じ手法）。fixture 投入は postgres
--   （RLS 迂回）で行い、ユーザー視点の検証だけ authenticated に降格して行う。
--
-- シナリオ:
--   ② owner 経由の既存アクセスは従来どおり可（owner_id ポリシー不変の確認）
--   ① 別 household のユーザー(B)は他 household(A) 行を select/insert/update/delete 不可
--   ③ メンバー追加(C を A の household へ)で当該データにアクセス可になる
-- =============================================================

begin;

create extension if not exists pgtap with schema extensions;

select plan(32);

-- ---------------------------------------------------------------
-- 固定 UUID（fixture）
--   A / B = 既存オーナー（それぞれ household HA / HB の owner）
--   C     = 後から HA に追加するメンバー（初期は無所属）
-- ---------------------------------------------------------------
-- users:      A=aaaa.., B=bbbb.., C=cccc..
-- households: HA=1111.., HB=2222..
-- pets:       PA=aaaa1111.., PB=bbbb2222..
-- records:    RA=aaaa0000..1, RB=bbbb0000..2
-- photos:     PHA=aaaaffff..1, PHB=bbbbffff..2
-- feedback:   FA=aaaaeeee..1, FB=bbbbeeee..2

-- fixture 投入（postgres ロール = RLS 迂回）
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

insert into public.pets (id, owner_id, household_id, name) values
  ('aaaa1111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'A pet'),
  ('bbbb2222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'B pet');

insert into public.daycare_records (id, owner_id, household_id, pet_id, body) values
  ('aaaa0000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'aaaa1111-1111-1111-1111-111111111111', 'A record'),
  ('bbbb0000-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'bbbb2222-2222-2222-2222-222222222222', 'B record');

insert into public.record_photos (id, record_id, household_id, storage_path) values
  ('aaaaffff-0000-0000-0000-000000000001', 'aaaa0000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/aaaa0000-0000-0000-0000-000000000001/a.jpg'),
  ('bbbbffff-0000-0000-0000-000000000002', 'bbbb0000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/bbbb0000-0000-0000-0000-000000000002/b.jpg');

insert into public.feedback (id, owner_id, household_id, body) values
  ('aaaaeeee-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'A feedback'),
  ('bbbbeeee-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'B feedback');

-- ===============================================================
-- 不変条件ガード: ヘルパーが SECURITY DEFINER、既存 owner_id ポリシーが残存
-- ===============================================================
select is_definer(
  'has_household_role',
  'has_household_role は SECURITY DEFINER（members 自己参照の RLS 再帰回避）'
);

select ok(
  exists (select 1 from pg_policies
          where schemaname = 'public' and tablename = 'daycare_records'
            and policyname = 'records_select_own'),
  '既存 owner_id ポリシー records_select_own が併存追加後も残存している'
);
select ok(
  exists (select 1 from pg_policies
          where schemaname = 'public' and tablename = 'pets'
            and policyname = 'pets_select_own'),
  '既存 owner_id ポリシー pets_select_own が残存している'
);
select ok(
  exists (select 1 from pg_policies
          where schemaname = 'public' and tablename = 'feedback'
            and policyname = 'feedback_select_own'),
  '既存 owner_id ポリシー feedback_select_own が残存している'
);
select ok(
  exists (select 1 from pg_policies
          where schemaname = 'public' and tablename = 'record_photos'
            and policyname = 'photos_select_own'),
  '既存 owner_id ポリシー photos_select_own が残存している'
);

-- ===============================================================
-- シナリオ②: owner(A) は自分のデータに従来どおりアクセスできる
-- ===============================================================
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);

select results_eq(
  $$select count(*)::int from public.daycare_records where id = 'aaaa0000-0000-0000-0000-000000000001'$$,
  $$values (1)$$,
  'owner A は自分の daycare_record を参照できる（owner_id ポリシー）'
);
select results_eq(
  $$select count(*)::int from public.pets where id = 'aaaa1111-1111-1111-1111-111111111111'$$,
  $$values (1)$$,
  'owner A は自分の pet を参照できる'
);
select results_eq(
  $$select count(*)::int from public.feedback where id = 'aaaaeeee-0000-0000-0000-000000000001'$$,
  $$values (1)$$,
  'owner A は自分の feedback を参照できる'
);
select results_eq(
  $$select count(*)::int from public.record_photos where id = 'aaaaffff-0000-0000-0000-000000000001'$$,
  $$values (1)$$,
  'owner A は自分の record_photo を参照できる'
);

-- ===============================================================
-- シナリオ①: 別 household のユーザー B は A のデータに一切触れない
-- ===============================================================
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}', true);

-- sanity: B は自分のデータは見える（認証が効いていることの確認）
select results_eq(
  $$select count(*)::int from public.daycare_records where id = 'bbbb0000-0000-0000-0000-000000000002'$$,
  $$values (1)$$,
  'B は自分の daycare_record は参照できる（sanity）'
);

-- select 不可（他 household）
select results_eq(
  $$select count(*)::int from public.daycare_records where id = 'aaaa0000-0000-0000-0000-000000000001'$$,
  $$values (0)$$,
  'B は他 household(A) の daycare_record を select 不可'
);
select results_eq(
  $$select count(*)::int from public.pets where id = 'aaaa1111-1111-1111-1111-111111111111'$$,
  $$values (0)$$,
  'B は他 household(A) の pet を select 不可'
);
select results_eq(
  $$select count(*)::int from public.feedback where id = 'aaaaeeee-0000-0000-0000-000000000001'$$,
  $$values (0)$$,
  'B は他 household(A) の feedback を select 不可'
);
select results_eq(
  $$select count(*)::int from public.record_photos where id = 'aaaaffff-0000-0000-0000-000000000001'$$,
  $$values (0)$$,
  'B は他 household(A) の record_photo を select 不可'
);

-- update / delete は RLS で no-op（returning 行が無い = 1 行も触れない）
select is_empty(
  $$update public.daycare_records set body = 'hacked' where id = 'aaaa0000-0000-0000-0000-000000000001' returning 1$$,
  'B は他 household(A) の daycare_record を update できない（no-op）'
);
select is_empty(
  $$delete from public.daycare_records where id = 'aaaa0000-0000-0000-0000-000000000001' returning 1$$,
  'B は他 household(A) の daycare_record を delete できない（no-op）'
);
select is_empty(
  $$update public.pets set name = 'hacked' where id = 'aaaa1111-1111-1111-1111-111111111111' returning 1$$,
  'B は他 household(A) の pet を update できない（no-op）'
);

-- insert: 他人(A)を owner とする行を他 household(HA) へ作れない（owner/household 両ポリシー不成立）
--   errmsg は NULL（= SQLSTATE 42501 のみ照合）。RLS 違反メッセージ文言は PG メジャー
--   バージョン / lc_messages で変わり得るため、安定な SQLSTATE のみで判定する。
select throws_ok(
  $$insert into public.feedback (owner_id, household_id, body)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'x')$$,
  '42501',
  null,
  'B は他人(A)を owner とする feedback を他 household へ insert できない'
);
select throws_ok(
  $$insert into public.pets (owner_id, household_id, name)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'x')$$,
  '42501',
  null,
  'B は他人(A)を owner とする pet を他 household へ insert できない'
);

-- 自己昇格ガード: B は household_members へ自分を勝手に追加できない。
--   household_members には INSERT の RLS ポリシーが無い（deny by default）。これが
--   has_household_role を「自分でメンバーになって権限取得」する経路から守る要であり、
--   将来うっかり permissive な insert ポリシーが足されたら本テストが赤くなる。
select throws_ok(
  $$insert into public.household_members (household_id, user_id, role)
    values ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner')$$,
  '42501',
  null,
  'B は household_members へ自分を勝手に追加できない（自己昇格不可・deny by default）'
);

-- ===============================================================
-- シナリオ③: C を HA に追加するとアクセスできるようになる
-- ===============================================================
-- まずは無所属の C は A のデータを見られない
select set_config('request.jwt.claims',
  '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}', true);
select results_eq(
  $$select count(*)::int from public.daycare_records where id = 'aaaa0000-0000-0000-0000-000000000001'$$,
  $$values (0)$$,
  'メンバー追加前: C は A の daycare_record を select 不可'
);

-- C を HA のメンバーに追加（postgres へ戻して RLS 迂回で投入）
reset role;
insert into public.household_members (household_id, user_id, role)
values ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member');

-- 再び C として検証
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}', true);

select results_eq(
  $$select count(*)::int from public.daycare_records where id = 'aaaa0000-0000-0000-0000-000000000001'$$,
  $$values (1)$$,
  'メンバー追加後: C は HA の daycare_record を select 可（household ポリシー）'
);
select results_eq(
  $$select count(*)::int from public.pets where id = 'aaaa1111-1111-1111-1111-111111111111'$$,
  $$values (1)$$,
  'メンバー追加後: C は HA の pet を select 可'
);
select results_eq(
  $$select count(*)::int from public.feedback where id = 'aaaaeeee-0000-0000-0000-000000000001'$$,
  $$values (1)$$,
  'メンバー追加後: C は HA の feedback を select 可'
);
select results_eq(
  $$select count(*)::int from public.record_photos where id = 'aaaaffff-0000-0000-0000-000000000001'$$,
  $$values (1)$$,
  'メンバー追加後: C は HA の record_photo を select 可（親レコードの household を継承）'
);

-- C は HA のメンバーだが HB のメンバーではない → B のデータは依然見えない
select results_eq(
  $$select count(*)::int from public.daycare_records where id = 'bbbb0000-0000-0000-0000-000000000002'$$,
  $$values (0)$$,
  'C は非メンバーの HB の daycare_record は select 不可'
);

-- household update ポリシーで C は HA のレコードを更新できる
select isnt_empty(
  $$update public.daycare_records set body = 'shared edit by C'
    where id = 'aaaa0000-0000-0000-0000-000000000001' returning 1$$,
  'メンバー追加後: C は HA の daycare_record を update 可（household ポリシー）'
);

-- household insert ポリシー: owner が A（自分以外）でも HA のメンバーなら insert 可
--   owner_id != auth.uid() なので owner ポリシーは不成立 → household ポリシー単独で許可
select lives_ok(
  $$insert into public.daycare_records (owner_id, household_id, body)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'inserted by C')$$,
  'メンバー追加後: C は HA に daycare_record を insert 可（household ポリシー単独で許可）'
);

-- ===============================================================
-- シナリオ④: owner_id ⇄ household_id 整合の強制（越境防止）
--   household_id / owner_id は移行期どちらもクライアント書込み可能。メンバー判定が
--   household_id 単独を信用すると、owner_id 付け替え / household_id 偽装で越境が起きる。
--   メンバーポリシーは is_household_member(household_id, owner_id) も要求して整合を強制する。
-- ===============================================================
-- C（HA メンバー）は HA レコードの owner_id を非メンバー B へ付け替えられない
--   （member with check の is_household_member(HA, B) が偽、owner with check も C≠B → 42501）。
select throws_ok(
  $$update public.daycare_records set owner_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    where id = 'aaaa0000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  'C は HA レコードの owner_id を非メンバー(B)へ付け替えられない'
);

-- owner 自身(A)でも owner_id を他者(B)へ付け替えられない
--   （owner with check は A≠B、member with check は is_household_member(HA,B) が偽 → 42501）。
--   旧 owner_id ポリシー単独では owner_id は自分に固定で不変だったため、本 PR で弱めていないことの証明。
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select throws_ok(
  $$update public.daycare_records set owner_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    where id = 'aaaa0000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  'A は自分のレコードの owner_id を他者(B)へ付け替えられない（owner_id 不変性を維持）'
);

-- A は owner 経路で「自分の行に他 household(HB) の household_id」を書ける（owner ポリシーは
-- household_id を制約しない＝移行期の既知の未強制）。だが owner(A) は HB のメンバーでないため、
-- is_household_member(HB, A) が偽となり、その行は HB メンバーのメンバー可視クエリに現れない。
select lives_ok(
  $$insert into public.daycare_records (id, owner_id, household_id, body)
    values ('aaaa9999-0000-0000-0000-000000000009',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '22222222-2222-2222-2222-222222222222', 'injected')$$,
  'A は owner 経路で他 household の UUID を持つ自分の行を作成できる（owner_id 経路は不変・未強制）'
);
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}', true);
select results_eq(
  $$select count(*)::int from public.daycare_records where id = 'aaaa9999-0000-0000-0000-000000000009'$$,
  $$values (0)$$,
  'B は owner が HB 非メンバーの注入行を見られない（owner_id ⇄ household_id 整合の強制）'
);

reset role;
select * from finish();
rollback;
