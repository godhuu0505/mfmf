import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { canEdit, getCurrentMembership } from "@/lib/household";
import { createQuickRecord } from "@/app/(app)/records/actions";
import AppHeader from "@/components/AppHeader";
import AppTabBar from "@/components/AppTabBar";
import HideOnFormRoute from "@/components/HideOnFormRoute";
import HouseholdSyncRefresher from "@/components/HouseholdSyncRefresher";
import QuickRecordSheet from "@/components/QuickRecordSheet";
import { EMPTY_SCHEDULE, fetchSchedule } from "@/lib/scheduleQuery";
import { itemsOnDate, planOnDate } from "@/lib/schedule";
import { jstTodayISO } from "@/lib/dateRange";
import { SOURCE_LABEL } from "@/types/database";

// アプリ内画面（要ログイン圏）の共通クローム（D33）。
// - ヘッダー / ボトムタブバー / クイック記録シートをここで一元描画する。
//   ページ内マウントだと保存後の遷移でトーストごとアンマウントされ、
//   シート表示中の inert もページごとに漏れるため、レイアウトに置く。
// - 認証リダイレクトは各ページの責務のまま（レイアウトは描画だけを担う）。
//   世帯未所属（招待受諾前など）にはタブバー・シートを出さない。
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const membership = user ? await getCurrentMembership(supabase) : null;
  const editable = membership ? canEdit(membership.role) : false;
  const { data: profile } =
    user && membership && editable
      ? await supabase
          .from("profiles")
          .select("default_author")
          .eq("owner_id", user.id)
          .maybeSingle()
      : { data: null };

  // ＋ シートの先頭に出す「きょうの予定を完了にする」（D34）。
  // 予定が無ければ今までどおり（2 タップのまま）
  const todayStr = jstTodayISO();
  const schedule =
    membership && editable
      ? await fetchSchedule(supabase, membership.householdId, todayStr, todayStr)
      : EMPTY_SCHEDULE;
  const plan = planOnDate(
    itemsOnDate({
      date: todayStr,
      records: schedule.records,
      rules: schedule.rules,
      ruleAssignees: schedule.ruleAssignees,
      skippedDates: schedule.skippedDates,
    }),
  );
  const todayPlan = plan
    ? {
        recordId: plan.fromRule ? "" : plan.id,
        date: todayStr,
        source: plan.source,
        label: SOURCE_LABEL[plan.source],
        start: plan.start,
        end: plan.end,
        body: plan.body,
        who: plan.who,
      }
    : null;

  return (
    <>
      {/* 他タブで世帯が切り替わったらこのレイアウトごと再取得する（UC-H08） */}
      <HouseholdSyncRefresher householdId={membership?.householdId ?? null} />
      {/* クイック記録シート表示中に inert になる範囲（シート自身は外に置く） */}
      <div data-quick-record-bg>
        {/* 記録フォーム（全画面モーダル型）ではヘッダーを出さない */}
        <Suspense fallback={null}>
          <HideOnFormRoute>
            <AppHeader />
          </HideOnFormRoute>
        </Suspense>
        {children}
      </div>
      {membership && (
        <Suspense fallback={null}>
          <AppTabBar readOnly={!editable} />
        </Suspense>
      )}
      {membership && editable && (
        <QuickRecordSheet
          action={createQuickRecord}
          householdId={membership.householdId}
          defaultAuthor={profile?.default_author ?? ""}
          todayPlan={todayPlan}
        />
      )}
    </>
  );
}
