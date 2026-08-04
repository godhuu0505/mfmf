"use client";

import { useTransition } from "react";
import { switchHousehold } from "@/app/(app)/settings/actions";
import { broadcastHouseholdSwitch } from "@/lib/householdSync";

// 「この世帯を表示」（UC-H08）。切替を他タブへブロードキャストしてから
// Server Action を呼ぶ（自タブは action の revalidate + redirect が追従させる。
// BroadcastChannel は送信元タブには届かない）。
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
          // action は redirect で戻らないことがあるため、先に通知する。
          // 切替が弾かれるのはメンバーでない場合だけで、その場合の余分な
          // refresh は無害（各タブは自分の実世帯を再取得するだけ）。
          broadcastHouseholdSwitch(householdId);
          await switchHousehold(householdId);
        })
      }
    >
      {pending ? "切替中…" : children}
    </button>
  );
}
