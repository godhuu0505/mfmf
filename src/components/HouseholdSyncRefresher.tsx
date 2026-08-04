"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { HOUSEHOLD_SYNC_CHANNEL } from "@/lib/householdSync";

// 永続レイアウト（(app)/layout.tsx のタブバー・クイック記録シート）を
// 世帯・role の変化に追従させる。
// - 同一ブラウザの他タブでの「現在の世帯」切替: BroadcastChannel で即時に refresh
//   （src/lib/householdSync.ts）
// - 別デバイスの owner による role 変更など、こちらへ通知が届かない変化:
//   タブがフォーカスを取り戻したときに refresh して拾う（サーバー側の認可は
//   Server Action / RLS が常に強制しており、これは表示の追従のみ）
export default function HouseholdSyncRefresher({
  householdId,
}: {
  /** このタブのレイアウトが描画された時点の世帯 id（未所属は null） */
  householdId: string | null;
}) {
  const router = useRouter();
  // 直近の refresh 時刻。フォーカスのたびに連打しないよう間隔を空ける。
  const lastRefreshAt = useRef(0);

  useEffect(() => {
    const refresh = () => {
      const now = Date.now();
      if (now - lastRefreshAt.current < 10_000) return;
      lastRefreshAt.current = now;
      router.refresh();
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    let bc: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      bc = new BroadcastChannel(HOUSEHOLD_SYNC_CHANNEL);
      bc.onmessage = (e: MessageEvent) => {
        const next = (e.data as { householdId?: unknown } | null)?.householdId;
        // 世帯切替は間隔に関係なく即時反映する
        if (typeof next === "string" && next !== householdId) {
          lastRefreshAt.current = Date.now();
          router.refresh();
        }
      };
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      bc?.close();
    };
  }, [householdId, router]);

  return null;
}
