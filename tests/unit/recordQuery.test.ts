import { describe, expect, it } from "vitest";
import {
  buildIlikeOr,
  buildQueryString,
  hasActiveFilters,
  parseFilters,
  type RecordFilters,
} from "@/lib/recordQuery";

const DEFAULTS: RecordFilters = {
  q: "",
  from: "",
  to: "",
  source: "all",
  sort: "date_desc",
  page: 1,
};

// buildQueryString の出力（"?q=..."）を parseFilters の入力形式に戻す。
// URL に載せてリロードした状況の再現。
function roundTrip(f: RecordFilters): RecordFilters {
  const qs = buildQueryString(f);
  const sp: Record<string, string> = {};
  new URLSearchParams(qs).forEach((v, k) => {
    sp[k] = v;
  });
  return parseFilters(sp);
}

describe("parseFilters", () => {
  it("空の searchParams は安全な既定値になる", () => {
    expect(parseFilters({})).toEqual(DEFAULTS);
  });

  it("正しい値はそのまま通る", () => {
    expect(
      parseFilters({
        q: "ごはん",
        from: "2026-07-01",
        to: "2026-07-31",
        source: "daycare",
        sort: "weight_asc",
        page: "3",
      }),
    ).toEqual({
      q: "ごはん",
      from: "2026-07-01",
      to: "2026-07-31",
      source: "daycare",
      sort: "weight_asc",
      page: 3,
    });
  });

  it("配列値（同名クエリの重複）は先頭を採用する", () => {
    expect(parseFilters({ q: ["a", "b"] }).q).toBe("a");
  });

  it("q は trim し 100 文字に切り詰める（防御的制限）", () => {
    expect(parseFilters({ q: "  ねこ  " }).q).toBe("ねこ");
    expect(parseFilters({ q: "x".repeat(150) }).q).toBe("x".repeat(100));
  });

  it("日付は YYYY-MM-DD 形式以外を空に丸める", () => {
    for (const bad of ["2026/07/01", "20260701", "2026-7-1", "abc", "2026-07-01T00:00"]) {
      expect(parseFilters({ from: bad }).from).toBe("");
      expect(parseFilters({ to: bad }).to).toBe("");
    }
  });

  it("日付の検証は形式（正規表現）のみで意味は見ない（現状仕様の記録）", () => {
    // 桁が合えば通る。実在しない日付を弾く要件が生まれたらここを更新する。
    expect(parseFilters({ from: "9999-99-99" }).from).toBe("9999-99-99");
  });

  it("source は daycare / home 以外を all に丸める", () => {
    expect(parseFilters({ source: "daycare" }).source).toBe("daycare");
    expect(parseFilters({ source: "home" }).source).toBe("home");
    expect(parseFilters({ source: "evil" }).source).toBe("all");
    expect(parseFilters({ source: "" }).source).toBe("all");
  });

  it("sort は既知のキー以外を date_desc に丸める", () => {
    expect(parseFilters({ sort: "weight_desc" }).sort).toBe("weight_desc");
    expect(parseFilters({ sort: "DROP TABLE" }).sort).toBe("date_desc");
  });

  it("page は 1 以上の整数以外を 1 に丸める", () => {
    expect(parseFilters({ page: "0" }).page).toBe(1);
    expect(parseFilters({ page: "-2" }).page).toBe(1);
    expect(parseFilters({ page: "abc" }).page).toBe(1);
    expect(parseFilters({ page: "" }).page).toBe(1);
    expect(parseFilters({ page: "2.9" }).page).toBe(2); // parseInt の切り捨て
    expect(parseFilters({ page: "42" }).page).toBe(42);
  });
});

describe("buildQueryString", () => {
  it("既定値のみなら空文字（? を付けない）", () => {
    expect(buildQueryString(DEFAULTS)).toBe("");
  });

  it("既定値と異なる項目だけをクエリに載せる", () => {
    expect(
      buildQueryString({
        q: "ごはん",
        from: "2026-07-01",
        to: "2026-07-31",
        source: "home",
        sort: "weight_desc",
        page: 3,
      }),
    ).toBe(
      "?q=%E3%81%94%E3%81%AF%E3%82%93&from=2026-07-01&to=2026-07-31&source=home&sort=weight_desc&page=3",
    );
  });

  it("overrides で page だけ差し替えられる（1 に戻すと page は消える）", () => {
    const f: RecordFilters = { ...DEFAULTS, q: "a", page: 5 };
    expect(buildQueryString(f, { page: 1 })).toBe("?q=a");
    expect(buildQueryString(f, { page: 2 })).toBe("?q=a&page=2");
  });
});

describe("parse → build → parse の往復（URL リロードで条件が変わらない）", () => {
  const cases: Partial<RecordFilters>[] = [
    {},
    { q: "ごはん おかわり" },
    { q: "a&b=c?d" }, // クエリ構文と衝突する文字
    { from: "2026-07-01" },
    { to: "2026-07-31" },
    { source: "daycare" },
    { sort: "weight_asc" },
    { page: 7 },
    {
      q: "散歩",
      from: "2026-01-01",
      to: "2026-12-31",
      source: "home",
      sort: "date_asc",
      page: 2,
    },
  ];

  it.each(cases.map((c) => [JSON.stringify(c), c] as const))(
    "%s が往復で不変",
    (_label, partial) => {
      const f: RecordFilters = { ...DEFAULTS, ...partial };
      expect(roundTrip(f)).toEqual(f);
    },
  );
});

describe("hasActiveFilters", () => {
  it("既定値では false", () => {
    expect(hasActiveFilters(DEFAULTS)).toBe(false);
  });

  it("q / from / to / source のいずれかが効いていれば true", () => {
    expect(hasActiveFilters({ ...DEFAULTS, q: "x" })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULTS, from: "2026-07-01" })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULTS, to: "2026-07-31" })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULTS, source: "home" })).toBe(true);
  });

  it("sort / page は絞り込みではないので単独では false", () => {
    expect(hasActiveFilters({ ...DEFAULTS, sort: "weight_desc" })).toBe(false);
    expect(hasActiveFilters({ ...DEFAULTS, page: 9 })).toBe(false);
  });
});

describe("buildIlikeOr", () => {
  it("body と author の 2 カラムを or で結ぶ", () => {
    expect(buildIlikeOr("inu")).toBe(
      'body.ilike."%inu%",author.ilike."%inu%"',
    );
  });

  it("LIKE ワイルドカード % _ \\ をエスケープする", () => {
    expect(buildIlikeOr("100%")).toBe(
      'body.ilike."%100\\%%",author.ilike."%100\\%%"',
    );
    expect(buildIlikeOr("a_b")).toBe(
      'body.ilike."%a\\_b%",author.ilike."%a\\_b%"',
    );
    expect(buildIlikeOr("a\\b")).toBe(
      'body.ilike."%a\\\\b%",author.ilike."%a\\\\b%"',
    );
  });

  it("ダブルクオートを除去する（クオート囲みを破れない）", () => {
    expect(buildIlikeOr('say "hi"')).toBe(
      'body.ilike."%say hi%",author.ilike."%say hi%"',
    );
  });

  it("カンマ・括弧はクオート内に閉じ込める（PostgREST の or 構文に漏れない）", () => {
    expect(buildIlikeOr("a,b(c)")).toBe(
      'body.ilike."%a,b(c)%",author.ilike."%a,b(c)%"',
    );
  });

  it("複合の敵対的入力でもクオートの外へ出る文字が無い", () => {
    const out = buildIlikeOr('%_\\",eq.true),body.neq.("');
    // クオート除去とワイルドカードエスケープの複合結果
    expect(out).toBe(
      'body.ilike."%\\%\\_\\\\,eq.true),body.neq.(%",author.ilike."%\\%\\_\\\\,eq.true),body.neq.(%"',
    );
  });
});
