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
--   ② owner パス（旧規約）: パス規約 {owner_id}/{record_id}/{filename} の第2セグメント
--        （record_id）を daycare_records に突き合わせ、「その記録が属する household の
--        メンバー」にのみ select / delete を許可（record_photos の *_member ポリシーと
--        同型）。オブジェクト単位ではなく「記録の世帯」単位で判定することで、複数世帯
--        モデル（D1）でも owner が別世帯に持つ記録の写真へは越境できない。
--        insert は許可しない（他人の owner プレフィックス配下への新規作成はさせない。
--        本人の旧規約 insert は既存 daycare_photos_insert_own が引き続き許可）。
--
-- パスのセグメントは信頼できない入力なので、uuid へ安全にキャストする
-- try_cast_uuid() を用意する（不正値は null → 各判定は単に不成立になる）。
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
-- 2. 新規約 {household_id}/{record_id}/{filename} のポリシー（併存追加）
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
-- 3. 旧規約 {owner_id}/{record_id}/{filename} の世帯メンバー開放（併存追加）
--    第2セグメント（record_id）が指す daycare_records の household のメンバーであり、
--    かつ第1セグメント（owner_id）がその記録の owner と一致する場合に select / delete 可
--    （record_photos の *_member ポリシーと同型。親レコードの owner ∈ household 整合も
--    要求する）。既存オブジェクトを移動せずに、世帯メンバーの閲覧（署名付き URL の発行）
--    と記録削除時のオブジェクト片付けを成立させる。
--    「owner とどこかの世帯を共有しているか」ではなく「その記録の世帯のメンバーか」で
--    判定するのが要点: 複数世帯モデル（D1）で owner が別世帯に持つ記録の写真や、
--    記録が消えた孤児オブジェクトへは開かない（本人の own ポリシーのみ残る）。
--    insert は追加しない（他人の owner プレフィックスへの新規作成を開けない）。
-- ---------------------------------------------------------------
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
        and public.is_household_member(r.household_id, r.owner_id)
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
        and public.has_household_role(r.household_id)
        and public.is_household_member(r.household_id, r.owner_id)
    )
  );
