import { describe, expect, it } from "vitest";
import {
  defaultTimesFor,
  itemsOnDate,
  minutesOf,
  planOnDate,
  rolesFor,
  ruleForDate,
  sortItems,
  timeProblem,
  toHHMM,
  weekdayOf,
} from "@/lib/schedule";
import type { ScheduleRule } from "@/types/database";

function rule(p: Partial<ScheduleRule> & Pick<ScheduleRule, "weekday" | "since">): ScheduleRule {
  return {
    id: `${p.weekday}-${p.since}`,
    household_id: "h",
    kind: "daycare",
    start_time: "09:00:00",
    end_time: "18:00:00",
    created_by: "u",
    created_at: "",
    updated_at: "",
    ...p,
  };
}

describe("weekdayOf", () => {
  it("実行 TZ に依らず曜日を返す", () => {
    expect(weekdayOf("2026-08-09")).toBe(0); // 日
    expect(weekdayOf("2026-08-10")).toBe(1); // 月
    expect(weekdayOf("2026-08-15")).toBe(6); // 土
  });
});

describe("toHHMM / minutesOf", () => {
  it("秒つきの time を HH:MM にする", () => {
    expect(toHHMM("09:30:00")).toBe("09:30");
    expect(toHHMM("09:30")).toBe("09:30");
    expect(toHHMM(null)).toBeNull();
    expect(toHHMM("")).toBeNull();
  });
  it("分に直す。不正は null", () => {
    expect(minutesOf("09:30")).toBe(570);
    expect(minutesOf("24:00")).toBeNull();
    expect(minutesOf("09:60")).toBeNull();
    expect(minutesOf("")).toBeNull();
  });
});

describe("ruleForDate", () => {
  const rules = [
    rule({ weekday: 1, since: "2026-08-01", kind: "daycare" }),
    rule({ weekday: 1, since: "2026-08-15", kind: "home" }),
  ];

  it("その日以前でいちばん新しい版が効く", () => {
    expect(ruleForDate(rules, "2026-08-10")?.kind).toBe("daycare");
    expect(ruleForDate(rules, "2026-08-17")?.kind).toBe("home");
  });

  it("since より前の日は前の版のまま（作り直しても過去を書き換えない）", () => {
    expect(ruleForDate(rules, "2026-08-03")?.kind).toBe("daycare");
  });

  it("いちばん古い版より前は効かない", () => {
    expect(ruleForDate(rules, "2026-07-27")).toBeNull();
  });

  it("墓標（kind = null）の版から先はルールなし", () => {
    const withTomb = [...rules, rule({ weekday: 1, since: "2026-08-22", kind: null, start_time: null, end_time: null })];
    expect(ruleForDate(withTomb, "2026-08-17")?.kind).toBe("home");
    expect(ruleForDate(withTomb, "2026-08-24")).toBeNull();
  });

  it("曜日が違えば効かない", () => {
    expect(ruleForDate(rules, "2026-08-11")).toBeNull(); // 火
  });
});

describe("timeProblem", () => {
  it("時刻なしは不備ではない", () => {
    expect(timeProblem({ start: null, end: null })).toBeNull();
  });
  it("片方だけは不備", () => {
    expect(timeProblem({ start: "09:00", end: null })).toBe(
      "開始と終了の時刻を入れてください",
    );
  });
  it("終了が開始以前は不備", () => {
    expect(timeProblem({ start: "09:00", end: "09:00" })).toBe(
      "終了は開始より後にしてください",
    );
    expect(timeProblem({ start: "18:00", end: "09:00" })).toBe(
      "終了は開始より後にしてください",
    );
  });
  it("正しい範囲は通る", () => {
    expect(timeProblem({ start: "09:00", end: "18:00" })).toBeNull();
  });
});

describe("rolesFor / defaultTimesFor", () => {
  it("種類に必要な担当だけを返す", () => {
    expect(rolesFor("daycare")).toEqual(["drop", "pick"]);
    expect(rolesFor("home")).toEqual(["care"]);
    expect(rolesFor("salon")).toEqual(["drop", "pick"]);
    expect(rolesFor("other")).toEqual([]);
  });
  it("種類ごとの既定の時間帯がある", () => {
    expect(defaultTimesFor("daycare")).toEqual({ start: "09:00", end: "18:00" });
    expect(defaultTimesFor("clinic")).toEqual({ start: "09:30", end: "11:00" });
  });
});

describe("itemsOnDate", () => {
  const rules = [rule({ weekday: 1, since: "2026-08-01", kind: "daycare" })];
  const ruleAssignees = { "1-2026-08-01": { drop: "u2", pick: "u1" } };

  const record = (over: Partial<Parameters<typeof itemsOnDate>[0]["records"][number]> = {}) => ({
    id: "r1",
    record_date: "2026-08-10",
    source: "other" as const,
    status: "done" as const,
    start_time: null,
    end_time: null,
    overrides_rule: false,
    body: "おやつ",
    ...over,
  });

  it("記録を足しても曜日ルールの予定は消えない", () => {
    const items = itemsOnDate({ date: "2026-08-10", records: [record()], rules, ruleAssignees });
    expect(items).toHaveLength(2);
    expect(items.some((x) => x.fromRule)).toBe(true);
  });

  it("ルール由来には担当が乗る", () => {
    const items = itemsOnDate({ date: "2026-08-10", records: [], rules, ruleAssignees });
    expect(items[0].who).toEqual({ drop: "u2", pick: "u1" });
    expect(items[0].start).toBe("09:00");
  });

  it("その日の予定として保存し直したらルールは隠れる", () => {
    const items = itemsOnDate({
      date: "2026-08-10",
      records: [record({ overrides_rule: true, status: "planned", source: "clinic" })],
      rules,
      ruleAssignees,
    });
    expect(items).toHaveLength(1);
    expect(items[0].fromRule).toBe(false);
  });

  it("打ち消した日はルールが出ない", () => {
    const items = itemsOnDate({
      date: "2026-08-10",
      records: [],
      rules,
      skippedDates: new Set(["2026-08-10"]),
    });
    expect(items).toHaveLength(0);
  });

  it("他の日の記録は混ざらない", () => {
    const items = itemsOnDate({
      date: "2026-08-10",
      records: [record({ id: "r2", record_date: "2026-08-11" })],
      rules,
    });
    expect(items.every((x) => x.date === "2026-08-10")).toBe(true);
  });
});

describe("sortItems / planOnDate", () => {
  const base = {
    date: "2026-08-10",
    source: "other" as const,
    body: "",
    photoCount: 0,
    who: {},
    fromRule: false,
  };

  it("時刻なしが先、あとは開始の早い順", () => {
    const sorted = sortItems([
      { ...base, id: "b", status: "done", start: "13:00", end: "14:00" },
      { ...base, id: "a", status: "done", start: null, end: null },
      { ...base, id: "c", status: "planned", start: "09:00", end: "10:00" },
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  it("予定があれば予定を返す。記録だけの日は null（記録を予定として開かない）", () => {
    const done = { ...base, id: "d", status: "done" as const, start: null, end: null };
    const planned = { ...base, id: "p", status: "planned" as const, start: "09:00", end: "10:00" };
    expect(planOnDate([done, planned])?.id).toBe("p");
    expect(planOnDate([done])).toBeNull();
    expect(planOnDate([])).toBeNull();
  });
});
