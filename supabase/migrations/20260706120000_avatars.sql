-- =============================================================
-- mfmf / アバター画像（ペット / 世帯 / ユーザー）
--
-- 各エンティティに任意のアバター画像を持たせる。画像本体は private な
-- Storage バケット `avatars` に置き、テーブルにはオブジェクトパスだけを保存する
-- （既存の record_photos.storage_path と同じ方針。配信は署名付き URL）。
--
-- スコープ設計（既存 RLS の粒度に合わせる。弱めない・加点のみ）:
--   - pets.avatar_path       … 世帯共有（pets は household メンバーで共有される）
--   - households.avatar_path … 世帯共有（世帯の識別子。世帯名と同じ扱い）
--   - profiles.avatar_path   … 個人スコープ（profiles は owner_id = auth.uid() のみ）
--
-- Storage パス規約: {scope_id}/avatars/{uuid}-{filename}
--   scope_id は pet/household アバターでは household_id、user アバターでは owner_id。
--   先頭セグメントが「自分の uid」または「自分がメンバーの household_id」のときだけ
--   select / insert / delete を許可する（daycare-photos の household ポリシーと同型）。
--   先頭セグメントはユーザー入力由来なので try_cast_uuid で安全にキャストする
--   （20260703120000_storage_household_paths.sql で定義済み。不正値は null → 不成立）。
--
-- 不変条件:
--   - バケットは private のまま。配信は署名付き URL（署名発行に select RLS が必要）。
--   - Service Worker は private / 期限付き URL をキャッシュしない（アプリ側で維持）。
--   - 既存の daycare-photos ポリシー / owner_id ポリシーは一切触れない（弱めない）。
--   - 追加は列 3 本 + 新バケット + 新バケット用ポリシーのみ（後方互換・無停止）。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   drop policy if exists "avatars_select_scope" on storage.objects;
--   drop policy if exists "avatars_insert_scope" on storage.objects;
--   drop policy if exists "avatars_delete_scope" on storage.objects;
--   delete from storage.buckets where id = 'avatars';   -- オブジェクトを空にしてから
--   alter table public.pets       drop column if exists avatar_path;
--   alter table public.households drop column if exists avatar_path;
--   alter table public.profiles   drop column if exists avatar_path;
-- =============================================================

-- ---------------------------------------------------------------
-- 1. 各テーブルに avatar_path 列を追加（nullable・既定 null）
-- ---------------------------------------------------------------
alter table public.pets       add column if not exists avatar_path text;
alter table public.households add column if not exists avatar_path text;
alter table public.profiles   add column if not exists avatar_path text;

comment on column public.pets.avatar_path       is 'avatars バケット内のアバター画像パス（任意・null=未設定）。世帯で共有。';
comment on column public.households.avatar_path is 'avatars バケット内の世帯アバター画像パス（任意・null=未設定）。';
comment on column public.profiles.avatar_path   is 'avatars バケット内のユーザーアバター画像パス（任意・null=未設定）。個人スコープ。';

-- ---------------------------------------------------------------
-- 2. Storage バケット: avatars (private)
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------
-- 3. Storage RLS: 先頭セグメントが自分の uid または自分がメンバーの household
--    パス規約 {scope_id}/avatars/{filename} の先頭 scope_id で判定する。
--    - user アバター: scope_id = owner_id（= auth.uid()）→ 第1条件で成立。
--    - pet / household アバター: scope_id = household_id → has_household_role で成立。
--    先頭セグメントが uuid でない / 非メンバー household の場合は try_cast_uuid /
--    has_household_role が null / false を返し単に不成立になる（エラーにしない）。
--    update は使わない（アバター変更は「新規 insert + 旧 delete」で行う）ため付けない。
-- ---------------------------------------------------------------
drop policy if exists "avatars_select_scope" on storage.objects;
create policy "avatars_select_scope"
  on storage.objects for select
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.has_household_role(public.try_cast_uuid((storage.foldername(name))[1]))
    )
  );

drop policy if exists "avatars_insert_scope" on storage.objects;
create policy "avatars_insert_scope"
  on storage.objects for insert
  with check (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.has_household_role(public.try_cast_uuid((storage.foldername(name))[1]))
    )
  );

drop policy if exists "avatars_delete_scope" on storage.objects;
create policy "avatars_delete_scope"
  on storage.objects for delete
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.has_household_role(public.try_cast_uuid((storage.foldername(name))[1]))
    )
  );
