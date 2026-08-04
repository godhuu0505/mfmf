import { describe, expect, it } from "vitest";
import { jstTodayISO, minusMonthsISO } from "@/lib/dateRange";

describe("jstTodayISO", () => {
  it("UTC 深夜でも JST の日付になる", () => {
    // 2026-01-31T20:00Z は JST では 2/1 05:00
    expect(jstTodayISO(new Date("2026-01-31T20:00:00Z"))).toBe("2026-02-01");
    expect(jstTodayISO(new Date("2026-01-31T10:00:00Z"))).toBe("2026-01-31");
  });
});

describe("minusMonthsISO", () => {
  it("同日がある月はそのまま同日", () => {
    expect(minusMonthsISO("2026-08-04", 1)).toBe("2026-07-04");
    expect(minusMonthsISO("2026-08-04", 3)).toBe("2026-05-04");
  });

  it("年をまたぐ", () => {
    expect(minusMonthsISO("2026-02-15", 3)).toBe("2025-11-15");
    expect(minusMonthsISO("2026-08-04", 12)).toBe("2025-08-04");
    expect(minusMonthsISO("2026-01-01", 1)).toBe("2025-12-01");
  });

  it("相手の月に同日が無ければ月末に丸める", () => {
    expect(minusMonthsISO("2026-03-31", 1)).toBe("2026-02-28");
    expect(minusMonthsISO("2024-03-31", 1)).toBe("2024-02-29"); // うるう年
    expect(minusMonthsISO("2026-07-31", 1)).toBe("2026-06-30");
    expect(minusMonthsISO("2028-02-29", 12)).toBe("2027-02-28");
  });
});
