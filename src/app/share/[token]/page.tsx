import { createClient } from "@/lib/supabase/server";
import { SOURCE_LABEL, type SharedView } from "@/types/database";
import SourceIcon from "@/components/SourceIcon";
import { Lock, PawPrint, Scale } from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "共有された記録",
  // 共有ページは検索エンジンにインデックスさせない。
  robots: { index: false, follow: false },
};

function formatDate(d: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(d));
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const supabase = await createClient();
  // SECURITY DEFINER 関数でトークンを検証し、有効な場合のみ記録を取得する。
  const { data } = await supabase.rpc("get_shared_view", { p_token: token });
  const view = (data as SharedView | null) ?? { valid: false };

  if (!view.valid) {
    return (
      <main id="main" className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <p className="mb-2 flex justify-center text-muted-foreground">
            <Lock className="h-10 w-10" aria-hidden="true" />
          </p>
          <h1 className="mb-1 text-lg font-bold text-foreground">
            この共有リンクは利用できません
          </h1>
          <p className="text-sm text-muted-foreground">
            リンクの期限が切れているか、無効化された可能性があります。
            <br />
            共有した人にもう一度確認してください。
          </p>
        </div>
      </main>
    );
  }

  const records = view.records;

  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6 text-center">
        <p className="flex justify-center text-foreground">
          <PawPrint className="h-7 w-7" aria-hidden="true" />
        </p>
        <h1 className="mt-1 text-xl font-bold text-foreground">
          {view.label?.trim() ? view.label : "ペットの記録"}
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">閲覧専用で共有されています</p>
      </header>

      {records.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center text-muted-foreground">
          共有できる記録がまだありません。
        </div>
      ) : (
        <ul className="space-y-3">
          {records.map((r, i) => (
            <li
              key={`${r.record_date}-${i}`}
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
                  <SourceIcon source={r.source} className="h-3.5 w-3.5" />
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
              </div>
              {r.author && (
                <p className="mb-1 text-xs text-muted-foreground">記入者: {r.author}</p>
              )}
              <p className="whitespace-pre-wrap text-sm text-foreground">
                {r.body || "（本文なし）"}
              </p>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 text-center text-xs text-muted-foreground">
        mfmf — ペットの記録
      </p>
    </main>
  );
}
