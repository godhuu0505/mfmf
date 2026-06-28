import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  FEEDBACK_STATUS_LABEL,
  FEEDBACK_STATUSES,
  FEEDBACK_KIND_LABEL,
  FEEDBACK_SEVERITY_LABEL,
  type Feedback,
  type FeedbackStatus,
} from "@/types/database";
import AppHeader from "@/components/AppHeader";
import SubmitButton from "@/components/SubmitButton";
import { setFeedbackStatus, deleteFeedback } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "フィードバック" };

function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function statusTone(status: FeedbackStatus): string {
  switch (status) {
    case "open":
      return "bg-amber-100 text-amber-700";
    case "triaged":
      return "bg-sky-100 text-sky-700";
    case "closed":
      return "bg-emerald-100 text-emerald-700";
  }
}

export default async function FeedbackTriagePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: statusParam } = await searchParams;
  const activeStatus = FEEDBACK_STATUSES.includes(
    statusParam as FeedbackStatus,
  )
    ? (statusParam as FeedbackStatus)
    : null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  let query = supabase
    .from("feedback")
    .select("*")
    .order("created_at", { ascending: false });
  if (activeStatus) query = query.eq("status", activeStatus);
  const { data } = await query.returns<Feedback[]>();
  const items = data ?? [];

  // 各 status の件数（フィルタ無しで取得して集計）
  const { data: countsData } = await supabase
    .from("feedback")
    .select("status")
    .returns<Pick<Feedback, "status">[]>();
  const counts: Record<FeedbackStatus, number> = {
    open: 0,
    triaged: 0,
    closed: 0,
  };
  (countsData ?? []).forEach((r) => {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  });
  const total = (countsData ?? []).length;

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-4">
          <Link
            href="/"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← 一覧へ戻る
          </Link>
        </div>
        <h1 className="mb-1 text-xl font-bold text-foreground">
          フィードバックのトリアージ
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">
          自分が送ったご意見・不具合報告の状態を管理します。
          GitHub Issue 化は <code>npm run feedback:issues</code> で行います。
        </p>

        {/* status フィルタ */}
        <nav className="mb-4 flex flex-wrap items-center gap-1.5">
          <StatusChip
            href="/feedback"
            label={`全件 (${total})`}
            active={!activeStatus}
          />
          {FEEDBACK_STATUSES.map((s) => (
            <StatusChip
              key={s}
              href={`/feedback?status=${s}`}
              label={`${FEEDBACK_STATUS_LABEL[s]} (${counts[s]})`}
              active={activeStatus === s}
              tone={statusTone(s)}
            />
          ))}
        </nav>

        {items.length === 0 ? (
          <p className="rounded-2xl bg-surface p-5 text-sm text-muted-foreground ring-1 ring-border">
            {activeStatus
              ? `${FEEDBACK_STATUS_LABEL[activeStatus]} のフィードバックはまだありません。`
              : "フィードバックはまだありません。"}
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((f) => (
              <li
                key={f.id}
                className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-border"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span
                    className={
                      "rounded-full px-2 py-0.5 text-xs font-medium " +
                      statusTone(f.status)
                    }
                  >
                    {FEEDBACK_STATUS_LABEL[f.status]}
                  </span>
                  <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {FEEDBACK_KIND_LABEL[f.kind]}
                  </span>
                  {f.severity && (
                    <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      {FEEDBACK_SEVERITY_LABEL[f.severity]}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatDateTime(f.created_at)}
                  </span>
                </div>

                {f.title && (
                  <p className="mb-1 text-sm font-semibold text-foreground">
                    {f.title}
                  </p>
                )}
                <p className="mb-3 whitespace-pre-wrap text-sm text-foreground">
                  {f.body}
                </p>

                {(f.expected || f.actual || f.when_happened) && (
                  <dl className="mb-3 space-y-1 text-xs text-muted-foreground">
                    {f.when_happened && (
                      <DetailRow label="発生">{f.when_happened}</DetailRow>
                    )}
                    {f.expected && (
                      <DetailRow label="期待">{f.expected}</DetailRow>
                    )}
                    {f.actual && (
                      <DetailRow label="実際">{f.actual}</DetailRow>
                    )}
                  </dl>
                )}

                {f.github_issue_url && (
                  <p className="mb-3 text-xs">
                    <a
                      href={f.github_issue_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sky-700 underline decoration-dotted hover:decoration-solid"
                    >
                      GitHub Issue #{f.github_issue_number ?? "?"} を開く ↗
                    </a>
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  {FEEDBACK_STATUSES.filter((s) => s !== f.status).map((s) => (
                    <form
                      key={s}
                      action={setFeedbackStatus.bind(null, f.id)}
                      className="inline"
                    >
                      <input type="hidden" name="status" value={s} />
                      <SubmitButton
                        pendingLabel="更新中…"
                        className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-surface-muted disabled:opacity-60"
                      >
                        → {FEEDBACK_STATUS_LABEL[s]}
                      </SubmitButton>
                    </form>
                  ))}
                  <form
                    action={deleteFeedback.bind(null, f.id)}
                    className="ml-auto inline"
                  >
                    <SubmitButton
                      pendingLabel="削除中…"
                      className="text-xs text-red-600 transition hover:text-red-800 disabled:opacity-60"
                    >
                      削除
                    </SubmitButton>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

function StatusChip({
  href,
  label,
  active,
  tone,
}: {
  href: string;
  label: string;
  active: boolean;
  tone?: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        "rounded-full px-2.5 py-0.5 text-xs font-medium transition " +
        (active
          ? "bg-primary text-primary-foreground"
          : tone
            ? `${tone} hover:opacity-80`
            : "bg-surface-muted text-muted-foreground hover:bg-muted")
      }
    >
      {label}
    </Link>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 font-medium text-foreground">{label}:</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
