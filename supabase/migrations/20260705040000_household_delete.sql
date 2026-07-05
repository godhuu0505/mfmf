-- =============================================================
-- mfmf / Phase 3.5 フォローアップ (Issue #117 §3) — 世帯削除の UX（UC-H09）第一歩
--
-- 現状: 業務テーブル（daycare_records / record_photos / pets / tags / feedback /
--   household_invites / guest_grants）は households を ON DELETE NO ACTION で参照するため、
--   参照データのある世帯は削除できない（孤児化防止）。一方、household_members は
--   ON DELETE CASCADE で、世帯を消すと owner 行も一緒に消えるが、D6 トリガ
--   （enforce_last_owner）が「最後の owner の削除」を拒否するため、そのままでは
--   空の世帯すら削除できない。
--
-- 本 migration の範囲（UC-H09 の安全な部分集合）:
--   owner が「参照データの無い世帯」を削除できるようにする。
--   - オンボーディングで世帯を作ったがペットを登録せず放置した、招待で作った予備の
--     世帯を畳む、といった “空の世帯の後始末” が対象。
--   - **データ（記録・写真・ペット・タグ・フィードバック・招待・ゲスト付与）や、
--     世帯プレフィックス配下の Storage オブジェクト（DB 行の無い孤児写真を含む）が
--     ある世帯の削除は本 migration では扱わない**。エクスポート後のカスケード削除・
--     Storage の完全消去・確認/猶予/監査は #51（Phase 5・データエクスポート/
--     アカウント削除）で設計する。RPC は参照データ/オブジェクトを検出したら拒否する。
--
-- 設計:
--   1. delete_own_household(uuid) SECURITY DEFINER RPC:
--      - 空判定より前に対象 households 行を FOR UPDATE でロックし、FK を持つ子テーブルへの
--        同時 insert（親行の FOR KEY SHARE を要する）と直列化する（check→delete をアトミック化）。
--      - 呼び出し元が対象世帯の owner であることを RLS 迂回で厳格判定。
--      - 参照データが 1 行でもあれば拒否（P0001。UI が #51 待ちの案内を出す）。
--      - トランザクション局所の GUC `mfmf.deleting_household` に対象 household_id を
--        セットしてから households を delete（household_members は cascade）。
--   2. enforce_last_owner（D6）トリガに “世帯ごと削除中” のガードを追加:
--      GUC が対象 household と一致する DELETE のときだけ最後の owner 保護を素通りさせる。
--      GUC は SECURITY DEFINER の RPC からしかセットできず、PostgREST 経由のクライアントは
--      任意の GUC を設定できないため、通常のメンバー退出/削除（GUC 未設定）では D6 は
--      従来どおり最後の owner を守る（＝抜け道にならない）。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   drop function if exists public.delete_own_household(uuid);
--   enforce_last_owner を 20260704000000 の定義（ガード無し）で create or replace する。
-- =============================================================

-- ---------------------------------------------------------------
-- 1. D6 トリガにガードを追加（世帯ごと削除中は最後の owner 保護を無効化）
--    20260704000000 の定義に、先頭のガード分岐だけを足した版。
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
  -- 世帯そのものの削除（delete_own_household RPC 経由）では、cascade で消える owner 行に
  -- 対して「最低 1 人の owner」を要求しない（世帯が消えるので守るべき世帯が無い）。
  -- GUC は当該 RPC だけがセットする（クライアントからは設定不能）。household_id 一致で限定。
  if tg_op = 'DELETE'
     and nullif(current_setting('mfmf.deleting_household', true), '') = old.household_id::text then
    return old;
  end if;

  if tg_op = 'UPDATE'
     and (new.household_id <> old.household_id or new.user_id <> old.user_id) then
    raise exception 'household_members の household_id / user_id は変更できません（行の削除と追加で表現してください）';
  end if;

  if (tg_op = 'DELETE' and old.role = 'owner')
     or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then
    -- 同一世帯の owner 数変更を直列化する（親 households 行のロック）。
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
  '世帯の owner 数 ≥ 1 を強制する（D6・世帯の孤児化防止）。ただし delete_own_household 経由の世帯ごと削除（GUC mfmf.deleting_household 一致）は素通りさせる。household_id / user_id の付け替えも禁止。SECURITY DEFINER + search_path 固定。';

-- トリガ本体は 20260704000000 で作成済み（before update or delete）。関数差し替えのみ。

-- ---------------------------------------------------------------
-- 2. 世帯削除 RPC（owner のみ・参照データ無しのみ）
-- ---------------------------------------------------------------
create or replace function public.delete_own_household(p_household_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'ログインが必要です' using errcode = '42501';
  end if;

  -- 空判定より前に世帯行をロックし、チェック→削除を FK 子テーブルに対してアトミックにする。
  -- FK を持つ子テーブル（pets / daycare_records / record_photos / tags / feedback /
  -- household_invites / guest_grants）への同時 insert は親 households 行の FOR KEY SHARE を
  -- 要するため、この FOR UPDATE と競合してブロックされる。これにより「空判定の後・本 delete の
  -- コミット前」に別トランザクションが子行を差し込む余地が無くなる（例: 別 owner が同時に発行した
  -- 招待は household_id が ON DELETE CASCADE のため、放置すると silently 巻き込み削除され得た）。
  -- ロックを先に取った側が勝ち: delete が先ならその後の子 insert は FK 違反で失敗し、子 insert が
  -- 先ならロック解放後の空判定がその行を見て P0001 で拒否する。
  -- ※ storage.objects は households への FK を持たずこのロックの影響を受けないため、そちらの
  --    time-of-check レースだけは別途 #51（Storage API 経由の掃引）に委ねる（下記）。
  perform 1 from public.households where id = p_household_id for update;

  -- 呼び出し元が対象世帯の owner か（RLS 迂回で厳格判定）。
  if not exists (
    select 1 from public.household_members m
    where m.household_id = p_household_id
      and m.user_id = v_uid
      and m.role = 'owner'
  ) then
    raise exception 'この世帯を削除できるのは owner だけです' using errcode = '42501';
  end if;

  -- 参照データのある世帯は削除しない（孤児化防止）。1 行でもあれば拒否。
  -- 完全削除（エクスポート後のカスケード削除・Storage 消去）は #51 で扱う。
  --
  -- Storage も確認する: 写真は Server Action が record_photos 行を作る *前に*
  -- クライアントから {household_id}/{record_id}/... へ直接アップロードされる。
  -- アップロード成功後に後続の書き込みが失敗/中断すると、DB 行ゼロでも世帯
  -- プレフィックス配下に孤児オブジェクトが残り得る。この状態で世帯を消すと
  -- メンバーシップが cascade で消え、新規約 Storage ポリシー（has_household_role
  -- 依存）により以後その private ファイルを誰も select/delete できなくなる。
  -- よって世帯プレフィックスに 1 つでもオブジェクトが残っていれば削除を拒否する
  -- （SQL で storage.objects 行を消すと S3 実体が孤児化するため、消さずに拒否して
  --  Storage API 経由の後始末＝#51 へ委ねる）。
  --
  -- 【既知の限界 / 残存レース（Storage のみ）】上の FOR UPDATE ロックで FK を持つ子テーブルの
  -- 同時 insert は直列化されるが、Storage は別。この Storage チェックは時点読み取りである。
  -- storage.objects は households への FK を持たず、アップロードの insert ポリシー（has_household_role）は
  -- READ COMMITTED 下で本 delete がコミットするまで旧 household_members を見られる。
  -- そのため「本チェックの後・本 delete のコミット前」に別トランザクションが
  -- {household_id}/... へアップロードすると、その 1 オブジェクトはメンバー cascade 後も
  -- 残り、同種の孤児になり得る。これを確実に塞ぐには全メンバーシップ判定
  -- （has_household_role = アプリ全体のホットパス）にロックを足す必要があり、極めて稀な
  -- 事象（空世帯の削除と同世帯へのアップロードの同時実行）に対して割に合わない。
  -- 権威ある孤児クリーンアップ（このレース分を含む）は #51 の完了条件
  -- 「削除後に孤児 Storage オブジェクトが無い」＝Storage API 経由の掃引に委ねる。
  if exists (select 1 from public.pets              where household_id = p_household_id)
     or exists (select 1 from public.daycare_records  where household_id = p_household_id)
     or exists (select 1 from public.record_photos    where household_id = p_household_id)
     or exists (select 1 from public.tags             where household_id = p_household_id)
     or exists (select 1 from public.feedback         where household_id = p_household_id)
     or exists (select 1 from public.household_invites where household_id = p_household_id)
     or exists (select 1 from public.guest_grants     where household_id = p_household_id)
     or exists (
          select 1 from storage.objects o
          where o.bucket_id = 'daycare-photos'
            and (storage.foldername(o.name))[1] = p_household_id::text
        ) then
    raise exception 'データのある世帯は削除できません。記録・写真・ペットなどのエクスポート後に削除する導線は準備中です（#51）'
      using errcode = 'P0001';
  end if;

  -- D6 トリガへ「世帯ごと削除中」を通知（この txn 限り・当該 household に限定）。
  perform set_config('mfmf.deleting_household', p_household_id::text, true);
  -- household_members は ON DELETE CASCADE。参照データが無いことは上で確認済み。
  delete from public.households where id = p_household_id;
  -- ガードを畳む（同一 txn 内で後続処理があっても影響させない）。
  perform set_config('mfmf.deleting_household', '', true);
end;
$$;

comment on function public.delete_own_household(uuid) is
  'owner が参照データの無い世帯を削除する（UC-H09 の部分集合）。データのある世帯は拒否（#51 で対応）。SECURITY DEFINER + search_path 固定。';

revoke all on function public.delete_own_household(uuid) from public;
grant execute on function public.delete_own_household(uuid) to authenticated;
