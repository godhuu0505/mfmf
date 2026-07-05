"use client";

import SubmitButton from "@/components/SubmitButton";

// 世帯削除（UC-H09）の確認つきフォーム。誤操作防止に window.confirm を挟む。
// action は settings/page.tsx で householdId を bind 済みの Server Action を受け取る。
export default function DeleteHouseholdForm({
  action,
  householdName,
}: {
  action: () => void | Promise<void>;
  householdName: string;
}) {
  const label = householdName.trim() || "この世帯";
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (
          !window.confirm(
            `「${label}」を削除します。この操作は取り消せません。よろしいですか？`,
          )
        ) {
          e.preventDefault();
        }
      }}
    >
      <SubmitButton
        pendingLabel="削除中…"
        className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-60"
      >
        この世帯を削除する
      </SubmitButton>
    </form>
  );
}
