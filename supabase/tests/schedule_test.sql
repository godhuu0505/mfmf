-- =============================================================
-- mfmf / 予定と担当（D34）の pgTAP 証明
--
-- 20260810000000_schedule.sql の検証:
--   - daycare_records: status / 時刻の対・順序 / 広げた source の CHECK
--   - record_assignees: 世帯メンバーだけが読み、editor 以上だけが書ける。
--     担当に選べるのは同じ世帯のメンバーだけ（他世帯のユーザーは入れられない）
--   - schedule_rules: 版（weekday, since）の一意性、墓標（kind is null）の時刻なし、
--     テナント分離、viewer は書けない
--   - schedule_rule_skips: 同上
-- =============================================================

begin;

create extension if not exists pgtap with schema extensions;

select plan(27);

-- fixture: HA に A(owner) / E(editor) / V(viewer)、別世帯 HB に B(owner)
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a@test.local'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'e@test.local'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'v@test.local'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b@test.local');

insert into public.households (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'HA'),
  ('22222222-2222-2222-2222-222222222222', 'HB');

insert into public.household_members (household_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'editor'),
  ('11111111-1111-1111-1111-111111111111', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'viewer'),
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner');

-- HA の予定（planned）と、HB の予定
insert into public.daycare_records
  (id, owner_id, household_id, record_date, source, status, start_time, end_time, overrides_rule, body)
values
  ('aaaa0000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', '2026-08-10', 'daycare', 'planned', '09:00', '18:00', true, ''),
  ('bbbb0000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '22222222-2222-2222-2222-222222222222', '2026-08-10', 'clinic', 'planned', '09:30', '11:00', true, '');

-- ---------------------------------------------------------------
-- 1. daycare_records の制約
-- ---------------------------------------------------------------
select results_eq(
  $$select status from public.daycare_records where id = 'bbbb0000-0000-0000-0000-000000000001'$$,
  $$values ('planned'::text)$$,
  '予定は同じテーブルに status = planned で入る'
);
select throws_ok(
  $$insert into public.daycare_records (owner_id, household_id, status, body)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'todo', '')$$,
  '23514',
  null,
  'status は planned / done / skipped のみ'
);
select throws_ok(
  $$insert into public.daycare_records (owner_id, household_id, start_time, body)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', '09:00', '')$$,
  '23514',
  null,
  '開始だけの時刻は入らない（時刻は両方あるか両方ないか）'
);
select throws_ok(
  $$insert into public.daycare_records (owner_id, household_id, start_time, end_time, body)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', '18:00', '09:00', '')$$,
  '23514',
  null,
  '終了が開始より前の予定は入らない'
);
select lives_ok(
  $$insert into public.daycare_records (owner_id, household_id, source, body)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'clinic', '')$$,
  'source は通院など 6 種まで広がった'
);
select throws_ok(
  $$insert into public.daycare_records (owner_id, household_id, source, body)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'walk', '')$$,
  '23514',
  null,
  '知らない種類は入らない'
);
select results_eq(
  $$select overrides_rule from public.daycare_records where id = 'aaaa0000-0000-0000-0000-000000000001'$$,
  $$values (true)$$,
  '予定として保存した行はルールを隠す（overrides_rule）'
);
select results_eq(
  $$select count(*)::int from public.daycare_records
    where household_id = '11111111-1111-1111-1111-111111111111' and overrides_rule = false$$,
  $$values (1)$$,
  '既定は false（記録を足しただけでは曜日ルールの予定を消さない）'
);

-- ---------------------------------------------------------------
-- 2. record_assignees
-- ---------------------------------------------------------------
insert into public.record_assignees (record_id, role, user_id) values
  ('aaaa0000-0000-0000-0000-000000000001', 'drop', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');

select throws_ok(
  $$insert into public.record_assignees (record_id, role, user_id)
    values ('aaaa0000-0000-0000-0000-000000000001', 'walk', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  '23514',
  null,
  '役割は drop / pick / care のみ'
);
select throws_ok(
  $$insert into public.record_assignees (record_id, role, user_id)
    values ('aaaa0000-0000-0000-0000-000000000001', 'drop', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  '23505',
  null,
  '1 つの役割につき担当は 1 人'
);

set local role authenticated;

-- viewer: 読めるが書けない
select set_config('request.jwt.claims',
  '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}', true);
select results_eq(
  $$select count(*)::int from public.record_assignees
    where record_id = 'aaaa0000-0000-0000-0000-000000000001'$$,
  $$values (1)$$,
  'viewer も担当は見える（世帯で共有）'
);
select throws_ok(
  $$insert into public.record_assignees (record_id, role, user_id)
    values ('aaaa0000-0000-0000-0000-000000000001', 'pick', 'dddddddd-dddd-dddd-dddd-dddddddddddd')$$,
  '42501',
  null,
  'viewer は担当を書き込めない'
);

-- editor: 書ける。ただし他世帯のユーザーは担当にできない
select set_config('request.jwt.claims',
  '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","role":"authenticated"}', true);
select lives_ok(
  $$insert into public.record_assignees (record_id, role, user_id)
    values ('aaaa0000-0000-0000-0000-000000000001', 'pick', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  'editor は担当を決められる'
);
select throws_ok(
  $$insert into public.record_assignees (record_id, role, user_id)
    values ('aaaa0000-0000-0000-0000-000000000001', 'care', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$,
  '42501',
  null,
  '他世帯のユーザーは担当にできない'
);

-- 他世帯からは見えない
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}', true);
select results_eq(
  $$select count(*)::int from public.record_assignees
    where record_id = 'aaaa0000-0000-0000-0000-000000000001'$$,
  $$values (0)$$,
  '他世帯からは担当が見えない'
);

-- ---------------------------------------------------------------
-- 3. schedule_rules（版・墓標・テナント分離）
-- ---------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select lives_ok(
  $$insert into public.schedule_rules (id, household_id, weekday, since, kind, start_time, end_time, created_by)
    values ('cccc0000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
            1, '2026-08-01', 'daycare', '09:00', '18:00', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  'owner は毎週のルールを作れる'
);
select lives_ok(
  $$insert into public.schedule_rules (household_id, weekday, since, kind, created_by)
    values ('11111111-1111-1111-1111-111111111111', 1, '2026-08-15', null,
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  '「それ以降なし」は kind = null の版で表せる（過去の版は残る）'
);
select throws_ok(
  $$insert into public.schedule_rules (household_id, weekday, since, kind, start_time, end_time, created_by)
    values ('11111111-1111-1111-1111-111111111111', 1, '2026-08-22', null, '09:00', '18:00',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  '23514',
  null,
  '墓標は時刻を持てない'
);
select throws_ok(
  $$insert into public.schedule_rules (household_id, weekday, since, kind, created_by)
    values ('11111111-1111-1111-1111-111111111111', 1, '2026-08-01', 'home',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  '23505',
  null,
  '同じ曜日・同じ since の版は 1 つだけ'
);
select throws_ok(
  $$insert into public.schedule_rules (household_id, weekday, since, kind, created_by)
    values ('11111111-1111-1111-1111-111111111111', 7, '2026-08-01', 'home',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  '23514',
  null,
  '曜日は 0〜6'
);

select set_config('request.jwt.claims',
  '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}', true);
select results_eq(
  $$select count(*)::int from public.schedule_rules
    where household_id = '11111111-1111-1111-1111-111111111111'$$,
  $$values (2)$$,
  'viewer もルールは見える'
);
select throws_ok(
  $$insert into public.schedule_rules (household_id, weekday, since, kind, created_by)
    values ('11111111-1111-1111-1111-111111111111', 3, '2026-08-01', 'home',
            'dddddddd-dddd-dddd-dddd-dddddddddddd')$$,
  '42501',
  null,
  'viewer はルールを作れない'
);

select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}', true);
select results_eq(
  $$select count(*)::int from public.schedule_rules
    where household_id = '11111111-1111-1111-1111-111111111111'$$,
  $$values (0)$$,
  '他世帯のルールは見えない'
);
select throws_ok(
  $$insert into public.schedule_rules (household_id, weekday, since, kind, created_by)
    values ('11111111-1111-1111-1111-111111111111', 4, '2026-08-01', 'home',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$,
  '42501',
  null,
  '他世帯にルールを差し込めない'
);

-- ---------------------------------------------------------------
-- 4. schedule_rule_skips（その日だけの打ち消し）
-- ---------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","role":"authenticated"}', true);
select lives_ok(
  $$insert into public.schedule_rule_skips (household_id, on_date, created_by)
    values ('11111111-1111-1111-1111-111111111111', '2026-08-17',
            'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')$$,
  'editor はその日のルールを打ち消せる'
);
select set_config('request.jwt.claims',
  '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}', true);
-- delete は RLS の using に落ちても例外にならず 0 行になる。残っていることで確かめる
delete from public.schedule_rule_skips
  where household_id = '11111111-1111-1111-1111-111111111111';
select results_eq(
  $$select count(*)::int from public.schedule_rule_skips
    where household_id = '11111111-1111-1111-1111-111111111111'$$,
  $$values (1)$$,
  'viewer は打ち消しを消せない（行が残る）'
);
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}', true);
select results_eq(
  $$select count(*)::int from public.schedule_rule_skips
    where household_id = '11111111-1111-1111-1111-111111111111'$$,
  $$values (0)$$,
  '他世帯の打ち消しは見えない'
);

reset role;

select * from finish();
rollback;
