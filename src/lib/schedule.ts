// 予定（D34）の純粋関数。DB も Supabase も触らない ——
// 「毎週のルールがその日にどう効くか」「予定と記録をどう並べるか」「時刻が正しいか」
// はここだけで決まるようにして、Unit テスト（tests/unit/schedule.test.ts）で守る。

import {
  SOURCE_DEFAULT_TIME,
  SOURCE_ROLES,
  type AssigneeRole,
  type RecordSource,
  type RecordStatus,
  type ScheduleRule,
} from "@/types/database";

/** YYYY-MM-DD の曜日（0=日）。Date の TZ に依存させないため暦計算で出す。 */
export function weekdayOf(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "HH:MM:SS" / "HH:MM" を "HH:MM" に。null はそのまま。 */
export function toHHMM(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{2}):(\d{2})/.exec(value);
  return m ? `${m[1]}:${m[2]}` : null;
}

/** "HH:MM" を 0:00 からの分に。空・不正は null。 */
export function minutesOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * その日に効くルールの版。
 * since がその日以前で**いちばん新しい**版を採り、それが墓標（kind = null）なら
 * 「その日はルールなし」。作り直しても since より前の日は前の版のまま効く。
 */
export function ruleForDate(
  rules: ScheduleRule[],
  iso: string,
): ScheduleRule | null {
  const w = weekdayOf(iso);
  let best: ScheduleRule | null = null;
  for (const r of rules) {
    if (r.weekday !== w) continue;
    if (r.since > iso) continue;
    if (!best || r.since >= best.since) best = r;
  }
  return best && best.kind ? best : null;
}

/** その種類で決める担当の役割（おでかけ・その他は無し）。 */
export function rolesFor(source: RecordSource): AssigneeRole[] {
  return SOURCE_ROLES[source] ?? [];
}

/** 種類ごとの既定の時間帯。 */
export function defaultTimesFor(source: RecordSource): {
  start: string;
  end: string;
} {
  return SOURCE_DEFAULT_TIME[source];
}

/**
 * 時刻の不備。保存・完了・見送りのすべてがこれを通る（別々に書くと条件がずれる）。
 * 時刻なし（両方空）は不備ではない。
 */
export function timeProblem(input: {
  start: string | null;
  end: string | null;
}): string | null {
  const { start, end } = input;
  if (!start && !end) return null;
  if (!start || !end) return "開始と終了の時刻を入れてください";
  const s = minutesOf(start);
  const e = minutesOf(end);
  if (s === null || e === null) return "時刻の形式が正しくありません";
  if (e <= s) return "終了は開始より後にしてください";
  return null;
}

/** カレンダーに並べる 1 件（保存済みの行、または曜日ルール由来の予定）。 */
export type ScheduleItem = {
  id: string;
  date: string;
  source: RecordSource;
  status: RecordStatus;
  start: string | null;
  end: string | null;
  body: string;
  photoCount: number;
  who: Partial<Record<AssigneeRole, string>>;
  /** 曜日ルールから作った仮の行（DB には無い）。保存すると実体になる */
  fromRule: boolean;
};

export type SavedRecordInput = {
  id: string;
  record_date: string;
  source: RecordSource;
  status: RecordStatus;
  start_time: string | null;
  end_time: string | null;
  overrides_rule: boolean;
  body: string;
  photoCount?: number;
  who?: Partial<Record<AssigneeRole, string>>;
};

/** ルール由来の仮 id。実体の UUID とぶつからない形にしておく。 */
export function ruleItemId(iso: string): string {
  return `rule:${iso}`;
}

export function isRuleItemId(id: string): boolean {
  return id.startsWith("rule:");
}

/**
 * その日に並べるもの。保存済みの行に、曜日ルール由来の予定を足して返す。
 *
 * ルールを隠すのは「その日の予定として保存し直した（overrides_rule）」ときと、
 * その日を打ち消した（skips）ときだけ。保存済みが 1 件でもあれば隠す作りにすると、
 * 無関係なクイック記録を 1 件足しただけでその日の保育園の予定と担当が消える。
 */
export function itemsOnDate(input: {
  date: string;
  records: SavedRecordInput[];
  rules: ScheduleRule[];
  ruleAssignees?: Record<string, Partial<Record<AssigneeRole, string>>>;
  skippedDates?: ReadonlySet<string>;
}): ScheduleItem[] {
  const { date, records, rules, ruleAssignees = {}, skippedDates } = input;
  const saved = records
    .filter((r) => r.record_date === date)
    .map<ScheduleItem>((r) => ({
      id: r.id,
      date: r.record_date,
      source: r.source,
      status: r.status,
      start: toHHMM(r.start_time),
      end: toHHMM(r.end_time),
      body: r.body,
      photoCount: r.photoCount ?? 0,
      who: r.who ?? {},
      fromRule: false,
    }));

  const overridden =
    (skippedDates?.has(date) ?? false) ||
    records.some((r) => r.record_date === date && r.overrides_rule);
  const rule = overridden ? null : ruleForDate(rules, date);
  const list = rule
    ? [
        ...saved,
        {
          id: ruleItemId(date),
          date,
          source: rule.kind as RecordSource,
          status: "planned" as RecordStatus,
          start: toHHMM(rule.start_time),
          end: toHHMM(rule.end_time),
          body: "",
          photoCount: 0,
          who: ruleAssignees[rule.id] ?? {},
          fromRule: true,
        },
      ]
    : saved;

  return sortItems(list);
}

/** 時刻なしを先に、あとは開始時刻の早い順。 */
export function sortItems(items: ScheduleItem[]): ScheduleItem[] {
  return [...items].sort(
    (a, b) =>
      (a.start ? 1 : 0) - (b.start ? 1 : 0) ||
      (a.start ?? "").localeCompare(b.start ?? "") ||
      (a.end ?? "").localeCompare(b.end ?? ""),
  );
}

/**
 * その日の「予定」。編集シートや担当のまとめ入力が扱う 1 件。
 * 記録だけを足した日でも、ルール由来の予定はここに出る。
 */
export function planOnDate(items: ScheduleItem[]): ScheduleItem | null {
  return items.find((x) => x.status === "planned") ?? items[0] ?? null;
}
