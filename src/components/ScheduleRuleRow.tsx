"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import {
  ASSIGNEE_ROLE_LABEL,
  RECORD_SOURCES,
  SOURCE_EMOJI,
  SOURCE_LABEL,
  type AssigneeRole,
  type RecordSource,
} from "@/types/database";
import { defaultTimesFor, rolesFor } from "@/lib/schedule";
import { saveRule } from "@/app/(app)/schedule/actions";

type Member = { id: string; name: string };

type Props = {
  weekday: number;
  label: string;
  today: string;
  householdId: string | null;
  /** 今日に効いている版（無ければ null） */
  current: {
    source: RecordSource;
    start: string | null;
    end: string | null;
    who: Partial<Record<AssigneeRole, string>>;
  } | null;
  members: Member[];
  editable: boolean;
};

function SaveButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-surface-muted disabled:opacity-50"
    >
      {label}曜を今日から変える
    </button>
  );
}

/**
 * 曜日 1 行ぶんの編集。担当欄は「いま選んでいる種類」に追従させる ——
 * サーバー側の種類で出し分けると、なし → 保育園に変えたときに送り／お迎えの欄が
 * 無いまま保存され、担当を入れるのに 2 回保存する羽目になる。
 */
export default function ScheduleRuleRow({
  weekday,
  label,
  today,
  householdId,
  current,
  members,
  editable,
}: Props) {
  const [source, setSource] = useState<RecordSource | "none">(
    current?.source ?? "none",
  );
  const [start, setStart] = useState(current?.start ?? "");
  const [end, setEnd] = useState(current?.end ?? "");
  const [who, setWho] = useState<Partial<Record<AssigneeRole, string>>>(
    current?.who ?? {},
  );
  // 時刻を手で触ったか。触るまでは種類の既定に追従する（proto/schedule で合意）
  const [timeDirty, setTimeDirty] = useState(current != null);

  const roles = source === "none" ? [] : rolesFor(source);

  function pickSource(next: RecordSource | "none") {
    setSource(next);
    if (next === "none") return;
    // 触っていないあいだは種類の既定に追従する。保育園のまま病院に変えると
    // 09:00〜18:00 の通院になってしまう
    if (!timeDirty || !start || !end) {
      const t = defaultTimesFor(next);
      setStart(t.start);
      setEnd(t.end);
    }
  }

  return (
    <form action={saveRule} className="space-y-3">
      <input type="hidden" name="weekday" value={weekday} />
      <input type="hidden" name="since" value={today} />
      {householdId && (
        <input type="hidden" name="household_id" value={householdId} />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="w-8 shrink-0 text-sm font-bold">{label}曜</span>
        <label className="sr-only" htmlFor={`source-${weekday}`}>
          {label}曜の種類
        </label>
        <select
          id={`source-${weekday}`}
          name="source"
          value={source}
          onChange={(e) => pickSource(e.target.value as RecordSource | "none")}
          disabled={!editable}
          className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
        >
          <option value="none">なし</option>
          {RECORD_SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_EMOJI[s]} {SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
        {source !== "none" && (
          <>
            <input
              type="time"
              name="start_time"
              aria-label={`${label}曜の開始時刻`}
              value={start}
              onChange={(e) => {
                setTimeDirty(true);
                setStart(e.target.value);
              }}
              disabled={!editable}
              className="w-28 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm tabular-nums"
            />
            <span className="text-sm text-muted-foreground">〜</span>
            <input
              type="time"
              name="end_time"
              aria-label={`${label}曜の終了時刻`}
              value={end}
              onChange={(e) => {
                setTimeDirty(true);
                setEnd(e.target.value);
              }}
              disabled={!editable}
              className="w-28 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm tabular-nums"
            />
          </>
        )}
      </div>

      {roles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pl-10">
          {roles.map((role) => (
            <label key={role} className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">
                {ASSIGNEE_ROLE_LABEL[role]}
              </span>
              <select
                name={`who_${role}`}
                value={who[role] ?? ""}
                onChange={(e) =>
                  setWho((w) => ({ ...w, [role]: e.target.value || undefined }))
                }
                disabled={!editable}
                aria-label={`${label}曜の${ASSIGNEE_ROLE_LABEL[role]}`}
                className="rounded-lg border border-border bg-surface px-2 py-1 text-xs"
              >
                <option value="">未定</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}

      {editable && <SaveButton label={label} />}
    </form>
  );
}
