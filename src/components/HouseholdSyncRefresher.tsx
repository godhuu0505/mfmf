"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { HOUSEHOLD_SYNC_CHANNEL } from "@/lib/householdSync";

// 永続レイアウト（(app)/layout.tsx のタブバー・クイック記録シート）を
// 世帯・role の変化に追従させる。サーバー側の認可は Server Action / RLS が
// 常に強制しており、ここは表示の追従のみ。
// - 同一ブラウザの他タブでの「現在の世帯」切替: BroadcastChannel で即時 refresh
//   （src/lib/householdSync.ts）
// - 別デバイスの owner による role 変更など、通知が届かない変化:
//   (a) タブがフォーカスを取り戻したとき
//   (b) ページ遷移のたび（60 秒スロットル。レイアウトはソフトナビでは再取得
//       されないため、ここで拾う）
//   (c) 可視のまま操作も遷移もないタブ向けの 5 分間隔
//   に refresh して拾う。
export default function HouseholdSyncRefresher({
  householdId,
}: {
  /** このタブのレイアウトが描画された時点の世帯 id（未所属は null） */
  householdId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // 直近の refresh 時刻。イベントが重なっても連打しないよう間隔を空ける。
  const lastRefreshAt = useRef(Date.now());

  useEffect(() => {
    const refresh = (minIntervalMs: number) => {
      const now = Date.now();
      if (now - lastRefreshAt.current < minIntervalMs) return;
      lastRefreshAt.current = now;
      router.refresh();
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") refresh(10_000);
    };
    document.addEventListener("visibilitychange", onVisible);

    const interval = setInterval(() => refresh(60_000), 5 * 60_000);

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
      clearInterval(interval);
      bc?.close();
    };
  }, [householdId, router]);

  // ページ遷移のたびに（スロットル付きで）レイアウトも追従させる。
  // 初回マウント直後は描画済みの内容が最新なのでスキップ。
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    const now = Date.now();
    if (now - lastRefreshAt.current < 60_000) return;
    lastRefreshAt.current = now;
    router.refresh();
  }, [pathname, router]);

  return null;
}
