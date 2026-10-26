-- Every fixture and mode switch is rolled back. Test the privileged completion
-- identity as well as ordinary RLS; no real Storage bytes are created here.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select set_config('storage.allow_delete_query','true',true);
insert into storage.buckets(id,name) values('freeze-unrelated-fixture','freeze-unrelated-fixture');
insert into storage.objects(bucket_id,name,version) values
 ('avatars','freeze-completion-fixture/avatar.png','original'),
 ('daycare-photos','freeze-completion-fixture/photo.png','original'),
 ('freeze-unrelated-fixture','freeze-completion-fixture/other.png','original');
select public.set_media_storage_mode('frozen');
select throws_ok($$insert into storage.objects(bucket_id,name) values('avatars','freeze-completion-fixture/new.png')$$,'55000','Source media writes are unavailable','operator cannot insert after freeze');
select throws_ok($$update storage.objects set version='replacement' where name='freeze-completion-fixture/photo.png'$$,'55000','Source media writes are unavailable','operator cannot change referenced bytes version');
select throws_ok($$delete from storage.objects where name='freeze-completion-fixture/avatar.png'$$,'55000','Source media writes are unavailable','operator cannot delete after freeze');
select throws_ok($$update storage.objects set bucket_id='freeze-unrelated-fixture' where name='freeze-completion-fixture/avatar.png'$$,'55000',null,'cannot move a protected source to another bucket');
select throws_ok($$update storage.objects set bucket_id='avatars' where name='freeze-completion-fixture/other.png'$$,'55000',null,'cannot move another bucket into a protected destination');
select lives_ok($$update storage.objects set version='unrelated' where name='freeze-completion-fixture/other.png'$$,'unrelated bucket remains writable');

select ok((select rolbypassrls from pg_roles where rolname=current_user),'fixture operator bypasses RLS like privileged completion');
select throws_ok($$insert into storage.objects(bucket_id,name) values('daycare-photos','freeze-completion-fixture/new.png')$$,'55000',null,'privileged completion cannot bypass frozen INSERT');
select throws_ok($$update storage.objects set version='replacement' where name='freeze-completion-fixture/avatar.png'$$,'55000',null,'privileged completion cannot bypass frozen UPDATE');
select throws_ok($$delete from storage.objects where name='freeze-completion-fixture/photo.png'$$,'55000',null,'privileged completion cannot bypass frozen DELETE');
select is((select version from storage.objects where name='freeze-completion-fixture/avatar.png'),'original','managed reads remain available without mutation');
set local role service_role;
select throws_ok($$update storage.objects set metadata='{"changed":true}' where name='freeze-completion-fixture/avatar.png'$$,'55000',null,'bypass RLS role cannot mutate metadata');
reset role;

select public.set_media_storage_mode('gcs');
select throws_ok($$update storage.objects set owner_id='different' where name='freeze-completion-fixture/avatar.png'$$,'55000',null,'GCS mode also freezes source ownership');
select throws_ok($$update storage.objects set last_accessed_at=now() where name='freeze-completion-fixture/avatar.png'$$,'55000',null,'no implicit last-access mutation exemption');
select public.set_media_storage_mode('frozen');
select public.set_media_storage_mode('supabase');
select lives_ok($$update storage.objects set version='after-resume' where name='freeze-completion-fixture/avatar.png'$$,'operator writes resume only in Supabase mode');
select lives_ok($$delete from storage.objects where name like 'freeze-completion-fixture/%'$$,'source fixture deletion works after resume');
select * from finish();
rollback;
