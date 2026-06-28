-- =============================================================
-- CI/CD smoke test (#82 マージ後の deploy-preview.yml migrate ジョブ初回試走用)
--
-- このマイグレーションは CI/CD パイプラインの動作確認のみを目的とする：
--   1. supabase/setup-cli が CI runner にインストールされる
--   2. supabase link --project-ref が成功する
--   3. supabase db dump で本番 DB のスナップショットが Artifact に上がる
--   4. supabase db push がこのファイルを適用し、schema_migrations に行を残す
--   5. 続く Vercel Preview deploy が成功する
--
-- DB スキーマ・データには一切影響を与えない（NOTICE メッセージのみ出力）。
-- =============================================================

do $$
begin
  raise notice 'mfmf CI/CD smoke test: migrate ジョブが正常に実行されました（% UTC）', now();
end
$$;
