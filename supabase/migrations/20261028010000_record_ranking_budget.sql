-- Ranking is opt-in at the server and has a separate, transactionally reserved budget.
-- These tables contain counters only. No queries, record bodies or API results are stored.
create table public.record_ranking_project_budget (
  singleton boolean primary key default true check (singleton),
  usage_day date not null,
  daily_count integer not null default 0 check (daily_count between 0 and 100),
  lifetime_count integer not null default 0 check (lifetime_count between 0 and 5000)
);

insert into public.record_ranking_project_budget (singleton, usage_day)
values (true, date '1970-01-01');

create table public.record_ranking_user_budget (
  user_id uuid primary key references auth.users(id) on delete cascade,
  usage_day date not null,
  daily_count integer not null default 0 check (daily_count between 0 and 20),
  usage_minute timestamptz not null,
  minute_count integer not null default 0 check (minute_count between 0 and 5)
);

alter table public.record_ranking_project_budget enable row level security;
alter table public.record_ranking_project_budget force row level security;
alter table public.record_ranking_user_budget enable row level security;
alter table public.record_ranking_user_budget force row level security;
revoke all on public.record_ranking_project_budget from public, anon, authenticated, service_role;
revoke all on public.record_ranking_user_budget from public, anon, authenticated, service_role;

-- SECURITY INVOKER cannot update a hidden global counter without granting callers
-- direct table access. This narrow definer is the only authenticated write path.
-- Caller UID is never accepted as input, and every household must be a real membership.
create function public.reserve_record_ranking(p_household uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  instant timestamptz;
  today date;
  minute timestamptz;
  project_budget public.record_ranking_project_budget%rowtype;
  user_budget public.record_ranking_user_budget%rowtype;
  project_daily integer;
  user_daily integer;
  user_minute integer;
begin
  if caller is null or p_household is null then
    raise exception 'Ranking access denied' using errcode = '42501';
  end if;
  -- Lock membership during the reservation. Guest grants are deliberately not accepted.
  perform 1 from public.household_members
    where household_id = p_household and user_id = caller
      and role in ('owner', 'editor', 'viewer')
    for share;
  if not found then
    raise exception 'Ranking access denied' using errcode = '42501';
  end if;
  if pg_catalog.clock_timestamp() >= timestamptz '2027-06-24 00:00:00+09' then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'expired');
  end if;

  -- Every call takes the fixed project lock before its own user lock. Concurrent
  -- users cannot exceed the project-wide limits or reset another user's budget.
  select * into strict project_budget from public.record_ranking_project_budget
    where singleton = true for update;
  -- Read the time after waiting for the global lock. A queued request must not
  -- reset a newer day/minute back to its stale transaction-start period.
  instant := pg_catalog.clock_timestamp();
  today := (instant at time zone 'Asia/Tokyo')::date;
  minute := pg_catalog.date_trunc('minute', instant);
  if instant >= timestamptz '2027-06-24 00:00:00+09' then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'expired');
  end if;
  project_daily := case when project_budget.usage_day = today then project_budget.daily_count else 0 end;
  if project_budget.lifetime_count >= 5000 then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'project_lifetime');
  end if;
  if project_daily >= 100 then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'project_day');
  end if;

  insert into public.record_ranking_user_budget (user_id, usage_day, usage_minute)
    values (caller, today, minute) on conflict (user_id) do nothing;
  select * into strict user_budget from public.record_ranking_user_budget
    where user_id = caller for update;
  user_daily := case when user_budget.usage_day = today then user_budget.daily_count else 0 end;
  user_minute := case when user_budget.usage_minute = minute then user_budget.minute_count else 0 end;
  if user_daily >= 20 then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'user_day');
  end if;
  if user_minute >= 5 then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'user_minute');
  end if;

  update public.record_ranking_project_budget
    set usage_day = today, daily_count = project_daily + 1,
        lifetime_count = project_budget.lifetime_count + 1
    where singleton = true;
  update public.record_ranking_user_budget
    set usage_day = today, daily_count = user_daily + 1,
        usage_minute = minute, minute_count = user_minute + 1
    where user_id = caller;
  -- Reservation is consumed even if the subsequent API fails. There is no refund RPC.
  return pg_catalog.jsonb_build_object('allowed', true, 'reason', 'reserved');
end;
$$;

revoke all on function public.reserve_record_ranking(uuid) from public, anon, service_role;
grant execute on function public.reserve_record_ranking(uuid) to authenticated;
