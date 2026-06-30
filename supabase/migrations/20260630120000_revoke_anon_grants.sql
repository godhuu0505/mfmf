-- =============================================================
-- mfmf / anon ロールの過剰 GRANT を失効（Supabase 旧自動付与の残骸）
--   Issue #88
--
-- 背景: 旧 Supabase 仕様（auto_expose_new_tables=true 時代）に SQL Editor で
-- 0001-0010 を手動投入したため、public スキーマの新規オブジェクトへ Data API
-- ロール（特に anon）の GRANT が自動付与された残骸が本番 DB に残っている。
-- 20260616130713_grants.sql の設計意図は「anon は schema usage のみ。テーブル
-- 直接参照はさせず、共有は public.get_shared_view(SECURITY DEFINER) 経由」だが、
-- 本番の実体がこの意図と乖離していた（`supabase db diff` で anon 差分が残る）。
--
-- 実害は RLS（auth.uid() = owner_id）が一次防衛線として防いでいるが、defense in
-- depth として anon を設計意図どおり最小化する。アプリは authenticated でしか
-- DB に触れないため、anon GRANT 削除はアプリ動作に影響しない。
--
-- 不変条件:
--   - RLS / Storage ポリシー / 既存 grants.sql は変更しない（RLS を弱めない）。
--   - 共有リンク用 public.get_shared_view(text) の anon EXECUTE は維持する。
--   - anon の public スキーマ USAGE（grants.sql で付与）は維持する。
--   - FOR ROLE supabase_admin のベースライン default は postgres ロールから変更
--     できず、db diff にも出ない Supabase 標準設定のため触らない（アプリの
--     テーブルは postgres が作成するので無害）。
-- =============================================================

-- ---------------------------------------------------------------
-- 1. 既存テーブルへの anon GRANT を全取り消し
--    実体は anon=arwdDxtm（INSERT/SELECT/UPDATE/DELETE/TRUNCATE/REFERENCES/
--    TRIGGER の全7権限）。CRUD4 だけでは REFERENCES/TRUNCATE/TRIGGER が残るため
--    REVOKE ALL を使う。grantor は postgres なので postgres で適用すれば剥がせる。
-- ---------------------------------------------------------------
revoke all privileges on all tables in schema public from anon;

-- ---------------------------------------------------------------
-- 2. 既存シーケンスへの anon GRANT を取り消す（現状 public にシーケンスは無いが
--    将来対策として明示。無ければ no-op）。
-- ---------------------------------------------------------------
revoke all privileges on all sequences in schema public from anon;

-- ---------------------------------------------------------------
-- 3. 残骸である set_updated_at(trigger 関数) の anon EXECUTE を取り消す。
--    本番では anon が「直接付与(anon=X)」と「関数作成時の既定 PUBLIC(=X)」の両方で
--    EXECUTE を握っているため、anon と PUBLIC の双方から剥がす（FROM anon だけでは
--    PUBLIC 経由の EXECUTE が残る）。set_updated_at はトリガ専用関数で直接呼び出しは
--    不要、トリガ発火は EXECUTE 権限を参照しないため影響なし。get_shared_view が
--    既に `revoke all on function ... from public` 済みなのと同じ方針に揃える。
--    ※ get_shared_view の anon EXECUTE は共有リンク用に意図的に維持（触らない）。
-- ---------------------------------------------------------------
revoke all privileges on function public.set_updated_at() from anon;
revoke execute on function public.set_updated_at() from public;

-- ---------------------------------------------------------------
-- 4. 今後 postgres ロールが作る新規オブジェクトに anon を自動付与しないよう、
--    postgres ロールの ALTER DEFAULT PRIVILEGES から anon を外す。
--    本番 db diff も「FOR ROLE postgres」の形で出るため、それを正確に打ち消す。
-- ---------------------------------------------------------------
alter default privileges for role postgres in schema public revoke all on tables    from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on routines  from anon;
