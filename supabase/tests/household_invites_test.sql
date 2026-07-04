-- =============================================================
-- mfmf / Phase 3.5 S3 (Issue #45 / #38) — household_invites と受諾フローの pgTAP 証明
--
-- 20260704010000_household_invites.sql の検証:
--   - 招待の発行・管理は世帯 owner のみ（editor・非メンバーは不可）
--   - 被招待者は「自分のメール宛て」の招待のみ閲覧できる
--   - 受諾 accept_household_invite は token 実在・未失効・未使用・期限内・
--     宛先メール一致（D12/D13）をすべて満たす場合のみメンバー化する
--   - household_members への直接 insert は引き続き deny by default（UC-A05）
--   - 複数世帯への参加可（UC-H07。D2 は切替 UI とセットで解除 = 20260704030000）
--   - get_household_members はメンバー限定でメール・表示名を返す（非メンバーは拒否）
-- =============================================================

begin;

create extension if not exists pgtap with schema extensions;

select plan(18);

-- fixture:
--   A = HA の owner / E = HA の editor / B = 未所属（被招待者）/ C = HB の owner（D2 用）
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a@test.local'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'e@test.local'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b@test.local'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c@test.local');

insert into public.households (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'HA'),
  ('22222222-2222-2222-2222-222222222222', 'HB');

insert into public.household_members (household_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'editor'),
  ('22222222-2222-2222-2222-222222222222', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'owner');

insert into public.household_invites
  (household_id, email, role, token, invited_by, expires_at, revoked_at) values
  ('11111111-1111-1111-1111-111111111111', 'b@test.local', 'viewer', 'tok-valid',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() + interval '7 days', null),
  ('11111111-1111-1111-1111-111111111111', 'b@test.local', 'editor', 'tok-expired',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() - interval '1 day', null),
  ('11111111-1111-1111-1111-111111111111', 'b@test.local', 'editor', 'tok-revoked',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() + interval '7 days', now()),
  ('11111111-1111-1111-1111-111111111111', 'c@test.local', 'editor', 'tok-for-c',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() + interval '7 days', null);

select is_definer(
  'accept_household_invite',
  'accept_household_invite は SECURITY DEFINER（deny by default の household_members へ書ける唯一の経路）'
);

-- ---------------------------------------------------------------
-- editor E は招待を発行できない（owner のみ）
-- ---------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","email":"e@test.local","role":"authenticated"}', true);
select throws_ok(
  $$insert into public.household_invites (household_id, email, role, token, invited_by, expires_at)
    values ('11111111-1111-1111-1111-111111111111', 'x@test.local', 'viewer', 'tok-by-editor',
            'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', now() + interval '7 days')$$,
  '42501',
  null,
  'editor は招待を発行できない（invites_insert_owner）'
);

-- ---------------------------------------------------------------
-- 被招待者 B（未所属）
-- ---------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","email":"b@test.local","role":"authenticated"}', true);

select results_eq(
  $$select count(*)::int from public.household_invites where token = 'tok-valid'$$,
  $$values (1)$$,
  '被招待者は自分のメール宛ての招待を閲覧できる（invites_select_invitee）'
);
select results_eq(
  $$select count(*)::int from public.household_invites where token = 'tok-for-c'$$,
  $$values (0)$$,
  '他人のメール宛ての招待は見えない'
);
select throws_ok(
  $$insert into public.household_invites (household_id, email, role, token, invited_by, expires_at)
    values ('11111111-1111-1111-1111-111111111111', 'b@test.local', 'viewer', 'tok-by-b',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', now() + interval '7 days')$$,
  '42501',
  null,
  '非メンバーは招待を発行できない'
);
select throws_ok(
  $$insert into public.household_members (household_id, user_id, role)
    values ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner')$$,
  '42501',
  null,
  'household_members への直接 insert は引き続き deny by default（自己昇格不可 UC-A05）'
);

select throws_ok(
  $$select public.accept_household_invite('tok-expired')$$,
  'P0002', null, '期限切れの招待は受諾できない'
);
select throws_ok(
  $$select public.accept_household_invite('tok-revoked')$$,
  'P0002', null, '取り消された招待は受諾できない'
);
select throws_ok(
  $$select public.accept_household_invite('tok-for-c')$$,
  '42501', null, '宛先メールが一致しないアカウントでは受諾できない（D12/D13）'
);
select lives_ok(
  $$select public.accept_household_invite('tok-valid')$$,
  '宛先メール一致・期限内の招待は受諾できる（UC-O10）'
);
select results_eq(
  $$select count(*)::int from public.household_members
    where household_id = '11111111-1111-1111-1111-111111111111'
      and user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
      and role = 'viewer'$$,
  $$values (1)$$,
  '受諾で招待どおりの role（viewer）のメンバーになる'
);
select lives_ok(
  $$select public.accept_household_invite('tok-valid')$$,
  '本人による受諾済み招待の再試行は冪等に成功する（成功後のタイムアウト再試行・リンク再訪）'
);

-- ---------------------------------------------------------------
-- owner A は発行・取消ができる
-- ---------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"a@test.local","role":"authenticated"}', true);
select lives_ok(
  $$insert into public.household_invites (household_id, email, role, token, invited_by, expires_at)
    values ('11111111-1111-1111-1111-111111111111', 'new@test.local', 'editor', 'tok-new',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() + interval '7 days')$$,
  'owner は招待を発行できる（UC-O09）'
);
select isnt_empty(
  $$update public.household_invites set revoked_at = now()
    where token = 'tok-new' returning 1$$,
  'owner は招待を取り消せる（UC-O11）'
);

-- ---------------------------------------------------------------
-- 複数世帯への参加（UC-H07・D1。D2 は切替 UI とセットで解除済み = 20260704030000）
-- と get_household_members（メンバー限定のメール解決）
-- ---------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","email":"c@test.local","role":"authenticated"}', true);
select lives_ok(
  $$select public.accept_household_invite('tok-for-c')$$,
  '既に他世帯（HB）へ所属するユーザーも受諾できる（複数世帯参加 UC-H07。D2 は切替 UI とセットで解除）'
);
select results_eq(
  $$select count(*)::int from public.household_members
    where user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'$$,
  $$values (2)$$,
  'C は HB と HA の 2 世帯に所属する'
);
select results_eq(
  $$select count(*)::int from public.get_household_members('11111111-1111-1111-1111-111111111111')
    where email = 'a@test.local'$$,
  $$values (1)$$,
  'メンバーは get_household_members で世帯メンバーのメールを解決できる'
);
select set_config('request.jwt.claims',
  '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","email":"e@test.local","role":"authenticated"}', true);
select throws_ok(
  $$select * from public.get_household_members('22222222-2222-2222-2222-222222222222')$$,
  '42501', null, '非メンバーは get_household_members を呼べない（メンバー構成・メールを漏らさない）'
);

reset role;
select * from finish();
rollback;
