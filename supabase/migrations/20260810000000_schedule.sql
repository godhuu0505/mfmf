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
--   drop function if exists public.schedule_rules_for_range(uuid, date, date);
--   drop function if exists public.jst_today();
--   （source の check は 20260616130705_record_metadata.sql の定義に戻す）
-- =============================================================

-- ---------------------------------------------------------------
-- 0. アプリの「今日」は JST
--    DB セッションは UTC なので、素の current_date は 00:00〜08:59 JST のあいだ
--    「JST の昨日」を指す。その時間帯だけ過去日の版を差し込めてしまうので、
--    ポリシーの日付判定はアプリと同じ Asia/Tokyo で出す。
-- ---------------------------------------------------------------
create or replace function public.jst_today()
returns date
language sql
stable
set search_path = ''
as $$ select (now() at time zone 'Asia/Tokyo')::date $$;

comment on function public.jst_today() is 'アプリと同じ「今日」（Asia/Tokyo）。RLS の日付判定に使う';

revoke all on function public.jst_today() from public;
grant execute on function public.jst_today() to authenticated, anon, service_role;

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

-- source は「記録元」から「どう過ごす日か（種類）」へ広げる（保育園 / おうち /
-- 病院 / サロン / その他）。
-- 既存の 'daycare' / 'home' はそのまま通る（値は変えない）。
alter table public.daycare_records
  drop constraint if exists daycare_records_source_check;
alter table public.daycare_records
  add constraint daycare_records_source_check
  check (source in ('daycare', 'home', 'clinic', 'salon', 'other'));

comment on column public.daycare_records.source is
  '種類: daycare=保育園 / home=おうち / clinic=病院 / salon=サロン / other=その他';
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
  kind         text        check (kind in ('daycare', 'home', 'clinic', 'salon', 'other')),
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

-- 版は「今日以降から効く」ものだけ作れる。過去の日付で差し込めると、その日から
-- あとのカレンダーが後から書き換わり、update / delete を塞いだ意味が無くなる。
drop policy if exists "schedule_rules_insert_member" on public.schedule_rules;
create policy "schedule_rules_insert_member"
  on public.schedule_rules for insert
  with check (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, created_by)
    and since >= public.jst_today()
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
    and since >= public.jst_today()
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

-- 担当も「今日以降から効く版」だけ触れるようにする。過去から効いている版の担当を
-- 直接書き換えられると、その版が効いていた日の送り迎えが後から変わってしまう
-- （Server Action は今日の版へ複製してから差し替えている）。
drop policy if exists "schedule_rule_assignees_insert_member" on public.schedule_rule_assignees;
create policy "schedule_rule_assignees_insert_member"
  on public.schedule_rule_assignees for insert
  with check (
    exists (
      select 1 from public.schedule_rules s
      where s.id = schedule_rule_assignees.rule_id
        and s.since >= public.jst_today()
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
        and s.since >= public.jst_today()
        and public.has_household_role(s.household_id, array['owner','editor'])
    )
  )
  with check (
    exists (
      select 1 from public.schedule_rules s
      where s.id = schedule_rule_assignees.rule_id
        and s.since >= public.jst_today()
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
        and s.since >= public.jst_today()
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
-- 5.5 版の差し替えは 1 つの関数（＝1 トランザクション）で行う
--     「古い版を消す → 新しい版を入れる」を 2 回のリクエストに分けると、
--     入れる方が失敗したときに版が消えたままになり、以降の予定が前の版や
--     「ルールなし」に落ちる。SECURITY INVOKER なので RLS はそのまま効く。
-- ---------------------------------------------------------------
create or replace function public.replace_schedule_rule(
  p_household  uuid,
  p_weekday    smallint,
  p_since      date,
  p_kind       text,
  p_start      time,
  p_end        time,
  p_assignees  jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  delete from public.schedule_rules
   where household_id = p_household
     and weekday = p_weekday
     and since >= p_since;

  insert into public.schedule_rules
    (household_id, weekday, since, kind, start_time, end_time, created_by)
  values
    (p_household, p_weekday, p_since, p_kind, p_start, p_end, auth.uid())
  returning id into v_id;

  insert into public.schedule_rule_assignees (rule_id, role, user_id)
  select v_id, key, value::uuid
    from jsonb_each_text(coalesce(p_assignees, '{}'::jsonb))
   where value is not null and value <> '';

  return v_id;
end;
$$;

comment on function public.replace_schedule_rule(uuid, smallint, date, text, time, time, jsonb) is
  '毎週のルールの版を差し替える（削除と作成を 1 トランザクションで行う）。RLS は呼び出しユーザーのまま効く';

revoke all on function public.replace_schedule_rule(uuid, smallint, date, text, time, time, jsonb) from public;
grant execute on function public.replace_schedule_rule(uuid, smallint, date, text, time, time, jsonb) to authenticated;

-- 期間を描くのに要る版だけを返す。版は消さずに積むので、素朴に世帯ぶん全部取ると
-- PostgREST の max_rows（supabase/config.toml）で**新しい版から**打ち切られ、
-- カレンダーが古いルールで描かれてしまう。
--   ・p_from 時点で効いている版（曜日ごとに 1 本）
--   ・期間の途中で切り替わる版
-- security invoker なので RLS（select はメンバーのみ）はそのまま効く。
create or replace function public.schedule_rules_for_range(
  p_household uuid,
  p_from      date,
  p_to        date
)
returns setof public.schedule_rules
language sql
stable
security invoker
set search_path = ''
as $$
  select * from (
    select distinct on (r.weekday) r.*
      from public.schedule_rules r
     where r.household_id = p_household
       and r.since <= p_from
     order by r.weekday, r.since desc
  ) active
  union all
  select r.*
    from public.schedule_rules r
   where r.household_id = p_household
     and r.since > p_from
     and r.since <= p_to
$$;

comment on function public.schedule_rules_for_range(uuid, date, date) is
  'その期間のカレンダーを描くのに要るルールの版だけを返す（版が増えても打ち切られない）';

revoke all on function public.schedule_rules_for_range(uuid, date, date) from public;
grant execute on function public.schedule_rules_for_range(uuid, date, date) to authenticated;

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

-- ---------------------------------------------------------------
-- 8. 世帯削除のガードに予定を足す
--    schedule_rules / schedule_rule_skips は households への FK（cascade）を
--    持つので、ガードに足さないと「ペットも記録も無いが毎週のルールはある」世帯が
--    「空」と判定され、ルールごと消える。20260705040000 の本体に 2 行足したもの。
-- ---------------------------------------------------------------
create or replace function public.delete_own_household(p_household_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'ログインが必要です' using errcode = '42501';
  end if;

  -- 空判定より前に世帯行をロックし、チェック→削除を FK 子テーブルに対して
  -- アトミックにする（詳しい理由は 20260705040000_household_delete.sql のコメント）。
  perform 1 from public.households where id = p_household_id for update;

  if not exists (
    select 1 from public.household_members m
    where m.household_id = p_household_id
      and m.user_id = v_uid
      and m.role = 'owner'
  ) then
    raise exception 'この世帯を削除できるのは owner だけです' using errcode = '42501';
  end if;

  -- 参照データのある世帯は削除しない（孤児化防止）。1 行でもあれば拒否。
  -- Storage の残存レースについては 20260705040000 のコメントを参照（#51 へ委ねる）。
  if exists (select 1 from public.pets                where household_id = p_household_id)
     or exists (select 1 from public.daycare_records     where household_id = p_household_id)
     or exists (select 1 from public.record_photos       where household_id = p_household_id)
     or exists (select 1 from public.tags                where household_id = p_household_id)
     or exists (select 1 from public.feedback            where household_id = p_household_id)
     or exists (select 1 from public.household_invites   where household_id = p_household_id)
     or exists (select 1 from public.guest_grants        where household_id = p_household_id)
     or exists (select 1 from public.schedule_rules      where household_id = p_household_id)
     or exists (select 1 from public.schedule_rule_skips where household_id = p_household_id)
     or exists (
          select 1 from storage.objects o
          where o.bucket_id = 'daycare-photos'
            and (storage.foldername(o.name))[1] = p_household_id::text
        ) then
    raise exception 'データのある世帯は削除できません。記録・写真・ペットなどのエクスポート後に削除する導線は準備中です（#51）'
      using errcode = 'P0001';
  end if;

  perform set_config('mfmf.deleting_household', p_household_id::text, true);
  delete from public.households where id = p_household_id;
  perform set_config('mfmf.deleting_household', '', true);
end;
$$;

comment on function public.delete_own_household(uuid) is
  'owner が参照データの無い世帯を削除する（UC-H09 の部分集合）。毎週の予定ルール・打ち消しも「データあり」に数える。SECURITY DEFINER + search_path 固定。';

-- ---------------------------------------------------------------
-- 9. 世帯を抜けた人の担当を外す
--    担当は auth.users への FK なので、household_members を消しても残る。
--    残したままだと、これからの送り迎えが「もう世帯に居ない人」に割り当たり、
--    画面には ? としか出せない。
--    ・これからの予定（planned）… その場で外す
--    ・今日以降から効くルールの版 … その場で外す
--    ・いま効いている版         … 過去を書き換えず「今日からの版」を積んで外す
--    済んだ記録・過去の版は履歴なので触らない。
-- ---------------------------------------------------------------
create or replace function public.prune_schedule_assignments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  r record;
  v_new uuid;
begin
  -- 世帯ごと削除の途中（delete_own_household）では何もしない。
  -- ここで版を積むと、消えていく世帯に子行を作ってしまう
  if coalesce(current_setting('mfmf.deleting_household', true), '') = old.household_id::text then
    return old;
  end if;
  if not exists (select 1 from public.households where id = old.household_id) then
    return old;
  end if;

  delete from public.record_assignees a
   using public.daycare_records rec
   where a.record_id = rec.id
     and rec.household_id = old.household_id
     and rec.status = 'planned'
     and a.user_id = old.user_id;

  delete from public.schedule_rule_assignees a
   using public.schedule_rules s
   where a.rule_id = s.id
     and s.household_id = old.household_id
     and s.since >= v_today
     and a.user_id = old.user_id;

  for r in
    select distinct on (s.weekday) s.*
      from public.schedule_rules s
     where s.household_id = old.household_id
       and s.since < v_today
     order by s.weekday, s.since desc
  loop
    -- 墓標（kind is null）は担当を持たない
    continue when r.kind is null;
    continue when not exists (
      select 1 from public.schedule_rule_assignees a
       where a.rule_id = r.id and a.user_id = old.user_id
    );
    -- 今日からの版がすでにあるなら、上の delete で外れている
    continue when exists (
      select 1 from public.schedule_rules s2
       where s2.household_id = r.household_id
         and s2.weekday = r.weekday
         and s2.since = v_today
    );

    insert into public.schedule_rules
      (household_id, weekday, since, kind, start_time, end_time, created_by)
    values
      (r.household_id, r.weekday, v_today, r.kind, r.start_time, r.end_time, r.created_by)
    returning id into v_new;

    insert into public.schedule_rule_assignees (rule_id, role, user_id)
    select v_new, a.role, a.user_id
      from public.schedule_rule_assignees a
     where a.rule_id = r.id
       and a.user_id <> old.user_id;
  end loop;

  return old;
end;
$$;

comment on function public.prune_schedule_assignments() is
  '世帯を抜けた人の担当を、これからの予定と今日からのルール版から外す（過去は書き換えない）。SECURITY DEFINER + search_path 固定';

drop trigger if exists household_members_prune_schedule on public.household_members;
create trigger household_members_prune_schedule
  after delete on public.household_members
  for each row execute function public.prune_schedule_assignments();
