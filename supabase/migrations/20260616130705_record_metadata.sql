-- =============================================================
-- mfmf / ペット保育園記録アプリ  フェーズ2 記録メタデータの追加
--   - 記録元 (source): 保育園 / おうち(両親) を区別して後から見返しやすくする
--   - 記入者 (author):  保育園スタッフ名やおうちの記入者
--   - 体重 (weight_kg): 保育園記録などで残る体重を時系列で振り返れるように
-- 既存の RLS / Storage ポリシーは変更しない（列追加のみ）。
-- =============================================================

-- ---------------------------------------------------------------
-- 1. daycare_records へ列を追加
-- ---------------------------------------------------------------
alter table public.daycare_records
  add column if not exists source    text         not null default 'daycare',
  add column if not exists author     text         not null default '',
  add column if not exists weight_kg  numeric(5,2);

-- source は 'daycare'(保育園) / 'home'(おうち) のみ許可
alter table public.daycare_records
  drop constraint if exists daycare_records_source_check;
alter table public.daycare_records
  add constraint daycare_records_source_check
  check (source in ('daycare', 'home'));

-- 体重は正の値のみ（NULL は未記入として許可）
alter table public.daycare_records
  drop constraint if exists daycare_records_weight_check;
alter table public.daycare_records
  add constraint daycare_records_weight_check
  check (weight_kg is null or weight_kg > 0);

comment on column public.daycare_records.source is '記録元: daycare=保育園 / home=おうち(両親)';
comment on column public.daycare_records.author is '記入者（保育園スタッフ名 / おうちの記入者）';
comment on column public.daycare_records.weight_kg is 'その日の体重(kg)。未記入は NULL';

-- 記録元での絞り込みを高速化
create index if not exists daycare_records_owner_source_date_idx
  on public.daycare_records (owner_id, source, record_date desc);
