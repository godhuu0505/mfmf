"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { HOUSEHOLD_SYNC_CHANNEL } from "@/lib/householdSync";

// 他タブでの「現在の世帯」切替を受けて、このタブのレイアウトを再取得する
// （src/lib/householdSync.ts 参照）。(app)/layout.tsx にマウントする。
export default function HouseholdSyncRefresher({
  householdId,
}: {
  /** このタブのレイアウトが描画された時点の世帯 id（未所属は null） */
  householdId: string | null;
}) {
  const router = useRouter();

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel(HOUSEHOLD_SYNC_CHANNEL);
    bc.onmessage = (e: MessageEvent) => {
      const next = (e.data as { householdId?: unknown } | null)?.householdId;
      if (typeof next === "string" && next !== householdId) router.refresh();
    };
    return () => bc.close();
  }, [householdId, router]);

  return null;
}
