-- =============================================================
-- mfmf / Phase 3.5 S4 (Issue #93) — 匿名共有リンク（share_links）の廃止（D4 / UC-S01）
--
-- D4:「匿名リンク閲覧は廃止し全員アカウント必須。share_links は廃止し guest_grants へ
--     一本化」。ゲスト基盤（guest_grants + 招待導線）が揃ったため、S4 完了に合わせて
--     匿名トークン閲覧を無効化する（2026-07-04 ヒアリング: S4 完了時に即廃止）。
--
-- 方針（段階廃止。本 PR は「読み取り経路の無効化」＝機能廃止まで）:
--   1. get_shared_view を常に {valid:false} を返す実装へ差し替える。既存トークンも
--      新規トークンも一切データを返さなくなる（匿名閲覧の完全停止 = D4 の核心）。
--   2. 既存の有効リンクを失効させる（データ衛生。update のみ・行は消さない）。
--   3. テーブル・RLS ポリシーは物理削除しない（後続クリーンアップ PR で drop）。
--      読み取りが無効化済みのため、万一 insert 経路が残っていても匿名露出は起きない。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   get_shared_view を 20260704030000 の定義（世帯スコープ版）で再作成する。
--   （失効させたリンクの revoked_at は手動での復元が必要。）
-- =============================================================

-- 1. 匿名閲覧の停止: トークンに関わらず常に無効を返す。
create or replace function public.get_shared_view(p_token text)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  -- D4/UC-S01: 匿名共有は廃止。全員アカウント必須（ゲストは guest_grants 経由）。
  -- 既存トークンも含め一切データを返さない。
  select jsonb_build_object('valid', false);
$$;

comment on function public.get_shared_view(text) is
  '【廃止】匿名共有リンクは D4/UC-S01 で廃止。常に {valid:false} を返す。閲覧共有は guest_grants（ゲスト）または viewer 招待で行う。';

-- 2. 既存の有効リンクを失効させる（行は残すが無効化。update のみ）。
update public.share_links
  set revoked_at = now()
  where revoked_at is null;
