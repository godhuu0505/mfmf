-- =============================================================
-- mfmf / Phase 3.5 S1 (Issue #92 手順7 後半 / #44, UC-M02) — tags / record_tags の household 共有
--
-- 定型タグ（tags）とタグ付け（record_tags）を世帯で共有できるようにする。
-- 方針は 20260630130100（バックフィル）/ 20260630140100（併存ポリシー）と同じ:
--   既存の owner_id ポリシーは不変更、household メンバー判定を *併存* で追加（加点のみ）。
--
--   - tags: household_id を nullable で追加し、既存行をオーナーの既定 household へ
--     バックフィル。世帯メンバーは互いのタグ辞書を参照・利用できる。
--   - record_tags: 列は追加しない。record_photos と同じく親 daycare_records の
--     household を「継承」して判定する（親に追随。乖離する複製列を作らない）。
--
-- 一意性について:
--   tags_owner_name_unique (owner_id, name) は維持する。世帯単位の一意制約
--   （household_id, name）は本 migration では *追加しない*。移行期は household_id が
--   クライアント書込み可能な未強制の列であり（20260630130100 の注記どおり）、他世帯の
--   ユーザーが owner 経路で任意の household_id を書けるため、世帯一意制約を先に張ると
--   「他世帯からの名前占有（見えないタグが insert を 23505 で弾く）」という DoS 経路が
--   開く。整合しない行（owner ∉ household）はメンバー判定 is_household_member により
--   一切可視化されないため実害はなく、世帯内の重複名はアプリ側の「参照してから作成」で
--   実用上防ぐ。DB 制約での一意化は、household_id の書き込みをメンバーシップ整合に
--   制約する後続スライス（S2 #46 以降）で行う。
--
-- 不変条件:
--   - 既存 tags_*_own / record_tags_*_own ポリシーは一切触れない（弱めない）。
--   - household_id は nullable のまま（NOT NULL 化の扱いは業務 4 表と同様に後続判断）。
--   - バックフィルは冪等（household_id is null の行のみ対象）。tags に updated_at は無い。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   drop policy if exists "record_tags_delete_member" on public.record_tags;
--   drop policy if exists "record_tags_insert_member" on public.record_tags;
--   drop policy if exists "record_tags_select_member" on public.record_tags;
--   drop policy if exists "tags_delete_member" on public.tags;
--   drop policy if exists "tags_update_member" on public.tags;
--   drop policy if exists "tags_insert_member" on public.tags;
--   drop policy if exists "tags_select_member" on public.tags;
--   alter table public.tags drop column if exists household_id;
-- =============================================================

-- ---------------------------------------------------------------
-- 1. tags へ household_id 列を追加（nullable）+ 索引
-- ---------------------------------------------------------------
alter table public.tags
  add column if not exists household_id uuid references public.households (id);

comment on column public.tags.household_id is '所属世帯（世帯共有のタグ辞書）。移行期は nullable';

create index if not exists tags_household_idx on public.tags (household_id);
-- 世帯辞書の名前引き（syncRecordTags の name 検索）用
create index if not exists tags_household_name_idx on public.tags (household_id, name);

-- ---------------------------------------------------------------
-- 2. バックフィル
--    tags のオーナーごとに既定 household を解決し（既存メンバーシップの再利用を優先、
--    無ければ作成）、household_id が null の行へ埋める。ロジック・タイブレークは
--    20260630130100 と同一（advisory lock のキーのみ本 migration の版数）。
--    通常は 20260630130100 で全オーナーがメンバーシップ済みのため、新規 household の
--    作成は「タグだけ持つオーナー」が存在した場合のセーフティネット。
-- ---------------------------------------------------------------
do $$
declare
  r  record;
  hh uuid;
begin
  perform pg_advisory_xact_lock(20260703120100);

  for r in
    select distinct owner_id
    from public.tags
    where owner_id is not null
      and household_id is null
  loop
    select m.household_id into hh
    from public.household_members m
    where m.user_id = r.owner_id
    order by (m.role = 'owner') desc, m.created_at, m.household_id
    limit 1;

    if hh is null then
      insert into public.households (name) values ('') returning id into hh;
      insert into public.household_members (household_id, user_id, role)
      values (hh, r.owner_id, 'owner')
      on conflict (household_id, user_id) do nothing;
    end if;

    update public.tags
      set household_id = hh
      where owner_id = r.owner_id and household_id is null;
  end loop;
end $$;

-- ---------------------------------------------------------------
-- 3. tags — owner_id ポリシーに household メンバー判定を併存追加
--    20260630140100 の pets 等と同型: メンバー判定は has_household_role(household_id)
--    に加え、行の owner がその household のメンバーであること
--    （is_household_member(household_id, owner_id)）も要求し、owner_id ⇄ household_id の
--    整合しない行（越境注入）をメンバー経路で一切可視・改変させない。
--    insert はさらに owner_id = auth.uid() を要求する（record_tags_insert_member と同型）。
--    owner_id は tags_owner_name_unique と auth.users への on delete cascade に効くため、
--    他メンバー名義でのタグ作成（名前空間の占有・他アカウントのライフサイクルへの
--    紐付け）をさせない。update は「共有辞書を他メンバーも編集できる」意味論
--    （daycare_records の *_member と同じ）を保つため owner 固定は課さないが、
--    with check の is_household_member により owner の付け替え先は同一世帯のメンバーに
--    限られる。delete も全メンバーに開く（role 別の絞り込みは S2 #46）。
-- ---------------------------------------------------------------
drop policy if exists "tags_select_member" on public.tags;
create policy "tags_select_member"
  on public.tags for select
  using (
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "tags_insert_member" on public.tags;
create policy "tags_insert_member"
  on public.tags for insert
  with check (
    owner_id = auth.uid()
    and public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "tags_update_member" on public.tags;
create policy "tags_update_member"
  on public.tags for update
  using (
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  )
  with check (
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  );

drop policy if exists "tags_delete_member" on public.tags;
create policy "tags_delete_member"
  on public.tags for delete
  using (
    public.has_household_role(household_id)
    and public.is_household_member(household_id, owner_id)
  );

-- ---------------------------------------------------------------
-- 4. record_tags — 親 daycare_records の household メンバーなら操作可（併存追加）
--    record_photos の *_member ポリシーと同型（親レコードの household / owner を継承し、
--    親についても owner ∈ household の整合を要求する）。
--    insert はさらに:
--      - owner_id = auth.uid()（「誰が付与したか」の帰属を偽装させない）
--      - タグが親レコードと同一 household の共有辞書に属し、タグ自体も owner ∈ household
--        の整合が取れていること（他世帯タグや越境注入タグの持ち込みを防ぐ）
--    を要求する。household_id が null のタグ/レコードはメンバー経路では常に不成立
--    （null 比較は false）となり、従来どおり owner 経路のみで扱われる。
-- ---------------------------------------------------------------
drop policy if exists "record_tags_select_member" on public.record_tags;
create policy "record_tags_select_member"
  on public.record_tags for select
  using (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_tags.record_id
        and public.has_household_role(r.household_id)
        and public.is_household_member(r.household_id, r.owner_id)
    )
  );

drop policy if exists "record_tags_insert_member" on public.record_tags;
create policy "record_tags_insert_member"
  on public.record_tags for insert
  with check (
    record_tags.owner_id = auth.uid()
    and exists (
      select 1 from public.daycare_records r
      where r.id = record_tags.record_id
        and public.has_household_role(r.household_id)
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
        and public.has_household_role(r.household_id)
        and public.is_household_member(r.household_id, r.owner_id)
    )
  );
