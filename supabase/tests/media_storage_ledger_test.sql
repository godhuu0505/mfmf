-- All fixtures are synthetic; every mutation is rolled back. A ready ledger is
-- deliberately only a user claim: application tests must also verify GCS metadata.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id,email) values
 ('a1000000-0000-4000-8000-000000000001','media-owner@test.local'),
 ('a1000000-0000-4000-8000-000000000002','media-editor@test.local'),
 ('a1000000-0000-4000-8000-000000000003','media-viewer@test.local'),
 ('a1000000-0000-4000-8000-000000000004','media-guest@test.local'),
 ('a1000000-0000-4000-8000-000000000005','media-other@test.local');
insert into public.households(id,name) values
 ('b1000000-0000-4000-8000-000000000001','media A'),
 ('b1000000-0000-4000-8000-000000000002','media B');
insert into public.household_members(household_id,user_id,role) values
 ('b1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','owner'),
 ('b1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002','editor'),
 ('b1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000003','viewer'),
 ('b1000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000005','owner');
insert into public.daycare_records(id,owner_id,household_id) values
 ('c1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001'),
 ('c1000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000005','b1000000-0000-4000-8000-000000000002');
insert into public.pets(id,owner_id,household_id,name) values
 ('d1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','synthetic pet');
insert into storage.objects(bucket_id,name) values
 ('avatars','b1000000-0000-4000-8000-000000000001/avatars/old.jpg'),
 ('daycare-photos','b1000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/old.jpg');
select set_config('storage.allow_delete_query','true',true);
create temp table slots(name text primary key, asset jsonb);
grant all on slots to authenticated;
select is(public.get_media_storage_mode(),'supabase','installation preserves Supabase mode');
select throws_ok($$select public.set_media_storage_mode('gcs')$$,'55000',null,'active backend changes require frozen intermediate');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select throws_ok($$select public.set_media_storage_mode('frozen')$$,'42501',null,'JWT cannot switch backend');
select throws_ok($$update public.media_storage_state set mode='gcs'$$,'42501',null,'JWT cannot update mode table');
select throws_ok($$select public.reserve_media_upload('photo','c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',100,'image/jpeg')$$,'55000',null,'reserve disabled before cutover');
select lives_ok($$insert into public.profiles(owner_id,avatar_path) values ('a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001/avatars/old.jpg')$$,'legacy profile mutation preserved');
reset role;
select set_config('request.jwt.claims','{}',true);
select public.set_media_storage_mode('frozen');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select is((select count(*)::int from storage.objects where bucket_id='avatars'),1,'frozen retains old reads');
select throws_ok($$insert into storage.objects(bucket_id,name) values('avatars','a1000000-0000-4000-8000-000000000001/avatars/new.jpg')$$,'42501',null,'frozen denies direct Storage inserts');
select is_empty($$delete from storage.objects where bucket_id='avatars' returning id$$,'frozen hides rows from direct Storage deletes');
select is_empty($$update storage.objects set name=name where bucket_id='avatars' returning id$$,'frozen denies Storage update');
select throws_ok($$update public.profiles set avatar_path=null where owner_id=auth.uid()$$,'55000',null,'frozen denies avatar mutations');
select throws_ok($$delete from public.daycare_records where id='c1000000-0000-4000-8000-000000000001'$$,'55000',null,'frozen denies parent delete');
select throws_ok($$update public.daycare_records set household_id='b1000000-0000-4000-8000-000000000002' where id='c1000000-0000-4000-8000-000000000001'$$,'55000',null,'frozen denies parent transfer');
select throws_ok($$delete from public.pets where id='d1000000-0000-4000-8000-000000000001'$$,'55000',null,'frozen denies pet delete');
reset role;
select set_config('request.jwt.claims','{}',true);
-- Clear the synthetic legacy profile before entering GCS.
update public.profiles set avatar_path=null where owner_id='a1000000-0000-4000-8000-000000000001';
select public.set_media_storage_mode('gcs');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select is((select count(*)::int from storage.objects where bucket_id in ('avatars','daycare-photos')),0,'GCS denies both old Storage buckets reads');
select throws_ok($$insert into storage.objects(bucket_id,name) values('avatars','a1000000-0000-4000-8000-000000000001/avatars/new.jpg')$$,'42501',null,'GCS denies old Storage upload');
select throws_ok($$update public.media_assets set state='ready'$$,'42501',null,'direct ledger DML denied');
select throws_ok($$select public.media_retire_unreferenced(gen_random_uuid())$$,'42501',null,'private helpers are not RPC capabilities');
select throws_ok($$select public.reserve_media_upload('photo','c1000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000001',100,'image/jpeg')$$,'42501',null,'invisible existing record collision rejected');
select throws_ok($$select public.reserve_media_upload('photo','c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002',100,'image/jpeg')$$,'42501',null,'wrong requested household rejected');
select throws_ok($$select public.reserve_media_upload('photo','c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',10485761,'image/jpeg')$$,'22023',null,'photo byte limit');
select throws_ok($$select public.reserve_media_upload('pet','d1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',2097153,'image/jpeg')$$,'22023',null,'avatar byte limit');
select throws_ok($$select public.reserve_media_upload('profile',auth.uid(),null,100,'image/svg+xml')$$,'22023',null,'active MIME refused');
select throws_ok($$update public.profiles set avatar_path='b1000000-0000-4000-8000-000000000002/avatars/victim.jpg' where owner_id=auth.uid()$$,'23514',null,'direct REST raw path cannot become a reference');
-- Owner target, editor uploader: owner binding must not become uploader identity.
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
insert into slots values('photo',public.reserve_media_upload('photo','c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',100,'image/jpeg'));
select is((select asset->>'owner_id' from slots where name='photo'),'a1000000-0000-4000-8000-000000000001','reservation binds record owner');
select is((select asset->>'created_by' from slots where name='photo'),auth.uid()::text,'reservation records actual uploader');
select is((select asset->>'incoming_key' from slots where name='photo'),'_incoming/'||(select asset->>'id' from slots where name='photo'),'incoming key generated internally');
select throws_ok($$select public.reserve_media_upload('household','b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',100,'image/png')$$,'42501',null,'editor cannot mutate household avatar');
insert into slots values('pet',public.reserve_media_upload('pet','d1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',100,'image/png'));
select lives_ok($$select public.commit_media_upload((select (asset->>'id')::uuid from slots where name='pet'),'123')$$,'editor can publish pet avatar');
select lives_ok($$select public.commit_media_upload((select (asset->>'id')::uuid from slots where name='photo'),'124')$$,'editor publishes row-bound photo');
select is((select id from public.record_photos where media_asset_id=(select (asset->>'id')::uuid from slots where name='photo')),(select (asset->>'id')::uuid from slots where name='photo'),'new photo ID equals reservation ID');
select lives_ok($$select public.commit_media_upload((select (asset->>'id')::uuid from slots where name='photo'),'124')$$,'same publish is idempotent');
select throws_ok($$select public.commit_media_upload((select (asset->>'id')::uuid from slots where name='photo'),'125')$$,'55000',null,'ready generation cannot be changed');
select throws_ok($$select public.cancel_media_upload((select (asset->>'id')::uuid from slots where name='photo'))$$,'55000',null,'published media cannot be cancelled');
select throws_ok($$insert into public.record_photos(record_id,household_id,storage_path,media_asset_id) select 'c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',asset->>'final_key',(asset->>'id')::uuid from slots where name='photo'$$,'23514',null,'new photo ledger cannot attach to a second ID');
select throws_ok($$update public.pets set avatar_path=(select asset->>'final_key' from slots where name='photo'),avatar_asset_id=(select (asset->>'id')::uuid from slots where name='photo') where id='d1000000-0000-4000-8000-000000000001'$$,'23514',null,'cross-kind binding rejected');
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select lives_ok($$select public.get_media_upload((select (asset->>'id')::uuid from slots where name='photo'))$$,'member viewer may inspect own household asset');
select throws_ok($$select public.reserve_media_upload('photo','c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',100,'image/jpeg')$$,'42501',null,'viewer cannot reserve household media');
select throws_ok($$select public.delete_media_reference('pet','d1000000-0000-4000-8000-000000000001')$$,'42501',null,'viewer cannot delete household media');
insert into slots values('profile',public.reserve_media_upload('profile',auth.uid(),null,100,'image/webp'));
select lives_ok($$select public.commit_media_upload((select (asset->>'id')::uuid from slots where name='profile'),'130')$$,'viewer may publish personal avatar without existing profile');
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
select throws_ok($$select public.get_media_upload((select (asset->>'id')::uuid from slots where name='photo'))$$,'42501',null,'nonmember cannot inspect household assets');
select throws_ok($$select public.reserve_media_upload('pet','d1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',100,'image/png')$$,'42501',null,'guest/nonmember cannot reserve pet avatar');
select lives_ok($$select public.reserve_media_upload('profile',auth.uid(),null,100,'image/png')$$,'unaffiliated user may reserve personal avatar');
select throws_ok($$select public.reserve_media_upload('profile','a1000000-0000-4000-8000-000000000003',null,100,'image/png')$$,'42501',null,'personal scope cannot be another user');
select throws_ok($$select public.commit_media_upload((select (asset->>'id')::uuid from slots where name='photo'),'124')$$,'42501',null,'other uploader cannot finalize');
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
insert into slots values('replacement',public.reserve_media_upload('pet','d1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',100,'image/png'));
select throws_ok($$select public.commit_media_upload((select (asset->>'id')::uuid from slots where name='replacement'),'140')$$,'40001',null,'avatar CAS rejects stale empty snapshot');
select lives_ok($$select public.commit_media_upload((select (asset->>'id')::uuid from slots where name='replacement'),'140',(select asset->>'final_key' from slots where name='pet'),(select (asset->>'id')::uuid from slots where name='pet'))$$,'avatar CAS replaces expected prior asset');
select is(public.get_media_upload((select (asset->>'id')::uuid from slots where name='pet'))->>'state','deleted','replacement tombstones prior asset');
select throws_ok($$select public.commit_media_upload((select (asset->>'id')::uuid from slots where name='pet'),'123')$$,'55000',null,'deleted asset cannot be republished');
select throws_ok($$update public.pets set avatar_path=(select asset->>'final_key' from slots where name='pet'),avatar_asset_id=(select (asset->>'id')::uuid from slots where name='pet') where id='d1000000-0000-4000-8000-000000000001'$$,'23514',null,'deleted asset cannot be reattached via REST');
select throws_ok($$select public.delete_media_reference('photo','c1000000-0000-4000-8000-000000000002',(select (asset->>'id')::uuid from slots where name='photo'))$$,'42501',null,'delete photo requires exact authorized parent');
select lives_ok($$select public.delete_media_reference('photo','c1000000-0000-4000-8000-000000000001',(select (asset->>'id')::uuid from slots where name='photo'),(select (asset->>'id')::uuid from slots where name='photo'),(select asset->>'final_key' from slots where name='photo'))$$,'photo delete requires and accepts exact CAS');
select is(public.get_media_upload((select (asset->>'id')::uuid from slots where name='photo'))->>'state','deleted','photo deletion leaves tombstone');
insert into slots values('future',public.reserve_media_upload('photo','c1000000-0000-4000-8000-000000000003','b1000000-0000-4000-8000-000000000001',100,'image/jpeg'));
select throws_ok($$select public.commit_media_upload((select (asset->>'id')::uuid from slots where name='future'),'150')$$,'42501',null,'new record upload cannot publish before parent exists');
insert into public.daycare_records(id,owner_id,household_id) values('c1000000-0000-4000-8000-000000000003',auth.uid(),'b1000000-0000-4000-8000-000000000001');
select lives_ok($$select public.commit_media_upload((select (asset->>'id')::uuid from slots where name='future'),'150')$$,'client UUID reservation can publish after parent creation');
insert into slots values('pending',public.reserve_media_upload('photo','c1000000-0000-4000-8000-000000000003','b1000000-0000-4000-8000-000000000001',100,'image/jpeg'));
select lives_ok($$delete from public.daycare_records where id='c1000000-0000-4000-8000-000000000003'$$,'direct parent deletion cascades safely');
select is(public.get_media_upload((select (asset->>'id')::uuid from slots where name='future'))->>'state','deleted','cascade tombstones published photo');
select is(public.get_media_upload((select (asset->>'id')::uuid from slots where name='pending'))->>'state','deleted','cascade also tombstones unfinished upload');
select lives_ok($$select public.cancel_media_upload((select (asset->>'id')::uuid from slots where name='pending'))$$,'cancel tombstone is idempotent');
select lives_ok($$delete from public.pets where id='d1000000-0000-4000-8000-000000000001'$$,'direct pet deletion retires avatar');
select is(public.get_media_upload((select (asset->>'id')::uuid from slots where name='replacement'))->>'state','deleted','pet avatar tombstoned');
-- Expiry and immutability are checked without changing production clocks.
reset role;
select set_config('request.jwt.claims','{}',true);
select throws_ok($$update public.media_assets set state='ready',deleted_at=null where id=(select (asset->>'id')::uuid from slots where name='photo')$$,'55000',null,'even operator cannot resurrect terminal tombstone');
select throws_ok($$delete from public.media_assets where id=(select (asset->>'id')::uuid from slots where name='photo')$$,'55000',null,'tombstone history is not deletable');
select throws_ok($$update public.media_assets set final_key=final_key||'-changed' where id=(select (asset->>'id')::uuid from slots where name='profile')$$,'55000',null,'identity and key immutable');


-- Explicit migration/restore facts belong to operator-only legacy inserts.
select public.set_media_storage_mode('frozen');
insert into public.record_photos(id,record_id,household_id,storage_path) values
 ('e1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/legacy.jpg');
insert into public.media_assets(id,kind,entity_id,household_id,owner_id,created_by,incoming_key,final_key,byte_size,content_type,state,expires_at,generation,is_legacy,legacy_sha256,legacy_path,legacy_reference_id) values
 ('f1000000-0000-4000-8000-000000000001','photo','c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001',null,'_incoming/f1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000001',100,'image/jpeg','ready',now(),'200',true,repeat('a',64),'a1000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/legacy.jpg','e1000000-0000-4000-8000-000000000001');
select isnt_empty($$update public.record_photos set media_asset_id='f1000000-0000-4000-8000-000000000001',storage_path='b1000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000001' where id='e1000000-0000-4000-8000-000000000001' and media_asset_id is null and storage_path='a1000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/legacy.jpg' returning id$$,'operator can atomically CAS legacy ref in frozen mode');
select throws_ok($$update public.media_assets set legacy_sha256=repeat('b',64) where id='f1000000-0000-4000-8000-000000000001'$$,'55000',null,'migration hash and original reference immutable');
select public.set_media_storage_mode('gcs');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select is(public.get_media_upload('f1000000-0000-4000-8000-000000000001')->>'created_by',null,'legacy migration has no fictional uploader');
select lives_ok($$update public.record_photos set storage_path=storage_path where id='e1000000-0000-4000-8000-000000000001'$$,'legacy original photo ID remains valid after cutover');
select throws_ok($$insert into public.record_photos(record_id,household_id,storage_path,media_asset_id) select record_id,household_id,storage_path,media_asset_id from public.record_photos where id='e1000000-0000-4000-8000-000000000001'$$,'23514',null,'legacy asset is bound to its exact original photo reference');
select throws_ok($$select public.commit_media_upload('f1000000-0000-4000-8000-000000000001','200')$$,'42501',null,'legacy cannot use public finalize');
select throws_ok($$select public.cancel_media_upload('f1000000-0000-4000-8000-000000000001')$$,'42501',null,'legacy NULL uploader cannot authorize cancellation');
insert into slots values('household-pending',public.reserve_media_upload('photo','c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',100,'image/jpeg'));
reset role;
select set_config('request.jwt.claims','{}',true);
select throws_ok($$delete from public.households where id='b1000000-0000-4000-8000-000000000001'$$,'55000',null,'household with active media cannot be deleted');
-- Once data and pending reservations are retired, history must survive a normal
-- delete_own_household operation instead of cascading its audit evidence away.
insert into public.households(id,name) values('b1000000-0000-4000-8000-000000000003','empty with tombstone');
insert into public.household_members(household_id,user_id,role) values('b1000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000005','owner');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
insert into slots values('empty-household',public.reserve_media_upload('household','b1000000-0000-4000-8000-000000000003','b1000000-0000-4000-8000-000000000003',100,'image/png'));
select throws_ok($$select public.delete_own_household('b1000000-0000-4000-8000-000000000003')$$,'55000',null,'existing household RPC also refuses pending uploads');
select lives_ok($$select public.cancel_media_upload((select (asset->>'id')::uuid from slots where name='empty-household'))$$,'owner can cancel pending household avatar');
select lives_ok($$select public.delete_own_household('b1000000-0000-4000-8000-000000000003')$$,'terminal history does not prevent empty household deletion');
reset role;
select set_config('request.jwt.claims','{}',true);
select is((select state from public.media_assets where id=(select (asset->>'id')::uuid from slots where name='empty-household')),'deleted','household deletion retains immutable original-scope tombstone');
-- Expired reservation inserted only by operator test fixture.
insert into public.media_assets(id,kind,entity_id,household_id,owner_id,created_by,incoming_key,final_key,byte_size,content_type,expires_at) values
 ('f1000000-0000-4000-8000-000000000002','photo','c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002','_incoming/f1000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002',100,'image/jpeg',now()-interval '1 second');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select throws_ok($$select public.commit_media_upload('f1000000-0000-4000-8000-000000000002','201')$$,'55000',null,'expired reservation cannot be published');
select throws_ok($$select public.commit_media_upload('f1000000-0000-4000-8000-000000000002','0')$$,'22023',null,'zero generation rejected');
select throws_ok($$select public.commit_media_upload('f1000000-0000-4000-8000-000000000002','latest')$$,'22023',null,'non-numeric generation rejected');
-- Deleting an account with no profile row still terminalizes its personal upload.
reset role;
select set_config('request.jwt.claims','{}',true);
select lives_ok($$delete from auth.users where id='a1000000-0000-4000-8000-000000000004'$$,'account without profile can be deleted');
select is((select count(*)::int from public.media_assets where created_by='a1000000-0000-4000-8000-000000000004' and state<>'deleted'),0,'account deletion retires even unmaterialized profile reservation');

insert into public.media_assets(id,kind,entity_id,owner_id,created_by,incoming_key,final_key,byte_size,content_type,expires_at,created_at)
 select id,'profile','a1000000-0000-4000-8000-000000000005','a1000000-0000-4000-8000-000000000005','a1000000-0000-4000-8000-000000000005','_incoming/'||id,'a1000000-0000-4000-8000-000000000005/avatars/'||id,1,'image/png',now()-interval '1 hour',now()-interval '2 hours' from (select gen_random_uuid() id from generate_series(1,20)) q;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
select lives_ok($$select public.reserve_media_upload('profile',auth.uid(),null,100,'image/png')$$,'expired reservations do not permanently consume pending quota');
reset role;
select set_config('request.jwt.claims','{}',true);
-- Quotas cover all tabs/reservations, not only assets visible through a client row.
insert into public.media_assets(id,kind,entity_id,owner_id,created_by,incoming_key,final_key,byte_size,content_type,expires_at,created_at)
 select id,'profile','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','_incoming/'||id,'a1000000-0000-4000-8000-000000000001/avatars/'||id,1,'image/png',now()+interval '1 hour',now()-interval '2 hours' from (select gen_random_uuid() id from generate_series(1,20)) q;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select throws_ok($$select public.reserve_media_upload('profile',auth.uid(),null,1,'image/png')$$,'54000',null,'20 pending reservations limit');
reset role;
select set_config('request.jwt.claims','{}',true);
update public.media_assets set state='deleted',deleted_at=now() where created_by='a1000000-0000-4000-8000-000000000001' and state='reserved';
insert into public.media_assets(id,kind,entity_id,household_id,owner_id,created_by,incoming_key,final_key,byte_size,content_type,expires_at,created_at)
 select id,'photo','c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','_incoming/'||id,'b1000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/'||id,10485760,'image/png',now()+interval '1 hour',now()-interval '2 hours' from (select gen_random_uuid() id from generate_series(1,10)) q;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select throws_ok($$select public.reserve_media_upload('profile',auth.uid(),null,1,'image/png')$$,'54000',null,'100MiB pending byte limit across scopes');
reset role;
select set_config('request.jwt.claims','{}',true);
update public.media_assets set state='deleted',deleted_at=now() where created_by='a1000000-0000-4000-8000-000000000001' and state='reserved';
insert into public.media_assets(id,kind,entity_id,owner_id,created_by,incoming_key,final_key,byte_size,content_type,expires_at,state,deleted_at)
 select id,'profile','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','_incoming/'||id,'a1000000-0000-4000-8000-000000000001/avatars/'||id,1,'image/png',now(),'deleted',now() from (select gen_random_uuid() id from generate_series(1,50)) q;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select throws_ok($$select public.reserve_media_upload('profile',auth.uid(),null,1,'image/png')$$,'54000',null,'50 hourly requests limit includes cancelled uploads');
reset role;
select set_config('request.jwt.claims','{}',true);
insert into public.media_assets(id,kind,entity_id,household_id,owner_id,created_by,incoming_key,final_key,byte_size,content_type,expires_at,created_at,state,generation)
 select id,'photo','c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000005','_incoming/'||id,'b1000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/'||id,10485760,'image/png',now(),now()-interval '2 hours','ready','300' from (select gen_random_uuid() id from generate_series(1,103)) q;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select throws_ok($$select public.reserve_media_upload('photo','c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',1,'image/jpeg')$$,'54000',null,'household 1GiB quota includes other creators ready assets');
reset role;
select set_config('request.jwt.claims','{}',true);
delete from public.household_members where household_id='b1000000-0000-4000-8000-000000000001' and user_id='a1000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select throws_ok($$select public.get_media_upload((select (asset->>'id')::uuid from slots where name='photo'))$$,'42501',null,'revoked membership loses even own-uploaded tombstone access');
reset role;
set local role anon;
select set_config('request.jwt.claims','{}',true);
select is(public.get_media_storage_mode(),'gcs','anonymous mode getter exposes only backend enum');
select throws_ok($$select public.get_media_upload(gen_random_uuid())$$,'42501',null,'anonymous callers cannot invoke asset getter');

select * from finish();
rollback;
