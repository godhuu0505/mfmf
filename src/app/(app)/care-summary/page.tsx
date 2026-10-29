import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import CareSummaryRangePreset from "@/components/CareSummaryRangePreset";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/lib/household";
import { hasActiveGuestGrant } from "@/lib/guest";
import { jstTodayISO } from "@/lib/dateRange";
import { buildCareSummary, careMemberLabel, careSummaryRange, CareSummaryRangeError, shiftCareDate, type CareRecord } from "@/lib/careSummary";
import { CareSummaryReadError, fetchCarePets, fetchCareSummary } from "@/lib/careSummaryQuery";
import { careAssigneeLabel, careDateLabel as dateLabel, formatCareSummaryText } from "@/lib/careSummaryText";
import { SOURCE_LABEL, type AssigneeRole } from "@/types/database";
import { type ScheduleItem } from "@/lib/schedule";
import CareSummaryPrintButton from "@/components/CareSummaryPrintButton";
import CareSummaryCopyButton from "@/components/CareSummaryCopyButton";
import styles from "./summary.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "お世話の引き継ぎ", robots: { index: false, follow: false } };
type Params = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

function Section({ title, description, count, children }: { title: string; description: string; count: number; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-2xl border border-border bg-surface p-4 print:rounded-none print:border-0 print:px-0">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        <span className="rounded-full bg-surface-muted px-2 py-1 text-xs">{count}件</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      {children}
    </section>
  );
}

export default async function CareSummaryPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const today = jstTodayISO();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const membership = await getCurrentMembership(supabase);
  if (!membership) {
    if (await hasActiveGuestGrant(supabase, user.id)) redirect("/guest");
    redirect("/onboarding");
  }

  let pets: Awaited<ReturnType<typeof fetchCarePets>> = [];
  let report: Awaited<ReturnType<typeof fetchCareSummary>> | null = null;
  let errorMessage: string | null = null;
  let range = careSummaryRange(undefined, undefined, today);
  let petId = first(sp.pet) ?? "";
  try {
    pets = await fetchCarePets(supabase, membership.householdId);
    range = careSummaryRange(first(sp.from), first(sp.to), today);
    if (sp.pet === undefined && pets.length === 1) petId = pets[0].id;
    if (petId && !pets.some((pet) => pet.id === petId)) {
      errorMessage = "選択したペットをこの世帯で確認できません。ペットを選び直してください。";
      petId = "";
    } else if (petId) {
      report = await fetchCareSummary(supabase, membership.householdId, petId, range, today);
    }
  } catch (error) {
    errorMessage = error instanceof CareSummaryReadError || error instanceof CareSummaryRangeError
      ? error.message : "引き継ぎシートを読み込めませんでした。時間をおいて再度お試しください。";
  }
  const pet = pets.find((p) => p.id === petId);
  const summary = report && pet ? buildCareSummary({ ...report, petId, range, today }) : null;
  const memberNames = new Map(report?.members.map((m) => [m.user_id, careMemberLabel(m)]) ?? []);
  const whoLabel = (who?: Partial<Record<AssigneeRole, string>>) => careAssigneeLabel(memberNames, who);
  function recordList(rows: CareRecord[], empty: string) {
    return rows.length ? <ul>{rows.map((row) => (
      <li key={row.id} className="space-y-2 border-b border-border py-4 last:border-0 print:break-inside-avoid">
        <p className="text-sm font-medium">{dateLabel(row.record_date)} · {SOURCE_LABEL[row.source]}{row.start_time ? ` · ${row.start_time}〜${row.end_time}` : ""}</p>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{row.body || "メモなし"}</p>
        {row.weight_kg !== null && row.status === "done" && <p className="text-sm">体重：{Number(row.weight_kg).toFixed(2)} kg</p>}
        <p className="text-xs text-muted-foreground">{whoLabel(row.who)}{row.author ? ` · 記入者：${row.author}` : ""}</p>
      </li>
    ))}</ul> : <p className="py-5 text-sm text-muted-foreground">{empty}</p>;
  }
  function planList(rows: ScheduleItem[], empty: string) {
    return rows.length ? <ul>{rows.map((row) => (
      <li key={`${row.date}:${row.id}`} className="space-y-2 border-b border-border py-4 last:border-0 print:break-inside-avoid">
        <p className="text-sm font-medium">{dateLabel(row.date)} · {SOURCE_LABEL[row.source]}{row.start ? ` · ${row.start}〜${row.end}` : " · 時刻未設定"}</p>
        {row.fromRule && <p className="text-xs text-muted-foreground">毎週の予定ルールから表示</p>}
        {row.body && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{row.body}</p>}
        <p className="text-xs text-muted-foreground">{whoLabel(row.who)}</p>
      </li>
    ))}</ul> : <p className="py-5 text-sm text-muted-foreground">{empty}</p>;
  }
  const inputClass = "block min-h-12 w-full rounded-xl border border-border bg-background px-3 text-base";
  return (
    <main id="main" className={`${styles.page} mx-auto max-w-2xl space-y-6 px-4 py-6`}>
      <div className="space-y-2">
        <Link href="/menu" className="text-sm text-muted-foreground print:hidden">← メニュー</Link>
        <p className="text-sm font-medium text-primary print:hidden">家族・病院・サロンへ</p>
        <h1 className="text-2xl font-bold tracking-tight">お世話の引き継ぎ</h1>
        <p className="text-sm leading-relaxed text-muted-foreground print:hidden">最近の様子と、これからの予定をひとまとめに。渡す前に内容を確認してください。</p>
      </div>
      <form action="/care-summary" method="get" aria-label="表示条件" className="space-y-4 rounded-2xl border border-border bg-surface p-4 print:hidden">
        <label className="block space-y-2 text-sm font-medium">ペット
          <select name="pet" defaultValue={petId} key={petId} required className={inputClass}>
            <option value="">ペットを選択してください</option>
            {pets.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-2 text-sm font-medium">開始日<input className={inputClass} type="date" name="from" defaultValue={first(sp.from) ?? range.from} key={`from:${first(sp.from)}`} required /></label>
          <label className="space-y-2 text-sm font-medium">終了日<input className={inputClass} type="date" name="to" defaultValue={first(sp.to) ?? range.to} key={`to:${first(sp.to)}`} required /></label>
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          {[7, 30].map((days) => <CareSummaryRangePreset key={days} label={`直近${days}日＋今後7日`} from={shiftCareDate(today, 1 - days)} to={shiftCareDate(today, 7)} />)}
        </div>
        <p className="text-xs text-muted-foreground">日付は日本時間です。期間は62日以内で指定できます。</p>
        <button type="submit" className="min-h-12 w-full rounded-xl bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary-hover">表示する</button>
      </form>
      {errorMessage && <p role="alert" className="rounded-xl border border-red-400 bg-surface p-4 text-sm text-foreground">{errorMessage}</p>}
      {!errorMessage && !pet && <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">{pets.length ? "ペットを選ぶと引き継ぎシートを表示します。" : <>ペットが登録されていません。<Link className="underline" href="/pets">ペットを登録する</Link></>}</p>}
      {pet && report && summary && <>
        <article aria-label={`${pet.name}の引き継ぎシート`} className="space-y-6">
          <section className="rounded-2xl border border-border bg-surface p-5 print:break-inside-avoid">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div><h2 className="text-2xl font-bold">{pet.name}</h2>{pet.species && <p className="mt-1 text-sm text-muted-foreground">{pet.species}</p>}</div>
              <div><p className="text-xs text-muted-foreground">最近の体重</p><p className="mt-1 text-xl font-semibold">{report.latestWeight ? `${Number(report.latestWeight.weight_kg).toFixed(2)} kg` : "記録なし"}</p>{report.latestWeight && <p className="mt-1 text-xs text-muted-foreground">{dateLabel(report.latestWeight.record_date)}の記録{report.latestWeight.record_date < range.from ? "（対象期間より前）" : ""}</p>}</div>
            </div>
            <div className="mt-4 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground"><p>対象期間：{dateLabel(range.from)}〜{dateLabel(range.to)}</p><p>記録・体重は{dateLabel(report.asOf)}まで。予定は今日以降を表示。</p><p>作成日：{dateLabel(today)}（日本時間）</p></div>
          </section>
          <Section title="これまでの記録" description="実施したこと・日々のようす" count={summary.done.length}>{recordList(summary.done, "この期間の記録はありません。")}</Section>
          <Section title="これからの予定" description="このペットに設定されている予定" count={summary.planned.length}>{planList(summary.planned, "この期間に、このペットの予定はありません。")}</Section>
          {summary.unassignedPlans.length > 0 && <Section title="対象ペット未設定の世帯予定" description="毎週の予定など、対象ペットが決まっていない予定です。この子の予定とは限りません。" count={summary.unassignedPlans.length}>{planList(summary.unassignedPlans, "")}</Section>}
          <Section title="見送った予定" description="実施済みには含めていません。" count={summary.skipped.length}>{recordList(summary.skipped, "この期間に見送った予定はありません。")}</Section>
          {summary.pastPlanned.length > 0 && <Section title="過去の未完了予定" description="保存済みの予定のうち、完了・見送りが記録されていないもの" count={summary.pastPlanned.length}>{recordList(summary.pastPlanned, "")}</Section>}
          {summary.unassignedRecordCount > 0 && <p className="text-xs text-muted-foreground">対象ペットが未設定の記録{summary.unassignedRecordCount}件は、このシートの記録に含めていません。</p>}
        </article>
        <CareSummaryCopyButton text={formatCareSummaryText({ pet, range, today, asOf: report.asOf, latestWeight: report.latestWeight, summary, memberNames })} />
        <CareSummaryPrintButton />
        <footer className="border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground"><p>mfmf · 入力された記録と予定を整理したシートです。</p><p>記載内容は作成時点のものです。渡す相手に必要な情報か確認してください。</p></footer>
      </>}
    </main>
  );
}
