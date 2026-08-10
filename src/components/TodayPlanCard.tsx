import Link from "next/link";
import { Check } from "lucide-react";
import {
  ASSIGNEE_ROLE_LABEL,
  SOURCE_EMOJI,
  SOURCE_LABEL,
  STATUS_LABEL,
  type AssigneeRole,
  type RecordSource,
  type RecordStatus,
} from "@/types/database";
import { rolesFor } from "@/lib/schedule";
import SubmitButton from "@/components/SubmitButton";
import { completePlan } from "@/app/(app)/schedule/actions";

export type TodayPlan = {
  id: string;
  date: string;
  source: RecordSource;
  status: RecordStatus;
  start: string | null;
  end: string | null;
  body: string;
  who: Partial<Record<AssigneeRole, string>>;
  fromRule: boolean;
  /** ルール由来を完了するときに作る行の id（押し直しても増やさない） */
  draftId: string;
};

type Props = {
  plan: TodayPlan | null;
  /** 世帯に 2 頭以上いるか。ルール由来の完了はどの子か選べないので出さない */
  multiPet?: boolean;
  today: string;
  members: { id: string; name: string; initial: string }[];
  canEdit: boolean;
  householdId: string | null;
};

/**
 * ホームの「きょう」カード。今日の予定を出し、そのまま記録にできる（D34）。
 * 予定が無い日はカレンダーへ誘導するだけにして、タブは増やさない。
 */
export default function TodayPlanCard({
  plan,
  today,
  members,
  canEdit,
  householdId,
  multiPet = false,
}: Props) {
  if (!plan) {
    return (
      <div className="mb-4 rounded-2xl border border-dashed border-border p-4 text-center">
        <p className="text-sm text-muted-foreground">
          きょうの予定はまだありません。
        </p>
        {canEdit && (
          <Link
            href="/calendar"
            className="mt-2 inline-block rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground"
          >
            予定を入れる
          </Link>
        )}
      </div>
    );
  }

  const roles = rolesFor(plan.source);
  const memberOf = (id?: string) => members.find((m) => m.id === id);

  return (
    <div className="mb-4 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-border">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-muted-foreground">きょう</p>
        <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {STATUS_LABEL[plan.status]}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <span className="text-3xl" aria-hidden="true">
          {SOURCE_EMOJI[plan.source]}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold">{SOURCE_LABEL[plan.source]}</p>
          <p className="text-xs tabular-nums text-muted-foreground">
            {plan.start && plan.end ? `${plan.start}〜${plan.end}` : "時刻なし"}
            {plan.body ? `・${plan.body}` : ""}
          </p>
        </div>
      </div>

      {roles.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          {roles.map((role) => {
            const m = memberOf(plan.who[role]);
            return (
              <span
                key={role}
                className="flex items-center gap-1.5 rounded-full bg-surface-muted py-1 pl-1 pr-3 text-xs"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                  {m?.initial ?? "?"}
                </span>
                <span className="text-muted-foreground">
                  {ASSIGNEE_ROLE_LABEL[role]}
                </span>
                <span className="font-bold">{m?.name ?? "未定"}</span>
              </span>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        {/* ルール由来の予定はまだ行が無いので、どの子かをここで選べない。
            2 頭以上いる世帯ではカレンダーの日別シートへ回す */}
        {canEdit &&
          plan.status === "planned" &&
          !(plan.fromRule && multiPet) && (
            // 完了は種類・時刻・担当をそのまま引き継ぐ（書き直させない）
            <form action={completePlan} className="flex-1">
              {/* 近道は描画時点の写し。保存済みの行に対しては状態だけ進める */}
              <input type="hidden" name="shortcut" value="1" />
              <input
                type="hidden"
                name="record_id"
                value={plan.fromRule ? "" : plan.id}
              />
              {/* ルール由来を完了するときは新しい行を作る。押し直しても同じ id に
                上書きされるよう、id はここで決めておく */}
              {plan.fromRule && (
                <input type="hidden" name="draft_id" value={plan.draftId} />
              )}
              <input type="hidden" name="record_date" value={today} />
              <input type="hidden" name="source" value={plan.source} />
              <input type="hidden" name="start_time" value={plan.start ?? ""} />
              <input type="hidden" name="end_time" value={plan.end ?? ""} />
              <input type="hidden" name="body" value={plan.body} />
              {(["drop", "pick", "care"] as AssigneeRole[]).map((role) => (
                <input
                  key={role}
                  type="hidden"
                  name={`who_${role}`}
                  value={plan.who[role] ?? ""}
                />
              ))}
              {householdId && (
                <input type="hidden" name="household_id" value={householdId} />
              )}
              {/* 1 日に何件でも持てる設計なので、二重送信は一意制約に当たらず
                そのまま 2 件の記録になる。押下中は塞ぐ */}
              <SubmitButton
                pendingLabel="記録にしています…"
                className="w-full rounded-xl border-2 border-emerald-600 py-2.5 text-sm font-bold text-emerald-800 transition hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-400 dark:text-emerald-300 dark:hover:bg-emerald-950"
              >
                <Check className="mr-1 inline h-4 w-4" aria-hidden="true" />
                完了して記録にする
              </SubmitButton>
            </form>
          )}
        <Link
          href="/calendar"
          className="flex-1 rounded-xl border border-border py-2.5 text-center text-sm font-medium transition hover:bg-surface-muted"
        >
          {plan.status === "planned" ? "予定を見る・変える" : "詳しく見る"}
        </Link>
      </div>
    </div>
  );
}
