import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ChevronRight,
  CircleHelp,
  PawPrint,
  Scale,
  UserRound,
  Users,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership, type HouseholdRole } from "@/lib/household";
import { hasActiveGuestGrant } from "@/lib/guest";
import AppHeader from "@/components/AppHeader";
import FeedbackWidget from "@/components/FeedbackWidget";
import MenuLogoutItem from "@/components/MenuLogoutItem";

export const metadata: Metadata = { title: "メニュー" };
export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<HouseholdRole, string> = {
  owner: "オーナー",
  editor: "編集者",
  viewer: "閲覧者",
};

// メニュータブの着地点（D33）。体重・ペット・世帯設定・ガイド・フィードバックを
// ここに集約し、どの画面からも 2 タップ以内で届くようにする（UC-M01）。
export default async function MenuPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getCurrentMembership(supabase);
  if (!membership) {
    if (await hasActiveGuestGrant(supabase, user.id)) redirect("/guest");
    redirect("/onboarding");
  }

  const [{ data: profile }, { data: household }] = await Promise.all([
    supabase
      .from("profiles")
      .select("display_name")
      .eq("owner_id", user.id)
      .maybeSingle(),
    supabase
      .from("households")
      .select("name")
      .eq("id", membership.householdId)
      .maybeSingle(),
  ]);

  const displayName = profile?.display_name || user.email || "アカウント";
  const initial = displayName.trim().charAt(0).toUpperCase();
  const householdLine = household?.name
    ? `${household.name}（${ROLE_LABEL[membership.role]}）`
    : ROLE_LABEL[membership.role];

  const rowClass =
    "flex w-full items-center gap-3 px-4 py-3.5 text-sm font-medium text-foreground transition hover:bg-surface-muted";
  const iconClass = "h-5 w-5 text-muted-foreground";
  const chevron = (
    <ChevronRight
      className="ml-auto h-5 w-5 text-muted-foreground"
      aria-hidden="true"
    />
  );

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-2xl space-y-4 px-4 py-6">
        <h1 className="sr-only">メニュー</h1>

        {/* プロフィール（→ アカウント設定） */}
        <Link
          href="/settings/account"
          className="flex w-full items-center gap-3 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-border transition hover:bg-surface-muted"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground">
            {initial || <UserRound className="h-6 w-6" aria-hidden="true" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold text-foreground">
              {displayName}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {householdLine}
            </span>
          </span>
          {chevron}
        </Link>

        {/* 記録データ */}
        <div className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-border">
          <Link href="/pets" className={rowClass}>
            <PawPrint className={iconClass} aria-hidden="true" />
            ペット
            {chevron}
          </Link>
          <div className="border-t border-border" />
          <Link href="/weight" className={rowClass}>
            <Scale className={iconClass} aria-hidden="true" />
            体重の推移
            {chevron}
          </Link>
        </div>

        {/* 世帯 */}
        <div className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-border">
          <Link href="/settings" className={rowClass}>
            <Users className={iconClass} aria-hidden="true" />
            世帯の設定
            {chevron}
          </Link>
        </div>

        {/* サポート */}
        <div className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-border">
          <Link href="/help" className={rowClass}>
            <CircleHelp className={iconClass} aria-hidden="true" />
            使い方ガイド
            {chevron}
          </Link>
          <div className="border-t border-border" />
          {/* フローティングボタンは廃止し、フィードバックの入口はここに一本化（D33） */}
          <FeedbackWidget variant="row" />
        </div>

        <MenuLogoutItem />
      </main>
    </>
  );
}
