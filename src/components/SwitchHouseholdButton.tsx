"use client";

import { useTransition } from "react";
import { switchHousehold } from "@/app/(app)/settings/actions";
import { broadcastHouseholdSwitch } from "@/lib/householdSync";

// 「この世帯を表示」（UC-H08）。Server Action が完了（= 世帯 Cookie が適用）
// した後で他タブへブロードキャストする。先に投げると、受信タブが旧 Cookie の
// まま refresh してしまい、その後の変化を拾う機会がない。
// 自タブは action の revalidate + redirect が追従させる（BroadcastChannel は
// 送信元タブには届かない）。
export default function SwitchHouseholdButton({
  householdId,
  className,
  children,
}: {
  householdId: string;
  className: string;
  children: React.ReactNode;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      className={className}
      onClick={() =>
        startTransition(async () => {
          try {
            await switchHousehold(householdId);
          } finally {
            // redirect（throw）でも通知は必ず出す。切替が弾かれた場合の余分な
            // refresh は無害（各タブは自分の実世帯を再取得するだけ）。
            broadcastHouseholdSwitch(householdId);
          }
        })
      }
    >
      {pending ? "切替中…" : children}
    </button>
  );
}
