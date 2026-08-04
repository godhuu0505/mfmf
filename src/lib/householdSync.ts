// 「現在の世帯」切替（UC-H08）のタブ間同期。
// 世帯 Cookie は切り替わっても、他タブでマウント済みの (app)/layout.tsx
// （クイック記録シートの household_id を含む）はソフトナビゲーションでは
// 再描画されない。切替をブロードキャストし、受け取ったタブは router.refresh()
// でレイアウトごと最新の世帯に追従させる。

export const HOUSEHOLD_SYNC_CHANNEL = "mfmf:household-switch";

export function broadcastHouseholdSwitch(householdId: string): void {
  if (typeof BroadcastChannel === "undefined") return;
  const bc = new BroadcastChannel(HOUSEHOLD_SYNC_CHANNEL);
  bc.postMessage({ householdId });
  bc.close();
}
