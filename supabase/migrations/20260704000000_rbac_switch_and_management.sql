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
--   2. household_members: メンバー一覧の世帯内共有（UC-H03）、owner による role 変更
--      （UC-H04）とメンバー削除（UC-H05）、本人退出（UC-H06）のポリシーを追加。
--      insert ポリシーは引き続き付けない（招待受諾のみでメンバー化 = S3 #45。
--      自己昇格不可 UC-A05 は deny by default のまま）。
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
--     drop policy if exists "household_members_delete_owner" on public.household_members;
--     drop policy if exists "household_members_delete_self" on public.household_members;
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
-- tags_update_own は残す（未所属タグの世帯昇格に必要。上記ヘッダー参照）

drop policy if exists "record_tags_insert_own" on public.record_tags;
drop policy if exists "record_tags_delete_own" on public.record_tags;

-- storage: 旧規約 {owner_id}/... への新規アップロード経路を閉じる
-- （household 未所属ユーザーはアップロード不可になる = 業務表の write と同じ扱い。
--   select_own / delete_own は自分の旧オブジェクトの閲覧・片付けのため残す）
drop policy if exists "daycare_photos_insert_own" on storage.objects;

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

-- UC-H05: メンバー削除は owner のみ / UC-H06: 本人はいつでも退出可（いずれも D6 で保護）。
drop policy if exists "household_members_delete_owner" on public.household_members;
create policy "household_members_delete_owner"
  on public.household_members for delete
  using (public.has_household_role(household_id, array['owner']));

drop policy if exists "household_members_delete_self" on public.household_members;
create policy "household_members_delete_self"
  on public.household_members for delete
  using (user_id = auth.uid());

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
