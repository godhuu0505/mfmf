-- =============================================================
-- mfmf / 予定（これからのこと）と担当 — D34
--
-- 予定と記録は別のものではなく、**同じ行のステータス違い**にする。
--   planned --「完了して記録にする」--> done
--          --「見送り」--------------> skipped
-- こうすると、完了のときに種類・時間・担当をそのまま引き継げる（書き直させない）。
--
-- 追加するもの:
--   1. daycare_records に status / 時刻 / overrides_rule を足し、source を 6 種へ広げる
--   2. record_assignees      … 送り・お迎え・みる人を「誰が」担当するか
--   3. schedule_rules        … 毎週の予定ルール。**版**（since）で積み、過去は書き換えない
--   4. schedule_rule_assignees … ルールの担当
--   5. schedule_rule_skips   … その日はルールを効かせない（打ち消し）
--
-- RLS はすべて既存の世帯メンバーシップ + role（has_household_role）に合わせる。
-- 読み取り = メンバー全員、書き込み = owner / editor。ゲスト（guest_grants）には
-- 予定を開けない —— ゲストの可視範囲は D8 の最厳格ルールのままにする。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   drop table if exists public.schedule_rule_skips;
--   drop table if exists public.schedule_rule_assignees;
--   drop table if exists public.schedule_rules;
--   drop table if exists public.record_assignees;
--   alter table public.daycare_records
--     drop column if exists status,
--     drop column if exists start_time,
--     drop column if exists end_time,
--     drop column if exists overrides_rule;
--   （source の check は 20260616130705_record_metadata.sql の定義に戻す）
-- =============================================================

-- ---------------------------------------------------------------
-- 1. daycare_records — 予定として持てるようにする
-- ---------------------------------------------------------------
alter table public.daycare_records
  add column if not exists status         text not null default 'done',
  add column if not exists start_time     time,
  add column if not exists end_time       time,
  add column if not exists overrides_rule boolean not null default false;

-- 既存行はすべて「起きたこと」なので done のまま（default で入る）。
alter table public.daycare_records
  drop constraint if exists daycare_records_status_check;
alter table public.daycare_records
  add constraint daycare_records_status_check
  check (status in ('planned', 'done', 'skipped'));

-- 時刻は「両方ある」か「両方ない（終日・時刻なし）」のどちらか。
-- 片方だけ入っていると、週の時間割で置き場所が決まらない。
alter table public.daycare_records
  drop constraint if exists daycare_records_time_pair_check;
alter table public.daycare_records
  add constraint daycare_records_time_pair_check
  check ((start_time is null) = (end_time is null));

alter table public.daycare_records
  drop constraint if exists daycare_records_time_order_check;
alter table public.daycare_records
  add constraint daycare_records_time_order_check
  check (start_time is null or end_time > start_time);

-- source は「記録元」から「どう過ごす日か（種類）」へ広げる。
-- 既存の 'daycare' / 'home' はそのまま通る（値は変えない）。
alter table public.daycare_records
  drop constraint if exists daycare_records_source_check;
alter table public.daycare_records
  add constraint daycare_records_source_check
  check (source in ('daycare', 'home', 'family', 'clinic', 'outing', 'other'));

comment on column public.daycare_records.source is
  '種類: daycare=保育園 / home=おうち / family=家族が来る / clinic=通院 / outing=おでかけ / other=その他';
comment on column public.daycare_records.status is
  'planned=予定 / done=記録ずみ / skipped=見送り。完了すると予定が記録になる（D34）';
comment on column public.daycare_records.start_time is
  '開始時刻（JST の壁時計）。null は時刻なし（クイック記録など）。end_time と対で持つ';
comment on column public.daycare_records.overrides_rule is
  'true ならその日の曜日ルールを隠す。予定として保存したときだけ true。クイック記録は false（記録を足しただけでルールの予定を消さないため）';

-- カレンダーは「世帯 × 日付」で引く。既存の owner ベースの索引とは別に足す。
create index if not exists daycare_records_household_date_idx
  on public.daycare_records (household_id, record_date desc);
create index if not exists daycare_records_household_status_date_idx
  on public.daycare_records (household_id, status, record_date desc);

-- ---------------------------------------------------------------
-- 2. record_assignees — 送り / お迎え / みる人
--    「担当を独立したフォーム項目にしない」ための受け皿（D34）。
--    役割は種類ごとに決まる（保育園 → drop/pick、おうち → care）。
-- ---------------------------------------------------------------
create table if not exists public.record_assignees (
  record_id  uuid        not null references public.daycare_records (id) on delete cascade,
  role       text        not null check (role in ('drop', 'pick', 'care')),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (record_id, role)
);

comment on table public.record_assignees is
  '予定・記録の担当（drop=送り / pick=お迎え / care=みる人）。1 つの役割につき 1 人';

create index if not exists record_assignees_user_idx on public.record_assignees (user_id);

alter table public.record_assignees enable row level security;
grant select, insert, update, delete on public.record_assignees to authenticated;
grant all on public.record_assignees to service_role;

-- 読み書きは、親の記録が属する世帯の権限に従う（親を見られない人には見せない）。
drop policy if exists "record_assignees_select_member" on public.record_assignees;
create policy "record_assignees_select_member"
  on public.record_assignees for select
  using (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_assignees.record_id
        and public.has_household_role(r.household_id)
    )
  );

drop policy if exists "record_assignees_insert_member" on public.record_assignees;
create policy "record_assignees_insert_member"
  on public.record_assignees for insert
  with check (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_assignees.record_id
        and public.has_household_role(r.household_id, array['owner','editor'])
        -- 担当に選べるのはその世帯のメンバーだけ
        and public.is_household_member(r.household_id, record_assignees.user_id)
    )
  );

drop policy if exists "record_assignees_update_member" on public.record_assignees;
create policy "record_assignees_update_member"
  on public.record_assignees for update
  using (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_assignees.record_id
        and public.has_household_role(r.household_id, array['owner','editor'])
    )
  )
  with check (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_assignees.record_id
        and public.has_household_role(r.household_id, array['owner','editor'])
        and public.is_household_member(r.household_id, record_assignees.user_id)
    )
  );

drop policy if exists "record_assignees_delete_member" on public.record_assignees;
create policy "record_assignees_delete_member"
  on public.record_assignees for delete
  using (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_assignees.record_id
        and public.has_household_role(r.household_id, array['owner','editor'])
    )
  );

-- ---------------------------------------------------------------
-- 3. schedule_rules — 毎週の予定ルール（版で積む）
--    「これから毎週◯曜も同じにする」で作り直しても、**それ以前の日は前のルール
--    のまま**にしたい。ひとつの枠を上書きすると過去まで巻き添えで変わるので、
--    (weekday, since) の版で持ち、その日に効く版 = since がその日以前で最新のもの。
--    kind が null の版は「それ以降なし」を意味する墓標。
-- ---------------------------------------------------------------
create table if not exists public.schedule_rules (
  id           uuid        primary key default gen_random_uuid(),
  household_id uuid        not null references public.households (id) on delete cascade,
  weekday      smallint    not null check (weekday between 0 and 6), -- 0=日曜
  since        date        not null,
  kind         text        check (kind in ('daycare', 'home', 'family', 'clinic', 'outing', 'other')),
  start_time   time,
  end_time     time,
  created_by   uuid        not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (household_id, weekday, since),
  -- 墓標（kind is null）は時刻を持たない
  check (kind is not null or (start_time is null and end_time is null)),
  check ((start_time is null) = (end_time is null)),
  check (start_time is null or end_time > start_time)
);

comment on table public.schedule_rules is
  '毎週の予定ルール。(weekday, since) の版で積み、その日に効くのは since がその日以前で最新の版（D34）';
comment on column public.schedule_rules.since is
  'この日から効く。過去の日は前の版のまま（作り直しても過去を書き換えない）';
comment on column public.schedule_rules.kind is
  'null は「この日以降はルールなし」を表す墓標';

create index if not exists schedule_rules_household_weekday_idx
  on public.schedule_rules (household_id, weekday, since desc);

alter table public.schedule_rules enable row level security;
grant select, insert, update, delete on public.schedule_rules to authenticated;
grant all on public.schedule_rules to service_role;

drop policy if exists "schedule_rules_select_member" on public.schedule_rules;
create policy "schedule_rules_select_member"
  on public.schedule_rules for select
  using (public.has_household_role(household_id));

drop policy if exists "schedule_rules_insert_member" on public.schedule_rules;
create policy "schedule_rules_insert_member"
  on public.schedule_rules for insert
  with check (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, created_by)
  );

-- update ポリシーは**作らない**。Data API から直接 since / weekday / kind を書き換え
-- られると、その版が効いていた過去の日まで別の内容になってしまう（版で積む意味が
-- 消える）。変更は「新しい版を積む」= insert、取り消しは delete で行う。
revoke update on public.schedule_rules from authenticated;

-- delete は「今日以降から効く版」だけに限る。
-- 過去から効いている版を消せると、その版が効いていた日のカレンダーが
-- 別の内容に変わってしまう（update を塞いだ意味が無くなる）。
drop policy if exists "schedule_rules_delete_member" on public.schedule_rules;
create policy "schedule_rules_delete_member"
  on public.schedule_rules for delete
  using (
    public.has_household_role(household_id, array['owner','editor'])
    and since >= current_date
  );

-- ---------------------------------------------------------------
-- 4. schedule_rule_assignees — ルールの担当
-- ---------------------------------------------------------------
create table if not exists public.schedule_rule_assignees (
  rule_id    uuid        not null references public.schedule_rules (id) on delete cascade,
  role       text        not null check (role in ('drop', 'pick', 'care')),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (rule_id, role)
);

comment on table public.schedule_rule_assignees is '毎週の予定ルールの担当（役割ごとに 1 人）';

create index if not exists schedule_rule_assignees_user_idx
  on public.schedule_rule_assignees (user_id);

alter table public.schedule_rule_assignees enable row level security;
grant select, insert, update, delete on public.schedule_rule_assignees to authenticated;
grant all on public.schedule_rule_assignees to service_role;

drop policy if exists "schedule_rule_assignees_select_member" on public.schedule_rule_assignees;
create policy "schedule_rule_assignees_select_member"
  on public.schedule_rule_assignees for select
  using (
    exists (
      select 1 from public.schedule_rules s
      where s.id = schedule_rule_assignees.rule_id
        and public.has_household_role(s.household_id)
    )
  );

drop policy if exists "schedule_rule_assignees_insert_member" on public.schedule_rule_assignees;
create policy "schedule_rule_assignees_insert_member"
  on public.schedule_rule_assignees for insert
  with check (
    exists (
      select 1 from public.schedule_rules s
      where s.id = schedule_rule_assignees.rule_id
        and public.has_household_role(s.household_id, array['owner','editor'])
        and public.is_household_member(s.household_id, schedule_rule_assignees.user_id)
    )
  );

drop policy if exists "schedule_rule_assignees_update_member" on public.schedule_rule_assignees;
create policy "schedule_rule_assignees_update_member"
  on public.schedule_rule_assignees for update
  using (
    exists (
      select 1 from public.schedule_rules s
      where s.id = schedule_rule_assignees.rule_id
        and public.has_household_role(s.household_id, array['owner','editor'])
    )
  )
  with check (
    exists (
      select 1 from public.schedule_rules s
      where s.id = schedule_rule_assignees.rule_id
        and public.has_household_role(s.household_id, array['owner','editor'])
        and public.is_household_member(s.household_id, schedule_rule_assignees.user_id)
    )
  );

drop policy if exists "schedule_rule_assignees_delete_member" on public.schedule_rule_assignees;
create policy "schedule_rule_assignees_delete_member"
  on public.schedule_rule_assignees for delete
  using (
    exists (
      select 1 from public.schedule_rules s
      where s.id = schedule_rule_assignees.rule_id
        and public.has_household_role(s.household_id, array['owner','editor'])
    )
  );

-- ---------------------------------------------------------------
-- 5. schedule_rule_skips — その日はルールを効かせない
--    「この日の予定を消す」を押したとき、ルール由来の予定まで毎週消えては困る。
--    その日だけの打ち消しとして 1 行持つ（戻すときは削除する）。
-- ---------------------------------------------------------------
create table if not exists public.schedule_rule_skips (
  household_id uuid        not null references public.households (id) on delete cascade,
  on_date      date        not null,
  created_by   uuid        not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (household_id, on_date)
);

comment on table public.schedule_rule_skips is
  'その日だけ曜日ルールを効かせない（打ち消し）。行を消すとルールに戻る';

alter table public.schedule_rule_skips enable row level security;
-- 打ち消しは「あるか無いか」だけ。更新する意味がないので update は渡さない
-- （同じ日を 2 度消しても ON CONFLICT DO NOTHING で通る）
grant select, insert, delete on public.schedule_rule_skips to authenticated;
grant all on public.schedule_rule_skips to service_role;

drop policy if exists "schedule_rule_skips_select_member" on public.schedule_rule_skips;
create policy "schedule_rule_skips_select_member"
  on public.schedule_rule_skips for select
  using (public.has_household_role(household_id));

drop policy if exists "schedule_rule_skips_insert_member" on public.schedule_rule_skips;
create policy "schedule_rule_skips_insert_member"
  on public.schedule_rule_skips for insert
  with check (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, created_by)
  );

drop policy if exists "schedule_rule_skips_delete_member" on public.schedule_rule_skips;
create policy "schedule_rule_skips_delete_member"
  on public.schedule_rule_skips for delete
  using (public.has_household_role(household_id, array['owner','editor']));

-- ---------------------------------------------------------------
-- 6. ゲストの経路は「記録」だけに閉じる
--    daycare_records に status / overrides_rule が増えたので、20260705000000 の
--    ゲストポリシーをそのままにすると、ゲストが planned の行や overrides_rule = true
--    の行を作れてしまう（世帯の毎週の予定を隠せる）。読み書きとも done に限る。
-- ---------------------------------------------------------------
drop policy if exists "records_select_guest" on public.daycare_records;
create policy "records_select_guest"
  on public.daycare_records for select
  using (
    status = 'done'
    and pet_id is not null
    and (owner_id = auth.uid() or guest_visible)
    and public.has_guest_record_access(household_id, pet_id, record_date)
  );

drop policy if exists "records_insert_guest" on public.daycare_records;
create policy "records_insert_guest"
  on public.daycare_records for insert
  with check (
    status = 'done'
    and overrides_rule = false
    and pet_id is not null
    and owner_id = auth.uid()
    and guest_visible = false
    and public.has_guest_record_access(household_id, pet_id, record_date)
  );

-- ---------------------------------------------------------------
-- 7. updated_at の維持（既存テーブルと同じトリガ関数を使う）
-- ---------------------------------------------------------------
drop trigger if exists schedule_rules_set_updated_at on public.schedule_rules;
create trigger schedule_rules_set_updated_at
  before update on public.schedule_rules
  for each row execute function public.set_updated_at();
