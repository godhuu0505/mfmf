-- =============================================================
-- mfmf / Phase 3.5 S2 (Issue #46) — RBAC その2: owner 経路 write の切替 + 世帯管理の RLS
--
-- S1〜S2-PR1 で「owner_id ポリシー」と「household メンバー（editor+）ポリシー」を
-- 併存させ、pgTAP で両立を検証してきた。本 migration で write を household ロール
-- 基準へ *切替*（owner_id ベースの write ポリシーを drop）し、あわせて世帯の
-- ロール管理（UC-A04 / UC-H04〜H06 のサーバー側基盤）を導入する。
--
--   1. 切替: 業務データの write は「世帯メンバー かつ role ∈ {owner, editor}」のみ。
--      viewer は owner 経路の抜け道（自分名義の行の作成等）も含めて write 不可になる
--      （UC-A01 の完全化）。select 系の owner ポリシーは残す（読み取りは弱めない）。
--      例外（意図して残す owner 経路 write）:
--        - feedback: ご意見・不具合の送信/編集は世帯データの編集権と別（viewer も可）
--        - tags_update_own: 移行期の未所属タグの世帯昇格（syncRecordTags）に必要
--        - storage の select_own / delete_own: 自分の旧規約オブジェクトの閲覧・片付け
--        - profiles / google_credentials / share_links: 個人スコープ（UC-M03。
--          share_links の発行は S2-PR1 で editor+ に限定済み）
--   2. household_members: メンバー一覧の世帯内共有（UC-H03）と owner による role 変更
--      （UC-H04）のポリシーを追加。insert / delete ポリシーは引き続き付けない
--      （メンバー化は S3 #45 の招待受諾のみ・自己昇格不可 UC-A05。退出/削除
--      UC-H05/H06 も、UC-H10 のための読取述語の緩和と一体で S3 #45 で解禁する）。
--   3. D6: 「世帯の owner は常に 1 人以上」をトリガでサーバー強制
--      （最後の owner の降格・削除・退出を拒否。世帯の孤児化防止）。
--   4. households.name の変更を owner に許可（UC-H02）。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   drop した *_own ポリシーを 20260616130704 / 20260616130709 / 20260616130710 の
--   定義で再作成し、本ファイルで追加したポリシー・トリガ・関数を drop する:
--     drop trigger if exists household_members_enforce_last_owner on public.household_members;
--     drop function if exists public.enforce_last_owner();
--     drop policy if exists "households_update_owner" on public.households;
--     drop policy if exists "household_members_select_member" on public.household_members;
--     drop policy if exists "household_members_update_owner" on public.household_members;
--   （tags_update_own / share_links_update_own は絞る前の定義 = 20260616130710 /
--     20260616130712 で再作成する。）
-- =============================================================

-- ---------------------------------------------------------------
-- 1. 切替: owner_id ベースの write ポリシーを drop
--    （アプリは S1 手順7 以降、全書き込みで household_id を必ずセット済み。
--      n=2 の全ユーザーはバックフィルで household 所属済みのため無停止）
-- ---------------------------------------------------------------
drop policy if exists "records_insert_own" on public.daycare_records;
drop policy if exists "records_update_own" on public.daycare_records;
drop policy if exists "records_delete_own" on public.daycare_records;

drop policy if exists "photos_insert_own" on public.record_photos;
drop policy if exists "photos_delete_own" on public.record_photos;

drop policy if exists "pets_insert_own" on public.pets;
drop policy if exists "pets_update_own" on public.pets;
drop policy if exists "pets_delete_own" on public.pets;

drop policy if exists "tags_insert_own" on public.tags;
drop policy if exists "tags_delete_own" on public.tags;
-- tags_update_own は「未所属タグの世帯昇格」専用に絞って作り直す。
-- 素の owner 更新を残すと、viewer に降格された作成者が共有タグを rename できてしまう。
-- USING で household_id IS NULL（昇格前の自分のタグ）に限定し、with check で
-- 昇格先を「自分が editor+ で属する世帯」（or null のまま）に限定する。
drop policy if exists "tags_update_own" on public.tags;
create policy "tags_update_own"
  on public.tags for update
  using (auth.uid() = owner_id and household_id is null)
  with check (
    auth.uid() = owner_id
    and (
      household_id is null
      or public.has_household_role(household_id, array['owner','editor'])
    )
  );

drop policy if exists "record_tags_insert_own" on public.record_tags;
drop policy if exists "record_tags_delete_own" on public.record_tags;

-- storage: 旧規約 {owner_id}/... への新規アップロードと owner 経路の削除を閉じる
-- （viewer 降格後も自分名義の旧オブジェクトを消せてしまう経路を塞ぐ。片付けは
--   editor+ の shared_owner 経路（記録の世帯単位）が担う。select_own は残す =
--   読み取りは弱めない。record を失った孤児オブジェクトの清掃は運用対応）
drop policy if exists "daycare_photos_insert_own" on storage.objects;
drop policy if exists "daycare_photos_delete_own" on storage.objects;

-- share_links: 既存リンクの更新は「editor+ の owner」か「revoke を伴う変更」のみに制限。
-- viewer に降格された発行者が期限延長などでリンクを開き直せないようにしつつ、
-- 失効（revoked_at を付ける更新）はいつでも本人が行える（露出を減らす操作は塞がない）。
drop policy if exists "share_links_update_own" on public.share_links;
create policy "share_links_update_own"
  on public.share_links for update
  using (auth.uid() = owner_id)
  with check (
    auth.uid() = owner_id
    and (
      revoked_at is not null
      or exists (
        select 1 from public.household_members m
        where m.user_id = auth.uid()
          and m.role in ('owner', 'editor')
      )
    )
  );

-- ---------------------------------------------------------------
-- 2. household_members — 一覧共有とロール管理
-- ---------------------------------------------------------------
-- UC-H03: 世帯メンバーは互いのメンバーシップ行（誰がどの role か）を見られる。
-- has_household_role は SECURITY DEFINER で household_members の RLS を迂回するため
-- 自己参照による再帰は起きない（既存 select_self は残す）。
drop policy if exists "household_members_select_member" on public.household_members;
create policy "household_members_select_member"
  on public.household_members for select
  using (public.has_household_role(household_id));

-- UC-H04: role の変更は owner のみ。household_id / user_id の付け替えはトリガで禁止。
drop policy if exists "household_members_update_owner" on public.household_members;
create policy "household_members_update_owner"
  on public.household_members for update
  using (public.has_household_role(household_id, array['owner']))
  with check (public.has_household_role(household_id, array['owner']));

-- メンバー削除（UC-H05）・本人退出（UC-H06）の delete ポリシーは本 migration では
-- *導入しない*（deny by default のまま）。退出/削除を解禁すると、退出者が作成した
-- 行がメンバー読取ポリシーの owner ∈ household 整合要求により世帯からも不可視になり、
-- UC-H10（退出メンバーの記録は世帯に残る）が破れるため。読み取り述語の整合要求の
-- 緩和（write が完全にメンバーシップ強制になった今、select 側の整合は不要になる）と
-- 退出/削除の解禁は S3（#45 招待・メンバー管理）で一体で行う。
-- D6 トリガの DELETE ガードは先行して入れておく（S3 解禁時にそのまま効く）。

-- ---------------------------------------------------------------
-- 3. D6: 最後の owner の降格・削除を禁止するトリガ（サーバー強制）
--    RLS では OLD 行との比較や集合条件（残 owner 数）を表現できないため、
--    BEFORE トリガで強制する。SECURITY DEFINER + search_path 固定で
--    household_members を RLS 迂回で数える（既存ヘルパーと同方針）。
--    合わせて membership の主キー相当（household_id / user_id）の付け替えも禁止し、
--    「owner 行を別世帯へ移して owner を消す」抜け道を塞ぐ。
-- ---------------------------------------------------------------
create or replace function public.enforce_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining integer;
begin
  if tg_op = 'UPDATE'
     and (new.household_id <> old.household_id or new.user_id <> old.user_id) then
    raise exception 'household_members の household_id / user_id は変更できません（行の削除と追加で表現してください）';
  end if;

  if (tg_op = 'DELETE' and old.role = 'owner')
     or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then
    -- 同一世帯の owner 数変更を直列化する（親 households 行のロック）。
    -- これが無いと、2 人の owner が同時に自分を降格/削除したとき互いに相手を
    -- 「残る owner」として数えてしまい、owner 0 人の世帯が生まれ得る。
    perform 1 from public.households h where h.id = old.household_id for update;
    select count(*) into remaining
    from public.household_members m
    where m.household_id = old.household_id
      and m.role = 'owner'
      and m.user_id <> old.user_id;
    if remaining = 0 then
      raise exception '世帯には最低 1 人の owner が必要です（最後の owner は降格・削除・退出できません / D6）';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function public.enforce_last_owner() is
  '世帯の owner 数 ≥ 1 を強制する（D6・世帯の孤児化防止）。household_id / user_id の付け替えも禁止。SECURITY DEFINER + search_path 固定。';

revoke all on function public.enforce_last_owner() from public;

drop trigger if exists household_members_enforce_last_owner on public.household_members;
create trigger household_members_enforce_last_owner
  before update or delete on public.household_members
  for each row execute function public.enforce_last_owner();

-- ---------------------------------------------------------------
-- 4. households — 世帯名の設定・変更を owner に許可（UC-H02）
-- ---------------------------------------------------------------
drop policy if exists "households_update_owner" on public.households;
create policy "households_update_owner"
  on public.households for update
  using (public.has_household_role(id, array['owner']))
  with check (public.has_household_role(id, array['owner']));
