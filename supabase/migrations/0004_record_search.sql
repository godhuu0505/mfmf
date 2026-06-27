-- =============================================================
-- mfmf / ペット保育園記録アプリ  フェーズ2 記録の検索を高速化
--   - 本文 (body) / 記入者 (author) の部分一致検索を高速化する
--   - 日本語を考慮し、tsvector ではなく pg_trgm（trigram）の ILIKE 部分一致を採用
--   - 体重での並び替えを高速化
-- 既存の RLS / Storage ポリシーは変更しない（インデックス追加のみ＝既存方針を弱めない）。
-- 検索は引き続き daycare_records の RLS（owner_id = auth.uid()）の範囲内でのみ働く。
-- =============================================================

-- pg_trgm（trigram 部分一致）。Supabase 慣例に従い extensions スキーマへ。
create extension if not exists pg_trgm with schema extensions;

-- 本文・記入者の ILIKE '%...%' を GIN trigram インデックスで高速化
create index if not exists daycare_records_body_trgm_idx
  on public.daycare_records using gin (body extensions.gin_trgm_ops);

create index if not exists daycare_records_author_trgm_idx
  on public.daycare_records using gin (author extensions.gin_trgm_ops);

-- 体重での並び替え（重い順 / 軽い順）を高速化
create index if not exists daycare_records_owner_weight_idx
  on public.daycare_records (owner_id, weight_kg);
