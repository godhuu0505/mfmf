import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { canEdit, getCurrentMembership } from "@/lib/household";
import AppHeader from "@/components/AppHeader";
import AppTabBar from "@/components/AppTabBar";
import CreateSheet from "@/components/CreateSheet";
import HideOnFormRoute from "@/components/HideOnFormRoute";
import HouseholdSyncRefresher from "@/components/HouseholdSyncRefresher";

// アプリ内画面（要ログイン圏）の共通クローム（D33）。
// - ヘッダー / ボトムタブバー / 作成シートをここで一元描画する。
//   ページ内マウントだとシート表示中の inert がページごとに漏れるため、
//   レイアウトに置く。
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

  return (
    <>
      {/* 他タブで世帯が切り替わったらこのレイアウトごと再取得する（UC-H08） */}
      <HouseholdSyncRefresher householdId={membership?.householdId ?? null} />
      {/* シート表示中に inert になる範囲（シート自身は外に置く） */}
      <div data-app-modal-bg>
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
      {/* 検索パラメータを読まないので Suspense は要らない（AppTabBar とは違う） */}
      {membership && editable && <CreateSheet />}
    </>
  );
}
