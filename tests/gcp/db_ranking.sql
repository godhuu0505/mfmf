begin;
set local role mfmf_owner;
set local search_path=public,extensions;
select set_config('request.jwt.claims','{}',true);
select no_plan();
insert into auth.users(id) values
 ('70000000-0000-4000-8000-000000000001'),('70000000-0000-4000-8000-000000000002');
insert into public.households(id,name) values ('70000000-0000-4000-8000-000000000003','ranking');
insert into public.household_members(household_id,user_id,role) values
 ('70000000-0000-4000-8000-000000000003','70000000-0000-4000-8000-000000000001','viewer');
select ok((select relforcerowsecurity from pg_class where oid='public.record_ranking_project_budget'::regclass),'global budget FORCE RLS retained');
select ok((select relforcerowsecurity from pg_class where oid='public.record_ranking_user_budget'::regclass),'user budget FORCE RLS retained');
set local role authenticated;
select set_config('request.jwt.claims','{}',true);
select throws_ok($$select public.reserve_record_ranking('70000000-0000-4000-8000-000000000003')$$,'42501',null,'absent UID refused');
select set_config('request.jwt.claims','{"sub":"70000000-0000-4000-8000-000000000002"}',true);
select throws_ok($$select public.reserve_record_ranking('70000000-0000-4000-8000-000000000003')$$,'42501',null,'nonmember cannot consume budget');
select set_config('request.jwt.claims','{"sub":"70000000-0000-4000-8000-000000000001"}',true);
select is(public.reserve_record_ranking('70000000-0000-4000-8000-000000000003')->>'reason',
 case when clock_timestamp()<timestamptz '2027-06-24 00:00:00+09' then 'reserved' else 'expired' end,
 'non-superuser definer works through explicit owner policy and retains expiry');
select throws_ok($$update public.record_ranking_project_budget set lifetime_count=0$$,'42501',null,'user cannot refund global budget');
select throws_ok($$delete from public.record_ranking_user_budget$$,'42501',null,'user cannot reset private counter');
select * from finish();
rollback;
