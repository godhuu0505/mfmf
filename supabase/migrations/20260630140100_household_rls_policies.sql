-- =============================================================
-- mfmf / Phase 3.5 S1 (Issue #92 手順4 / #44) — household メンバー判定 RLS を併存追加
--
-- 各業務テーブルの RLS に「household メンバーなら通る」ポリシーを *併存* で追加する。
-- 既存の owner_id (= auth.uid()) ポリシーは削除・改変しない（移行期は弱めない）。
--
-- PostgreSQL の RLS は同一コマンドに対する複数の PERMISSIVE ポリシーを OR で結合する。
-- よって各操作は「owner_id 一致（既存）」 OR 「household メンバー（本追加）」のどちらでも
-- 通る状態になる。本スライスの既存データは owner 自身の household に属するため、既存
-- owner 経由アクセスは従来どおり成立し、アプリ挙動は変わらない（新ポリシーは加点のみ）。
--
-- 対象テーブル（household_id を持つ業務データ。20260630130100 で追加・バックフィル済み）:
--   daycare_records / record_photos / feedback / pets
-- 対象外（owner_id のまま。household 共有の是非は #44 後半で判断）:
--   profiles / google_credentials / tags / record_tags / share_links
--
-- メンバー判定は public.has_household_role(household_id)（SECURITY DEFINER・
-- search_path 固定・20260630140000 で定義）を用いる。NULL を渡す（= allowed_roles 未指定）
-- ことで「当該 household のメンバーか否か」だけを見る。household_id が NULL の行では
-- has_household_role は false を返すため、その行は従来どおり owner_id ポリシーのみで
-- 守られる（移行期の nullable と整合）。
--
-- ★ owner_id ⇄ household_id の整合強制（越境防止の要）:
--   household_id と owner_id はどちらも移行期はクライアント書込み可能な列であり、本 PR は
--   owner_id ベースの insert/update ポリシーを変更しない。メンバー判定が household_id 単独を
--   信用すると、以下の越境経路が開く:
--     (a) メンバーが既存行の owner_id を別 household のユーザーへ付け替え、その外部ユーザーが
--         旧 owner_id ポリシー (records_select_own 等) 経由で当該行を読めてしまう。
--     (b) 自分の行の household_id を他 household の UUID にして、その household のメンバー可視
--         クエリへ注入する。
--   これを塞ぐため、メンバー判定ポリシーは「呼び出しユーザーが household のメンバー」
--   (has_household_role) に加え「行の owner_id がその household のメンバー」
--   (is_household_member(household_id, owner_id)) も要求する。owner と household が整合しない
--   行はメンバー経路では一切可視・改変・作成されない（owner 自身の owner_id ポリシー経由の
--   アクセスだけが残る＝従来どおり・弱めない）。
--
-- 不変条件:
--   - 既存 owner_id ポリシーは本ファイルで一切触れない（drop / 再定義しない）。
--   - record_photos は owner_id を持たないため、親 daycare_records の household / owner を継承して
--     判定する（既存 owner ポリシーが親の owner_id を見るのと同じ構造）。
--   - daycare_records の insert/update は、既存 owner ポリシー同様に pet 越境を防ぐため
--     「pet_id が指す pet も *そのレコードと同じ household* のものか」を追加検証する
--     （他テナントの pet を参照する記録を household 経由で作らせない）。外側の with check で
--     既に「レコードの household のメンバーか」を要求しているので、pet をレコードと同一
--     household に縛れば pet のメンバー性も推移的に担保され、判定が単純かつ厳密になる。
--
-- ロールバック手順（本 migration を取り消す場合）: 本ファイルで作成した *_member
--   ポリシーのみを drop する（owner_id ポリシーは残す）。各 create policy に
--   対応する drop policy if exists を流せばよい。
-- =============================================================

-- ---------------------------------------------------------------
-- 1. daycare_records — owner_id ポリシーに household メンバー判定を併存追加
-- ---------------------------------------------------------------
drop policy if exists "records_select_member" on public.daycare_records;
create policy "records_select_member"
  on public.daycare_records for select
  using (
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "records_insert_member" on public.daycare_records;
create policy "records_insert_member"
  on public.daycare_records for insert
  with check (
    public.has_household_role(household_id)
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
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  )
  with check (
    public.has_household_role(household_id)
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
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  );

-- ---------------------------------------------------------------
-- 2. record_photos — 親 daycare_records の household メンバーなら操作可
--    （owner_id を持たない子テーブル。既存 owner ポリシーが親の owner_id を
--     見るのと同じく、親レコードの household / owner を継承して判定する）。
--    init.sql には select / insert / delete のみ存在し update ポリシーは無いので、
--    併存ポリシーも同じ 3 操作のみ追加する。親レコードについても
--    owner ∈ household の整合（is_household_member）を要求し、整合しない親に
--    紐づく写真はメンバー経路で可視化させない。
-- ---------------------------------------------------------------
drop policy if exists "photos_select_member" on public.record_photos;
create policy "photos_select_member"
  on public.record_photos for select
  using (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_photos.record_id
        and public.has_household_role(r.household_id)
        and public.is_household_member(r.household_id, r.owner_id)
    )
  );

drop policy if exists "photos_insert_member" on public.record_photos;
create policy "photos_insert_member"
  on public.record_photos for insert
  with check (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_photos.record_id
        and public.has_household_role(r.household_id)
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
        and public.has_household_role(r.household_id)
        and public.is_household_member(r.household_id, r.owner_id)
    )
  );

-- ---------------------------------------------------------------
-- 3. feedback — owner_id ポリシーに household メンバー判定を併存追加
-- ---------------------------------------------------------------
drop policy if exists "feedback_select_member" on public.feedback;
create policy "feedback_select_member"
  on public.feedback for select
  using (
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "feedback_insert_member" on public.feedback;
create policy "feedback_insert_member"
  on public.feedback for insert
  with check (
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "feedback_update_member" on public.feedback;
create policy "feedback_update_member"
  on public.feedback for update
  using (
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  )
  with check (
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "feedback_delete_member" on public.feedback;
create policy "feedback_delete_member"
  on public.feedback for delete
  using (
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  );

-- ---------------------------------------------------------------
-- 4. pets — owner_id ポリシーに household メンバー判定を併存追加
-- ---------------------------------------------------------------
drop policy if exists "pets_select_member" on public.pets;
create policy "pets_select_member"
  on public.pets for select
  using (
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "pets_insert_member" on public.pets;
create policy "pets_insert_member"
  on public.pets for insert
  with check (
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "pets_update_member" on public.pets;
create policy "pets_update_member"
  on public.pets for update
  using (
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  )
  with check (
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "pets_delete_member" on public.pets;
create policy "pets_delete_member"
  on public.pets for delete
  using (
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  );
