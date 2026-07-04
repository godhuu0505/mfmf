-- =============================================================
-- mfmf / Phase 3.5 S3 (Issue #45) — 内部招待その2: 退出/削除の解禁と UC-H10 の成立
--
-- PR #107 のレビューで整理した「一体実装」:
--   退出/削除（UC-H05/H06）を解禁するには、
--   (a) メンバー読取ポリシーの owner ∈ household 整合要求
--       is_household_member(household_id, owner_id) を外す
--       — 外さないと退出者が作った行が世帯からも不可視になり UC-H10
--       （退出メンバーの記録は世帯に残る）が破れる。write が S2 で完全に
--       メンバーシップ強制になったため、この述語は読取側ではもう不要。
--   (b) owner_id ベースの select 経路を整理する
--       — 残すと退出者が自分の書いた世帯データを読み続けられ、
--       UC-H05/H06 の「退出/削除後は世帯データ不可視」が破れる。
--   の両方が前提になる。本 migration はこの (a)(b) と delete ポリシーの解禁、
--   および owner_id の不変化トリガ（述語緩和後の帰属すり替え防止）をまとめて行う。
--
--   1. own select の整理:
--      - daycare_records / record_photos / pets / record_tags: select_own を drop
--        （読取は世帯メンバーシップのみ。退出者は即座に不可視になる）
--      - tags_select_own: 「household_id IS NULL の自分のタグ」に絞って再作成
--        （移行期の未所属タグの昇格フロー用。tags_update_own と対）
--      - storage daycare_photos_select_own: drop（メンバーは shared_owner の
--        記録世帯判定で読める。記録を失った孤児オブジェクトの清掃は運用対応）
--      - 残置（個人スコープ）: feedback_select_own（自分のご意見は退会まで自分の
--        もの）/ profiles / google_credentials / share_links
--   2. member 読取・編集ポリシーの述語緩和（is_household_member(…, owner_id) を除去）:
--      select は「世帯メンバーか」だけで判定。update / delete（editor+）も同様
--      — 退出者が作った行を残った editor が編集・削除できる（D5/D11 と UC-H10）。
--      insert の with check は従来どおり厳格なまま（owner ∈ household を要求。
--      新規行の帰属は書き込み時に正しく固定する）。
--      feedback はご意見（準個人データ）のため member ポリシーを変更しない。
--   3. owner_id の不変化: 述語緩和後は update で owner_id を付け替えても RLS では
--      検出できなくなるため、BEFORE UPDATE トリガで owner_id の変更自体を禁止する
--      （帰属のすり替え・own 経路が残るテーブルへの成りすましを構造的に防ぐ）。
--      対象: daycare_records / pets / tags / feedback / record_tags / share_links。
--   4. household_members の delete 解禁: owner による削除（UC-H05）と本人退出
--      （UC-H06）。最後の owner は D6 トリガ（#107 導入済み）が拒否する。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   drop policy if exists "household_members_delete_owner" on public.household_members;
--   drop policy if exists "household_members_delete_self" on public.household_members;
--   各テーブルの forbid_owner_change トリガと public.forbid_owner_change() を drop、
--   member 系ポリシーを 20260703170000 の定義（整合要求つき）で、own select を
--   20260616130704/130709/130710 の定義で再作成する。
-- =============================================================

-- ---------------------------------------------------------------
-- 1. own select の整理（退出者のアクセス遮断 = UC-H05/H06 の前提）
-- ---------------------------------------------------------------
drop policy if exists "records_select_own" on public.daycare_records;
drop policy if exists "photos_select_own" on public.record_photos;
drop policy if exists "pets_select_own" on public.pets;
drop policy if exists "record_tags_select_own" on public.record_tags;
drop policy if exists "daycare_photos_select_own" on storage.objects;

drop policy if exists "tags_select_own" on public.tags;
create policy "tags_select_own"
  on public.tags for select
  using (auth.uid() = owner_id and household_id is null);

-- ---------------------------------------------------------------
-- 2. member ポリシーの述語緩和（UC-H10: 退出者の行は世帯に残る）
--    insert は変更しない（with check の owner ∈ household 要求は維持）。
-- ---------------------------------------------------------------
drop policy if exists "records_select_member" on public.daycare_records;
create policy "records_select_member"
  on public.daycare_records for select
  using (public.has_household_role(household_id));

drop policy if exists "records_update_member" on public.daycare_records;
create policy "records_update_member"
  on public.daycare_records for update
  using (public.has_household_role(household_id, array['owner','editor']))
  with check (
    public.has_household_role(household_id, array['owner','editor'])
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
  using (public.has_household_role(household_id, array['owner','editor']));

drop policy if exists "photos_select_member" on public.record_photos;
create policy "photos_select_member"
  on public.record_photos for select
  using (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_photos.record_id
        and public.has_household_role(r.household_id)
    )
  );

drop policy if exists "photos_insert_member" on public.record_photos;
create policy "photos_insert_member"
  on public.record_photos for insert
  with check (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_photos.record_id
        and public.has_household_role(r.household_id, array['owner','editor'])
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
    )
  );

drop policy if exists "pets_select_member" on public.pets;
create policy "pets_select_member"
  on public.pets for select
  using (public.has_household_role(household_id));

drop policy if exists "pets_update_member" on public.pets;
create policy "pets_update_member"
  on public.pets for update
  using (public.has_household_role(household_id, array['owner','editor']))
  with check (public.has_household_role(household_id, array['owner','editor']));

drop policy if exists "pets_delete_member" on public.pets;
create policy "pets_delete_member"
  on public.pets for delete
  using (public.has_household_role(household_id, array['owner','editor']));

drop policy if exists "tags_select_member" on public.tags;
create policy "tags_select_member"
  on public.tags for select
  using (public.has_household_role(household_id));

drop policy if exists "tags_update_member" on public.tags;
create policy "tags_update_member"
  on public.tags for update
  using (public.has_household_role(household_id, array['owner','editor']))
  with check (public.has_household_role(household_id, array['owner','editor']));

drop policy if exists "tags_delete_member" on public.tags;
create policy "tags_delete_member"
  on public.tags for delete
  using (public.has_household_role(household_id, array['owner','editor']));

drop policy if exists "record_tags_select_member" on public.record_tags;
create policy "record_tags_select_member"
  on public.record_tags for select
  using (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_tags.record_id
        and public.has_household_role(r.household_id)
    )
  );

-- 退出者が作った共有タグも引き続き記録へ付与できるよう、タグ側の owner 整合要求を
-- 「タグが記録と同じ世帯の辞書に属すること」だけに緩和する（record_tags 行の
-- owner_id = auth.uid() と記録側 editor+ 要求は維持）。
drop policy if exists "record_tags_insert_member" on public.record_tags;
create policy "record_tags_insert_member"
  on public.record_tags for insert
  with check (
    record_tags.owner_id = auth.uid()
    and exists (
      select 1 from public.daycare_records r
      where r.id = record_tags.record_id
        and public.has_household_role(r.household_id, array['owner','editor'])
    )
    and exists (
      select 1
      from public.tags t
      join public.daycare_records r on r.id = record_tags.record_id
      where t.id = record_tags.tag_id
        and t.household_id = r.household_id
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
    )
  );

-- storage 旧規約 {owner_id}/...: 記録の世帯メンバーなら読める/片付けられる
-- （owner の現所属は問わない = 退出者の写真も世帯に残る）。
drop policy if exists "daycare_photos_select_shared_owner" on storage.objects;
create policy "daycare_photos_select_shared_owner"
  on storage.objects for select
  using (
    bucket_id = 'daycare-photos'
    and exists (
      select 1 from public.daycare_records r
      where r.id = public.try_cast_uuid((storage.foldername(name))[2])
        and r.owner_id = public.try_cast_uuid((storage.foldername(name))[1])
        and public.has_household_role(r.household_id)
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
    )
  );

-- ---------------------------------------------------------------
-- 3. owner_id の不変化トリガ（帰属のすり替え防止）
--    読取述語の緩和により RLS では owner_id の付け替えを検出できなくなるため、
--    列自体を不変にする。errcode は RLS 違反と同じ 42501 に揃える。
-- ---------------------------------------------------------------
create or replace function public.forbid_owner_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_id <> old.owner_id then
    raise exception 'owner_id（作成者）は変更できません' using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.forbid_owner_change() is
  'owner_id 列の変更を禁止する（帰属のすり替え防止。S3 の読取述語緩和とセット）';

drop trigger if exists daycare_records_forbid_owner_change on public.daycare_records;
create trigger daycare_records_forbid_owner_change
  before update on public.daycare_records
  for each row execute function public.forbid_owner_change();

drop trigger if exists pets_forbid_owner_change on public.pets;
create trigger pets_forbid_owner_change
  before update on public.pets
  for each row execute function public.forbid_owner_change();

drop trigger if exists tags_forbid_owner_change on public.tags;
create trigger tags_forbid_owner_change
  before update on public.tags
  for each row execute function public.forbid_owner_change();

drop trigger if exists feedback_forbid_owner_change on public.feedback;
create trigger feedback_forbid_owner_change
  before update on public.feedback
  for each row execute function public.forbid_owner_change();

drop trigger if exists share_links_forbid_owner_change on public.share_links;
create trigger share_links_forbid_owner_change
  before update on public.share_links
  for each row execute function public.forbid_owner_change();

-- ---------------------------------------------------------------
-- 4. 退出/削除の解禁（UC-H05/H06。最後の owner は D6 トリガが拒否）
-- ---------------------------------------------------------------
drop policy if exists "household_members_delete_owner" on public.household_members;
create policy "household_members_delete_owner"
  on public.household_members for delete
  using (public.has_household_role(household_id, array['owner']));

drop policy if exists "household_members_delete_self" on public.household_members;
create policy "household_members_delete_self"
  on public.household_members for delete
  using (user_id = auth.uid());
