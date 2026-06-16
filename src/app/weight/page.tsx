import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SOURCE_LABEL, type DaycareRecord } from "@/types/database";
import AppHeader from "@/components/AppHeader";
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

export default async function WeightPage() {
  const supabase = await createClient();

  const { data } = await supabase
    .from("daycare_records")
    .select("id, record_date, weight_kg, source")
    .not("weight_kg", "is", null)
    .order("record_date", { ascending: true })
    .returns<WeightRow[]>();

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
      <AppHeader />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link href="/" className="text-sm text-slate-500 hover:text-slate-800">
            ← 一覧へ戻る
          </Link>
        </div>
        <h1 className="mb-4 text-xl font-bold text-slate-900">体重の推移</h1>

        {rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
            体重が記録された日がまだありません。
            <br />
            記録の追加・編集で体重(kg)を入力すると、ここに推移が表示されます。
          </div>
        ) : (
          <>
            <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
              <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <p className="text-sm text-slate-500">
                  最新の体重
                  <span className="ml-2 text-2xl font-bold text-slate-900">
                    {latest ? Number(latest.weight_kg).toFixed(2) : "-"}
                    <span className="ml-0.5 text-base font-medium">kg</span>
                  </span>
                </p>
                {rows.length > 1 && (
                  <p className="text-sm text-slate-500">
                    最初の記録から{" "}
                    <span
                      className={
                        "font-semibold " +
                        (diff > 0
                          ? "text-emerald-600"
                          : diff < 0
                            ? "text-rose-600"
                            : "text-slate-600")
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
                    className="flex flex-1 items-center justify-between gap-3 rounded-xl bg-white px-4 py-2.5 shadow-sm ring-1 ring-slate-200 transition hover:ring-slate-300"
                  >
                    <span className="flex items-center gap-2 text-sm text-slate-600">
                      {formatDate(r.record_date)}
                      <span
                        className={
                          "rounded-full px-2 py-0.5 text-xs font-medium " +
                          (r.source === "home"
                            ? "bg-amber-100 text-amber-700"
                            : "bg-sky-100 text-sky-700")
                        }
                      >
                        {SOURCE_LABEL[r.source]}
                      </span>
                    </span>
                    <span className="font-semibold text-slate-900">
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
