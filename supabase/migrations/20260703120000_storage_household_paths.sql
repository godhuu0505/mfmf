-- =============================================================
-- mfmf / Phase 3.5 S1 (Issue #92 手順8 / #44, UC-M01) — Storage パスの household 化
--
-- オブジェクトパス規約を {owner_id}/{record_id}/{filename} から
-- {household_id}/{record_id}/{filename} へ移行する。方針はこれまでの S1 PR と同じ
-- 「既存 owner ポリシーは不変更・household 判定を *併存* で追加（加点のみ）」:
--
--   - 新規アップロード（アプリ側 20260703 以降のコード）は {household_id}/... に書く。
--   - 既存オブジェクト（{owner_id}/...）は移動しない。Storage オブジェクトの実体移動は
--     SQL では安全に行えず（storage.objects.name の直接 UPDATE はバックエンドの実体と
--     乖離する）、storage API の move が必要なため、本 migration は「旧パスを世帯
--     メンバーが読める」ポリシーを併存させて無停止で両立する。
--   - 旧コード（デプロイ窓の間）による {owner_id}/... への書き込みも従来ポリシーで
--     そのまま成立する（無停止・後方互換）。
--
-- 追加するポリシー（bucket: daycare-photos, 対象 storage.objects）:
--   ① household パス（新規約）: 先頭セグメント = 自分がメンバーの household_id
--        select / insert / delete を許可（テーブル側の *_member ポリシーと同粒度。
--        role 別の絞り込みは S2 RBAC #46 で has_household_role(allowed_roles) に絞る）。
--   ② owner パス（旧規約）: 先頭セグメント = 「自分と同一 household に属するユーザー」の id
--        select / delete のみ許可（世帯メンバーが旧写真を閲覧・記録削除時に片付けられる
--        ように）。insert は許可しない（他人の owner プレフィックス配下への新規作成は
--        させない。本人の旧規約 insert は既存 daycare_photos_insert_own が引き続き許可）。
--
-- パス先頭セグメントは信頼できない入力なので、uuid へ安全にキャストする
-- try_cast_uuid() を用意する（不正値は null → 各判定関数は false を返す）。
-- AND / OR の評価順序に依存した ::uuid キャストはエラーで全体を落とすため使わない。
--
-- 不変条件:
--   - 既存の daycare_photos_{select,insert,delete}_own ポリシーは一切触れない（弱めない）。
--   - バケットは private のまま。配信は署名付き URL（署名発行に select RLS が必要）。
--   - Service Worker が private / 期限付き URL をキャッシュしない不変条件はアプリ側で維持。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   drop policy if exists "daycare_photos_delete_shared_owner" on storage.objects;
--   drop policy if exists "daycare_photos_select_shared_owner" on storage.objects;
--   drop policy if exists "daycare_photos_delete_household" on storage.objects;
--   drop policy if exists "daycare_photos_insert_household" on storage.objects;
--   drop policy if exists "daycare_photos_select_household" on storage.objects;
--   drop function if exists public.shares_household_with(uuid);
--   drop function if exists public.try_cast_uuid(text);
--   （アプリ側も {owner_id}/... 生成へ戻すこと。household パスで作成済みのオブジェクトは
--     旧 own ポリシーでは不可視になるため、戻す前に有無を確認する。）
-- =============================================================

-- ---------------------------------------------------------------
-- 1. ヘルパー: text → uuid の安全キャスト
--    パス先頭セグメントはユーザー入力由来（アップロード時に任意のパスを名乗れる）。
--    ポリシー式の中で裸の ::uuid キャストを使うと不正値で 22P02 エラーになり
--    クエリ全体が落ちるため、失敗時は null を返す関数に閉じ込める。
--    テーブル参照なしの純関数（SECURITY INVOKER）。search_path 固定は既存方針に合わせる。
-- ---------------------------------------------------------------
create or replace function public.try_cast_uuid(value text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return value::uuid;
exception
  when invalid_text_representation then
    return null;
end;
$$;

comment on function public.try_cast_uuid(text) is
  'text を uuid へ安全にキャストする（不正な形式は null）。Storage パス先頭セグメントの検証など、エラーで式全体を落とせない RLS ポリシー内で使う。';

revoke all on function public.try_cast_uuid(text) from public;
grant execute on function public.try_cast_uuid(text) to authenticated, service_role;

-- ---------------------------------------------------------------
-- 2. ヘルパー: 呼び出しユーザーが target_user と同一 household を共有しているか
--    旧規約 {owner_id}/... のオブジェクトを「その owner と同じ世帯のメンバー」に開放する
--    判定。has_household_role / is_household_member と同じく SECURITY DEFINER +
--    search_path 固定で household_members の RLS を迂回する（boolean のみ返し、
--    他ユーザーのメンバーシップ情報は漏らさない）。
--    target_user = auth.uid() 自身の場合も「共に属する世帯が 1 つでもあれば」true に
--    なるが、本人アクセスは既存 own ポリシーが常に許可するため差は生じない。
-- ---------------------------------------------------------------
create or replace function public.shares_household_with(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.household_members me
    join public.household_members them
      on them.household_id = me.household_id
    where me.user_id = auth.uid()
      and them.user_id = target_user
  );
$$;

comment on function public.shares_household_with(uuid) is
  '呼び出しユーザー(auth.uid())が target_user と同一 household に属しているかを返す。旧規約 {owner_id}/... の Storage オブジェクトを世帯メンバーへ開放する判定に使う。SECURITY DEFINER + search_path 固定。';

revoke all on function public.shares_household_with(uuid) from public;
grant execute on function public.shares_household_with(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------
-- 3. 新規約 {household_id}/{record_id}/{filename} のポリシー（併存追加）
--    先頭セグメントが「自分がメンバーの household」なら select / insert / delete 可。
--    先頭セグメントが uuid でない・存在しない household の場合、try_cast_uuid /
--    has_household_role が null / false を返すため単に不成立になる（エラーにしない）。
-- ---------------------------------------------------------------
drop policy if exists "daycare_photos_select_household" on storage.objects;
create policy "daycare_photos_select_household"
  on storage.objects for select
  using (
    bucket_id = 'daycare-photos'
    and public.has_household_role(public.try_cast_uuid((storage.foldername(name))[1]))
  );

drop policy if exists "daycare_photos_insert_household" on storage.objects;
create policy "daycare_photos_insert_household"
  on storage.objects for insert
  with check (
    bucket_id = 'daycare-photos'
    and public.has_household_role(public.try_cast_uuid((storage.foldername(name))[1]))
  );

drop policy if exists "daycare_photos_delete_household" on storage.objects;
create policy "daycare_photos_delete_household"
  on storage.objects for delete
  using (
    bucket_id = 'daycare-photos'
    and public.has_household_role(public.try_cast_uuid((storage.foldername(name))[1]))
  );

-- ---------------------------------------------------------------
-- 4. 旧規約 {owner_id}/{record_id}/{filename} の世帯メンバー開放（併存追加）
--    先頭セグメント（= オブジェクト owner の user id）と同一 household に属していれば
--    select / delete 可。既存オブジェクトを移動せずに、世帯メンバーの閲覧
--    （署名付き URL の発行）と記録削除時のオブジェクト片付けを成立させる。
--    insert は追加しない（他人の owner プレフィックスへの新規作成を開けない）。
-- ---------------------------------------------------------------
drop policy if exists "daycare_photos_select_shared_owner" on storage.objects;
create policy "daycare_photos_select_shared_owner"
  on storage.objects for select
  using (
    bucket_id = 'daycare-photos'
    and public.shares_household_with(public.try_cast_uuid((storage.foldername(name))[1]))
  );

drop policy if exists "daycare_photos_delete_shared_owner" on storage.objects;
create policy "daycare_photos_delete_shared_owner"
  on storage.objects for delete
  using (
    bucket_id = 'daycare-photos'
    and public.shares_household_with(public.try_cast_uuid((storage.foldername(name))[1]))
  );
