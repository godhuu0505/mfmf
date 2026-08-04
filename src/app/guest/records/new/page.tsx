import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/lib/household";
import { listActiveGuestGrants } from "@/lib/guest";
import { getCurrentProfile } from "@/lib/profile";
import {
  ConfirmCancelButton,
  ConfirmSubmitButton,
} from "@/components/FormConfirm";
import { PawPrint } from "lucide-react";
import { createGuestRecord } from "@/app/guest/actions";
import { RECORD_SOURCES, SOURCE_LABEL } from "@/types/database";
import { jstTodayISO } from "@/lib/dateRange";

export const dynamic = "force-dynamic";

export const metadata = { title: "記録を追加（ゲスト）" };

const inputClass =
  "w-full rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground";

// ゲストのお世話記録の追加フォーム（UC-G03）。写真・タグはゲスト対象外（D8）のため
// テキスト・日付・体重のみ。書き込みの可否（期間内・担当ペット）は RLS が強制する。
export default async function GuestNewRecordPage({
  searchParams,
}: {
  searchParams: Promise<{ pet?: string }>;
}) {
  const { pet } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getCurrentMembership(supabase);
  if (membership) redirect("/");

  const grants = await listActiveGuestGrants(supabase, user.id);
  if (grants.length === 0) redirect("/onboarding");

  // 指定ペット（クエリ）を優先。無効・未指定なら先頭の担当ペット。
  const grant = grants.find((g) => g.petId === pet) ?? grants[0];
  const profile = await getCurrentProfile();
  const today = jstTodayISO();

  return (
    <>
      <header className="safe-pt sticky top-0 z-10 border-b border-border bg-surface/80 backdrop-blur">
        <div className="safe-px mx-auto flex max-w-2xl items-center py-3">
          <span className="flex items-center gap-2 font-bold text-foreground">
            <PawPrint className="h-5 w-5" aria-hidden="true" />
            mfmf
          </span>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link
            href="/guest"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← お世話の記録へ戻る
          </Link>
        </div>
        <h1 className="mb-1 text-xl font-bold text-foreground">記録を追加</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          対象: <span className="font-medium text-foreground">{grant.petName}</span>
          （期間: {grant.validFrom} 〜 {grant.validTo ?? "終了日未設定"}）
        </p>

        <form action={createGuestRecord} className="space-y-5">
          <input type="hidden" name="pet_id" value={grant.petId} />

          <div>
            <span className="mb-1 block text-sm font-medium text-foreground">
              記録元
            </span>
            <div className="inline-flex overflow-hidden rounded-lg border border-border">
              {RECORD_SOURCES.map((s, i) => (
                <label
                  key={s}
                  className={
                    "cursor-pointer px-4 py-1.5 text-sm font-medium text-foreground " +
                    (i > 0 ? "border-l border-border" : "")
                  }
                >
                  <input
                    type="radio"
                    name="source"
                    value={s}
                    defaultChecked={s === "daycare"}
                    className="mr-1.5"
                  />
                  {SOURCE_LABEL[s]}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label
              htmlFor="record_date"
              className="mb-1 block text-sm font-medium text-foreground"
            >
              記録の日付
            </label>
            <input
              id="record_date"
              name="record_date"
              type="date"
              required
              defaultValue={today}
              className="rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              預かり期間内の日付のみ登録できます。
            </p>
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-[10rem]">
              <label
                htmlFor="author"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                記入者
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  （任意）
                </span>
              </label>
              <input
                id="author"
                name="author"
                type="text"
                defaultValue={profile?.default_author ?? ""}
                placeholder="担当スタッフ名"
                className={inputClass}
              />
            </div>
            <div className="w-32">
              <label
                htmlFor="weight_kg"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                体重(kg)
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  （任意）
                </span>
              </label>
              <input
                id="weight_kg"
                name="weight_kg"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                placeholder="2.25"
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="body"
              className="mb-1 block text-sm font-medium text-foreground"
            >
              今日の様子
            </label>
            <textarea
              id="body"
              name="body"
              rows={8}
              placeholder="ごはんの様子、遊びの様子などを記録します"
              className={inputClass}
            />
          </div>

          <div className="flex items-center gap-3 pt-2">
            {/* 保存・キャンセルとも確認を挟む（UC-F01。世帯側の RecordForm と同じ振る舞い） */}
            <ConfirmSubmitButton className="rounded-lg bg-primary px-5 py-2.5 font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60">
              保存する
            </ConfirmSubmitButton>
            <ConfirmCancelButton
              href="/guest"
              className="text-sm text-muted-foreground transition hover:text-foreground"
            />
          </div>
        </form>
      </main>
    </>
  );
}
