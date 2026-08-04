"use client";

import { usePathname, useSearchParams } from "next/navigation";

// 記録フォーム（新規 / 編集）は全画面モーダル型（proto 合意 / notes.md）。
// フォーム表示中は共有クローム（ヘッダー等）を出さず、離脱は確認つきの
// キャンセルに一本化する —— ロゴやメニューから下書きを黙って失わないため。
// 判定は AppTabBar と同じ規則（/records/new と ?edit=1）。
export default function HideOnFormRoute({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isForm =
    pathname === "/records/new" ||
    (pathname.startsWith("/records/") && searchParams.get("edit") === "1");
  if (isForm) return null;
  return <>{children}</>;
}
