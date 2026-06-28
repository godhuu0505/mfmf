-- =============================================================
-- mfmf / Data API ロールへの明示的な GRANT
--   - authenticated: アプリ本体が使う。RLS で owner_id = auth.uid() フィルタ。
--   - service_role : このアプリでは未使用だが慣例として全権限を付与。
--   - anon         : 直接のテーブル参照は使わない（共有リンクは
--                    public.get_shared_view(SECURITY DEFINER) で公開）ため
--                    スキーマ usage のみ。
--
-- 背景: Supabase の新しい既定（supabase/config.toml の
-- auto_expose_new_tables=false / Cloud 新規プロジェクトも同様）では、
-- public スキーマに作成された新規オブジェクトは Data API ロールから
-- 自動公開されない。0001..0009 では GRANT を書いていなかったため、
-- authenticated から SELECT/INSERT/UPDATE/DELETE が一切できず、
-- RLS の WITH CHECK でサブクエリ参照される pets 等の SELECT 権限不足で
-- 「permission denied for table pets」になる事象を解消する。
-- 既存の RLS（owner_id ベース）は変えない。
-- =============================================================

-- スキーマ usage（Data API が public を見るのに必要）
grant usage on schema public to anon, authenticated, service_role;

-- 既存テーブル
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

-- 既存シーケンス
grant usage, select on all sequences in schema public to authenticated, service_role;

-- 既存関数
grant execute on all functions in schema public to authenticated, service_role;

-- 今後追加されるオブジェクトにも同じ権限を当てる
-- (このマイグレーションを実行する postgres ロールが作るオブジェクトが対象)
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to authenticated, service_role;
