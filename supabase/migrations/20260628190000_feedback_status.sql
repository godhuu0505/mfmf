-- =============================================================
-- mfmf / フィードバックのトリアージステータス
-- 投稿後の状態管理を可能にする:
--   open     - まだ何もしていない (default)
--   triaged  - GitHub Issue 等に切り出し済み（script が自動セットする想定）
--   closed   - 対応完了 (UI から手動で)
-- =============================================================

alter table public.feedback
  add column if not exists status text not null default 'open'
    check (status in ('open', 'triaged', 'closed')),
  add column if not exists status_changed_at timestamptz not null default now();

comment on column public.feedback.status is
  'トリアージ状態: open / triaged / closed';
comment on column public.feedback.status_changed_at is
  'status を最後に変更した時刻 (open のままなら作成時刻に同じ)';

-- 既存行で github_issue_url が立っているものは triaged に補正する。
update public.feedback
   set status = 'triaged',
       status_changed_at = coalesce(created_at, now())
 where github_issue_url is not null
   and status = 'open';

-- 一覧の絞り込みに使えるよう (owner, status) で複合インデックス。
create index if not exists feedback_owner_status_idx
  on public.feedback (owner_id, status, created_at desc);
