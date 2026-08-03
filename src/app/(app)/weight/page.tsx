import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentHouseholdId, householdScopeFilter } from "@/lib/household";
import { SOURCE_LABEL, type DaycareRecord } from "@/types/database";
import SourceIcon from "@/components/SourceIcon";
import WeightChart, { type WeightPoint } from "@/components/WeightChart";

export const dynamic = "force-dynamic";

function formatDate(d: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(d));
}

type WeightRow = Pick<
  DaycareRecord,
  "id" | "record_date" | "weight_kg" | "source"
>;

// 期間切替（D33 / proto 合意）。URL クエリで共有・リロード再現できるようにする。
const RANGES = [
  { key: "1m", label: "1ヶ月", days: 31 },
  { key: "3m", label: "3ヶ月", days: 92 },
  { key: "1y", label: "1年", days: 366 },
  { key: "all", label: "全期間", days: null },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

export default async function WeightPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range } = await searchParams;
  const rangeKey: RangeKey = (RANGES.some((r) => r.key === range)
    ? range
    : "all") as RangeKey;
  const rangeDef = RANGES.find((r) => r.key === rangeKey)!;

  const supabase = await createClient();
  // 読み取りは household 基準へ寄せる（未所属は owner_id RLS にフォールバック）。
  const householdId = await getCurrentHouseholdId(supabase);

  let query = supabase
    .from("daycare_records")
    .select("id, record_date, weight_kg, source")
    .not("weight_kg", "is", null)
    .order("record_date", { ascending: true });
  if (rangeDef.days != null) {
    const cutoff = new Date(Date.now() - rangeDef.days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    query = query.gte("record_date", cutoff);
  }
  if (householdId) query = query.or(householdScopeFilter(householdId));
  const { data } = await query.returns<WeightRow[]>();

  const rows = data ?? [];

  // グラフ用（日付昇順）。同日に複数あっても各点を打つ。
  const points: WeightPoint[] = rows.map((r) => ({
    date: r.record_date,
    weight: Number(r.weight_kg),
  }));

  const latest = rows.length > 0 ? rows[rows.length - 1] : null;
  const first = rows.length > 0 ? rows[0] : null;
  const diff =
    latest && first ? Number(latest.weight_kg) - Number(first.weight_kg) : 0;

  return (
    <>
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← 一覧へ戻る
          </Link>
        </div>
        <h1 className="mb-4 text-xl font-bold text-foreground">体重の推移</h1>

        {/* 期間切替チップ（選択中は primary。URL クエリが正） */}
        <div className="mb-4 flex gap-2">
          {RANGES.map((r) => {
            const isActive = r.key === rangeKey;
            return (
              <Link
                key={r.key}
                href={r.key === "all" ? "/weight" : `/weight?range=${r.key}`}
                aria-current={isActive ? "page" : undefined}
                className={
                  "rounded-full px-3.5 py-1.5 text-sm font-medium transition " +
                  (isActive
                    ? "bg-primary text-primary-foreground"
                    : "bg-surface text-foreground ring-1 ring-border hover:bg-surface-muted")
                }
              >
                {r.label}
              </Link>
            );
          })}
        </div>

        {rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-10 text-center text-muted-foreground">
            {rangeKey === "all" ? (
              <>
                体重が記録された日がまだありません。
                <br />
                記録の追加・編集で体重(kg)を入力すると、ここに推移が表示されます。
              </>
            ) : (
              <>この期間に体重の記録はありません。</>
            )}
          </div>
        ) : (
          <>
            <section className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-border">
              <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <p className="text-sm text-muted-foreground">
                  最新の体重
                  <span className="ml-2 text-2xl font-bold text-foreground">
                    {latest ? Number(latest.weight_kg).toFixed(2) : "-"}
                    <span className="ml-0.5 text-base font-medium">kg</span>
                  </span>
                </p>
                {rows.length > 1 && (
                  <p className="text-sm text-muted-foreground">
                    {rangeKey === "all" ? "最初の記録" : `${rangeDef.label}前`}から{" "}
                    <span
                      className={
                        "font-semibold " +
                        (diff > 0
                          ? "text-emerald-600"
                          : diff < 0
                            ? "text-rose-600"
                            : "text-muted-foreground")
                      }
                    >
                      {diff > 0 ? "+" : ""}
                      {diff.toFixed(2)}kg
                    </span>
                  </p>
                )}
              </div>
              <WeightChart points={points} />
            </section>

            <ul className="mt-6 space-y-2">
              {[...rows].reverse().map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3"
                >
                  <Link
                    href={`/records/${r.id}`}
                    className="flex flex-1 items-center justify-between gap-3 rounded-xl bg-surface px-4 py-2.5 shadow-sm ring-1 ring-border transition hover:ring-border"
                  >
                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                      {formatDate(r.record_date)}
                      <span
                        className={
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium " +
                          (r.source === "home"
                            ? "bg-amber-100 text-amber-900"
                            : "bg-sky-100 text-sky-900")
                        }
                      >
                        <SourceIcon source={r.source} className="h-3 w-3" />
                        {SOURCE_LABEL[r.source]}
                      </span>
                    </span>
                    <span className="font-semibold text-foreground">
                      {Number(r.weight_kg).toFixed(2)}kg
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </>
  );
}
