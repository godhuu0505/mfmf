import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/lib/household";
import { listActiveGuestGrants } from "@/lib/guest";
import {
  SOURCE_LABEL,
  type DaycareRecord,
  type RecordSource,
} from "@/types/database";
import FeedbackWidget from "@/components/FeedbackWidget";
import SourceIcon from "@/components/SourceIcon";
import { LogOut, PawPrint, Scale } from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata = { title: "ゲスト" };

function formatDate(d: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(d));
}

// ゲスト（保育園/シッター）向けのダッシュボード（UC-G02）。
// 担当ペットごとに、期間内に共有された記録＋自分の記入を表示し、記録追加へ導線する。
// 見える範囲は RLS（pets_select_guest / records_select_guest）が一次防衛線。
export default async function GuestPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // 世帯メンバーはこの画面の対象外（通常の一覧へ）。
  const membership = await getCurrentMembership(supabase);
  if (membership) redirect("/");

  const grants = await listActiveGuestGrants(supabase, user.id);
  if (grants.length === 0) {
    // 有効なゲスト付与がない（期間前・期間終了・失効）。オンボーディングへ。
    redirect("/onboarding");
  }

  // 担当ペットの見える記録をまとめて取得（RLS で共有分＋自分の記入のみ返る）。
  const petIds = grants.map((g) => g.petId);
  const { data: recordRows } = await supabase
    .from("daycare_records")
    .select("*")
    .in("pet_id", petIds)
    .order("record_date", { ascending: false })
    .order("created_at", { ascending: false })
    .returns<DaycareRecord[]>();
  const records = recordRows ?? [];

  return (
    <>
      <header className="safe-pt sticky top-0 z-10 border-b border-border bg-surface/80 backdrop-blur">
        <div className="safe-px mx-auto flex max-w-2xl items-center justify-between py-3">
          <span className="flex items-center gap-2 font-bold text-foreground">
            <PawPrint className="h-5 w-5" aria-hidden="true" />
            mfmf
          </span>
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="flex items-center gap-1 text-sm text-muted-foreground transition hover:text-foreground"
              aria-label="ログアウト"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>
          </form>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="mb-1 text-xl font-bold text-foreground">お世話の記録</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          担当のペットについて、共有された記録の閲覧と、お世話の記録の追加ができます。
        </p>

        {grants.map((g) => {
          const petRecords = records.filter((r) => r.pet_id === g.petId);
          return (
            <section key={g.id} className="mb-8">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-bold text-foreground">
                    {g.petName}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {g.role === "guest:daycare" ? "保育園" : "シッター"} ・ 期間:{" "}
                    {g.validFrom} 〜 {g.validTo ?? "終了日未設定"}
                  </p>
                </div>
                <Link
                  href={`/guest/records/new?pet=${g.petId}`}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover"
                >
                  記録を追加
                </Link>
              </div>

              {petRecords.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  表示できる記録はまだありません。
                </p>
              ) : (
                <ul className="space-y-3">
                  {petRecords.map((r) => (
                    <li
                      key={r.id}
                      className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-border"
                    >
                      <div className="mb-1.5 flex flex-wrap items-center gap-2">
                        <span
                          className={
                            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium " +
                            (r.source === "home"
                              ? "bg-amber-100 text-amber-900"
                              : "bg-sky-100 text-sky-900")
                          }
                        >
                          <SourceIcon
                            source={r.source as RecordSource}
                            className="h-3.5 w-3.5"
                          />
                          {SOURCE_LABEL[r.source]}
                        </span>
                        {r.weight_kg != null && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            <Scale className="h-3.5 w-3.5" aria-hidden="true" />
                            {r.weight_kg}kg
                          </span>
                        )}
                        <span className="text-sm font-semibold text-foreground">
                          {formatDate(r.record_date)}
                        </span>
                        {r.owner_id === user.id && (
                          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-muted-foreground">
                            あなたの記入
                          </span>
                        )}
                      </div>
                      {r.author && (
                        <p className="mb-1 text-xs text-muted-foreground">
                          記入者: {r.author}
                        </p>
                      )}
                      <p className="whitespace-pre-wrap text-sm text-foreground">
                        {r.body || "（本文なし）"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}

        {/* ゲストはメニュー画面に到達しないため、フィードバックの入口をここに置く
            （D33 でフローティングボタンを廃止した際の導線維持） */}
        <div className="mt-6 overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-border">
          <FeedbackWidget variant="row" />
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          写真やその他のペット・世帯の情報は共有されません。
        </p>
      </main>
    </>
  );
}
