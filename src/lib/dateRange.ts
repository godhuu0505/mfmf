// 体重グラフの期間切替（D33）などで使う日付ユーティリティ。
// record_date は日付のみを持つので、cutoff は JST の「今日」を基準にした
// 暦演算で出す（固定日数だと 2月や 31日で 1 日ずれる。実行 TZ にも依存させない）。

/** Asia/Tokyo の今日（YYYY-MM-DD）。 */
export function jstTodayISO(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(
    now,
  );
}

/**
 * ISO 日付（YYYY-MM-DD）から months ヶ月前の同日を返す。
 * 相手の月に同日が無ければ月末に丸める（例: 3/31 の 1ヶ月前 → 2/28）。
 */
export function minusMonthsISO(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const total = y * 12 + (m - 1) - months;
  const ty = Math.floor(total / 12);
  const tm = total - ty * 12; // 0-based
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
