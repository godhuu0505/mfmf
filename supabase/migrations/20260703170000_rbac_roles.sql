-- =============================================================
-- mfmf / Phase 3.5 S2 (Issue #46) — RBAC その1: role 制約 + member 書き込みを editor 以上に限定
--
-- owner / editor / viewer の 3 ロール（vision-and-roadmap.md に合わせ member → editor に統一）
-- をサーバー側で強制する第一歩。方針は S1 と同じ「併存→検証→切替」の段階適用:
--
--   本 migration（S2-PR1）:
--     1. household_members.role に CHECK 制約（'owner' / 'editor' / 'viewer'）。
--        既存データは backfill 由来の 'owner' のみで違反しない。
--     2. S1 で追加した *_member 系の write（insert / update / delete）ポリシーを、
--        has_household_role(household_id, array['owner','editor']) で editor 以上に絞って
--        再作成する（D5: editor は他人の記録も編集可 / D11: 削除も editor 全員可）。
--        select はロールを問わず全メンバー（viewer は閲覧のみ、UC-A01）。
--   後続（S2-PR2 以降）:
--     - 旧 owner_id ベースの write ポリシーの切替（drop）。現時点では併存が残るため、
--       viewer も「自分名義の行」だけは owner 経路で書ける（既知の移行期挙動。
--       viewer ロールの実利用は S3 招待の導入後であり、その前に切替で閉じる）。
--     - household_members のロール管理（owner による変更、最後の owner 降格不可 D6）。
--     - Server Action のロール検査と UI のロール別出し分け。
--
-- 対象ポリシー（S1 の定義から allowed_roles 絞り込みのみ変更。判定構造・整合要求
-- （is_household_member による owner ⇄ household 整合）は 20260630140100 /
-- 20260703120000 / 20260703120100 のまま）:
--   daycare_records: insert / update / delete
--   record_photos:   insert / delete（親レコード継承）
--   feedback:        insert / update / delete
--   pets:            insert / update / delete
--   tags:            insert / update / delete
--   record_tags:     insert / delete（親レコード継承）
--   storage.objects: 新規約 insert / delete、旧規約 delete（select は全メンバーのまま）
--
-- ロールバック手順（本 migration を取り消す場合）:
--   各 create policy を 20260630140100 / 20260703120000 / 20260703120100 の定義
--   （allowed_roles なし）で再作成し、
--   alter table public.household_members drop constraint if exists household_members_role_check;
-- =============================================================

-- ---------------------------------------------------------------
-- 1. role の CHECK 制約
-- ---------------------------------------------------------------
alter table public.household_members
  drop constraint if exists household_members_role_check;
alter table public.household_members
  add constraint household_members_role_check
  check (role in ('owner', 'editor', 'viewer'));

comment on column public.household_members.role is
  'メンバー種別: owner（全権・メンバー管理）/ editor（記録・写真・ペット等の編集）/ viewer（閲覧のみ）';

-- ---------------------------------------------------------------
-- 2. daycare_records — write を editor 以上に限定
-- ---------------------------------------------------------------
drop policy if exists "records_insert_member" on public.daycare_records;
create policy "records_insert_member"
  on public.daycare_records for insert
  with check (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
    and (
      pet_id is null
      or exists (
        select 1 from public.pets p
        where p.id = daycare_records.pet_id
          and p.household_id = daycare_records.household_id
      )
    )
  );

drop policy if exists "records_update_member" on public.daycare_records;
create policy "records_update_member"
  on public.daycare_records for update
  using (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
  )
  with check (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
    and (
      pet_id is null
      or exists (
        select 1 from public.pets p
        where p.id = daycare_records.pet_id
          and p.household_id = daycare_records.household_id
      )
    )
  );

drop policy if exists "records_delete_member" on public.daycare_records;
create policy "records_delete_member"
  on public.daycare_records for delete
  using (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
  );

-- ---------------------------------------------------------------
-- 3. record_photos — write を editor 以上に限定（親レコード継承）
-- ---------------------------------------------------------------
drop policy if exists "photos_insert_member" on public.record_photos;
create policy "photos_insert_member"
  on public.record_photos for insert
  with check (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_photos.record_id
        and public.has_household_role(r.household_id, array['owner','editor'])
        and public.is_household_member(r.household_id, r.owner_id)
    )
  );

drop policy if exists "photos_delete_member" on public.record_photos;
create policy "photos_delete_member"
  on public.record_photos for delete
  using (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_photos.record_id
        and public.has_household_role(r.household_id, array['owner','editor'])
        and public.is_household_member(r.household_id, r.owner_id)
    )
  );

-- ---------------------------------------------------------------
-- 4. feedback — write を editor 以上に限定
--    viewer 自身のフィードバック送信は owner 経路（feedback_insert_own）が引き続き
--    許可する（アプリへのご意見は世帯データの編集権とは別・全メンバー可のまま）。
-- ---------------------------------------------------------------
drop policy if exists "feedback_insert_member" on public.feedback;
create policy "feedback_insert_member"
  on public.feedback for insert
  with check (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "feedback_update_member" on public.feedback;
create policy "feedback_update_member"
  on public.feedback for update
  using (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
  )
  with check (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "feedback_delete_member" on public.feedback;
create policy "feedback_delete_member"
  on public.feedback for delete
  using (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
  );

-- ---------------------------------------------------------------
-- 5. pets — write を editor 以上に限定
-- ---------------------------------------------------------------
drop policy if exists "pets_insert_member" on public.pets;
create policy "pets_insert_member"
  on public.pets for insert
  with check (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "pets_update_member" on public.pets;
create policy "pets_update_member"
  on public.pets for update
  using (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
  )
  with check (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "pets_delete_member" on public.pets;
create policy "pets_delete_member"
  on public.pets for delete
  using (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
  );

-- ---------------------------------------------------------------
-- 6. tags — write を editor 以上に限定（insert の owner_id = auth.uid() は維持）
-- ---------------------------------------------------------------
drop policy if exists "tags_insert_member" on public.tags;
create policy "tags_insert_member"
  on public.tags for insert
  with check (
    owner_id = auth.uid()
    and public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "tags_update_member" on public.tags;
create policy "tags_update_member"
  on public.tags for update
  using (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
  )
  with check (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "tags_delete_member" on public.tags;
create policy "tags_delete_member"
  on public.tags for delete
  using (
    public.has_household_role(household_id, array['owner','editor'])
    and public.is_household_member(household_id, owner_id)
  );

-- ---------------------------------------------------------------
-- 7. record_tags — write を editor 以上に限定（親レコード継承・タグ整合要求は維持）
-- ---------------------------------------------------------------
drop policy if exists "record_tags_insert_member" on public.record_tags;
create policy "record_tags_insert_member"
  on public.record_tags for insert
  with check (
    record_tags.owner_id = auth.uid()
    and exists (
      select 1 from public.daycare_records r
      where r.id = record_tags.record_id
        and public.has_household_role(r.household_id, array['owner','editor'])
        and public.is_household_member(r.household_id, r.owner_id)
    )
    and exists (
      select 1
      from public.tags t
      join public.daycare_records r on r.id = record_tags.record_id
      where t.id = record_tags.tag_id
        and t.household_id = r.household_id
        and public.is_household_member(t.household_id, t.owner_id)
    )
  );

drop policy if exists "record_tags_delete_member" on public.record_tags;
create policy "record_tags_delete_member"
  on public.record_tags for delete
  using (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_tags.record_id
        and public.has_household_role(r.household_id, array['owner','editor'])
        and public.is_household_member(r.household_id, r.owner_id)
    )
  );

-- ---------------------------------------------------------------
-- 8. storage.objects — write を editor 以上に限定（select は全メンバーのまま）
-- ---------------------------------------------------------------
drop policy if exists "daycare_photos_insert_household" on storage.objects;
create policy "daycare_photos_insert_household"
  on storage.objects for insert
  with check (
    bucket_id = 'daycare-photos'
    and public.has_household_role(
      public.try_cast_uuid((storage.foldername(name))[1]),
      array['owner','editor']
    )
  );

drop policy if exists "daycare_photos_delete_household" on storage.objects;
create policy "daycare_photos_delete_household"
  on storage.objects for delete
  using (
    bucket_id = 'daycare-photos'
    and public.has_household_role(
      public.try_cast_uuid((storage.foldername(name))[1]),
      array['owner','editor']
    )
  );

drop policy if exists "daycare_photos_delete_shared_owner" on storage.objects;
create policy "daycare_photos_delete_shared_owner"
  on storage.objects for delete
  using (
    bucket_id = 'daycare-photos'
    and exists (
      select 1 from public.daycare_records r
      where r.id = public.try_cast_uuid((storage.foldername(name))[2])
        and r.owner_id = public.try_cast_uuid((storage.foldername(name))[1])
        and public.has_household_role(r.household_id, array['owner','editor'])
        and public.is_household_member(r.household_id, r.owner_id)
    )
  );
