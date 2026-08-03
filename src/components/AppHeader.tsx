import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import { canEdit, getCurrentMembership } from "@/lib/household";
import { createQuickRecord } from "@/app/records/actions";
import AccountMenu from "@/components/AccountMenu";
import AppTabBar from "@/components/AppTabBar";
import QuickRecordSheet from "@/components/QuickRecordSheet";

// 共通ヘッダー + アプリのクローム（ボトムタブバー / クイック記録シート）。
// 主要ナビはボトムタブバー（D33）。ヘッダーはロゴとアカウントメニューだけの薄い帯。
// 世帯に所属していないユーザー（招待受諾前など）にはタブバーを出さない。
export default async function AppHeader() {
  // アバターに表示名/メールの頭文字を出すため、現在のユーザーと表示名を取得する。
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase
        .from("profiles")
        .select("display_name, default_author")
        .eq("owner_id", user.id)
        .maybeSingle()
    : { data: null };

  const membership = user ? await getCurrentMembership(supabase) : null;
  const editable = membership ? canEdit(membership.role) : false;

  return (
    <>
      <header
        data-quick-record-bg
        className="safe-pt sticky top-0 z-10 border-b border-border bg-surface/80 backdrop-blur"
      >
        <div className="safe-px mx-auto flex max-w-2xl items-center justify-between py-3">
          <Link
            href="/"
            className="flex items-center gap-2 text-lg font-bold text-foreground"
          >
            <Image
              src="/icon-192.png"
              alt=""
              width={28}
              height={28}
              className="rounded-lg"
              priority
            />
            mfmf
          </Link>
          <AccountMenu
            email={user?.email ?? null}
            displayName={profile?.display_name ?? null}
          />
        </div>
      </header>

      {membership && <AppTabBar readOnly={!editable} />}
      {membership && editable && (
        <QuickRecordSheet
          action={createQuickRecord}
          householdId={membership.householdId}
          defaultAuthor={profile?.default_author ?? ""}
        />
      )}
    </>
  );
}
