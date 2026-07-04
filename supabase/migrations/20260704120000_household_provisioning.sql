-- =============================================================
-- mfmf / Phase 3.5 S5 (Issue #47) — 世帯プロビジョニング（D7 / UC-O03）
--
-- D7:「セルフサインアップは『新世帯作成で owner 化』と『招待受諾で既存世帯参加』の
--     両導線。登録直後に world が 0 個にならない」
--
-- これまで世帯はバックフィル migration（20260630130100）でのみ作られており、
-- それ以降に初回ログインしたユーザーは世帯を持てない（households /
-- household_members は insert deny by default）。household_id の NOT NULL 化
--（20260703160000）以降、未所属ユーザーは記録・ペットを一切作成できないため、
-- 本 migration で「未所属ユーザーが自分の新世帯を作成して owner になる」唯一の
-- 経路 create_own_household を追加する。
--   - 招待受諾（accept_household_invite）と並ぶ、household_members へ書ける
--     2 つ目の SECURITY DEFINER 経路。RLS ポリシー自体は一切変更しない
--     （直接 insert は引き続き deny by default = 自己昇格不可 UC-A05）。
--   - 所属ゼロのユーザーのみ作成可。既に世帯を持つユーザーの追加世帯作成は
--     解禁しない（多世帯参加は招待受諾 UC-H07 のみ。世帯の乱造を防ぐ）。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   drop function if exists public.create_own_household(text);
-- =============================================================

create or replace function public.create_own_household(p_name text default '')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'ログインが必要です' using errcode = '42501';
  end if;

  -- ユーザー単位で直列化する（二重送信・並行タブで世帯が 2 つできるレース防止。
  -- accept_household_invite と同じキー体系で、招待受諾との並行実行も直列化する）。
  perform pg_advisory_xact_lock(hashtext('accept_household_invite:' || v_uid::text));

  -- 所属ゼロのユーザー専用（オンボーディング導線）。既にどこかの世帯に所属して
  -- いる場合は作成させない（追加参加は招待受諾のみ）。
  if exists (
    select 1 from public.household_members m where m.user_id = v_uid
  ) then
    raise exception '既に世帯に所属しています（新しい世帯への参加は招待から行えます）'
      using errcode = 'P0001';
  end if;

  insert into public.households (name)
  values (coalesce(trim(p_name), ''))
  returning id into v_id;

  insert into public.household_members (household_id, user_id, role)
  values (v_id, v_uid, 'owner');

  return v_id;
end;
$$;

comment on function public.create_own_household(text) is
  '未所属ユーザーが新世帯を作成して owner になる唯一の経路（D7 / UC-O03）。所属ゼロの場合のみ作成可。SECURITY DEFINER + search_path 固定。';

revoke all on function public.create_own_household(text) from public;
grant execute on function public.create_own_household(text) to authenticated;
