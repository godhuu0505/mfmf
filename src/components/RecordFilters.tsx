"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import {
  buildQueryString,
  hasActiveFilters,
  SORT_KEYS,
  SORT_LABEL,
  type RecordFilters as Filters,
  type RecordSourceFilter,
  type SortKey,
} from "@/lib/recordQuery";
import { RECORD_SOURCES, SOURCE_LABEL, type RecordSource } from "@/types/database";
import { searchRelatedRecords, type RelatedSearchResponse } from "@/app/(app)/records/related-actions";

// 記録一覧の検索・絞り込み・並び替えフォーム。
// 記録元はホーム常設のチップ（page.tsx / proto 合意）が受け持ち、
// ここでは hidden で保持だけする（検索してもチップの選択が消えないように）。
// 送信時に空欄・既定値を除いた URL を組み立てて遷移するため、
// 共有・リロードで同じ結果を再現できる（条件は URL クエリが正）。
export default function RecordFilters({
  filters,
  activeTagId = null,
  rankingEnabled = false,
}: {
  filters: Filters;
  /** 選択中のタグ id（検索条件を変えても保持する）。 */
  activeTagId?: string | null;
  rankingEnabled?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const [rankingBusy, setRankingBusy] = useState(false);
  const [related, setRelated] = useState<RelatedSearchResponse | null>(null);
  const [rankingNotice, setRankingNotice] = useState("");
  useEffect(() => () => { generation.current++; }, []);

  function invalidateRelated() {
    generation.current++;
    busyRef.current = false;
    setRankingBusy(false);
    setRelated(null);
    setRankingNotice("");
  }

  async function findRelated() {
    if (!rankingEnabled || busyRef.current || !formRef.current) return;
    const formData = new FormData(formRef.current);
    const query = String(formData.get("q") ?? "").trim();
    if (!query || query.length > 200) {
      invalidateRelated();
      setRankingNotice("思い出したいことを200文字以内で入力してください。");
      return;
    }
    if (activeTagId) formData.set("tag", activeTagId);
    const ticket = ++generation.current;
    busyRef.current = true;
    setRankingBusy(true);
    setRelated(null);
    setRankingNotice("関連度を確認しています。条件を変えると、この処理の表示を取り消します。");
    try {
      const result = await searchRelatedRecords(formData);
      if (generation.current !== ticket) return;
      if (result.status === "ranked" && result.records.length) {
        setRelated(result);
        setRankingNotice(`最近の記録${result.candidateCount}件を、質問に近い順で表示しています。${result.truncated ? "最近の最大100件が対象です。期間を変えると、ほかの時期も探せます。" : ""}`);
      } else {
        const notices = {
          empty: "この条件で確認できる記録はありません。期間や記録元を変えてください。",
          limited: "関連度検索の利用上限に達しました。通常検索は引き続き使えます。",
          disabled: "関連度検索は現在利用できません。通常検索をご利用ください。",
          unavailable: "関連度を確認できませんでした。ログイン状態を確認するか、通常検索をご利用ください。",
          ranked: "この条件で確認できる記録はありません。期間や記録元を変えてください。",
        };
        setRankingNotice(notices[result.status]);
      }
    } catch {
      if (generation.current === ticket) setRankingNotice("関連度を確認できませんでした。時間をおいて試すか、通常検索をご利用ください。");
    } finally {
      if (generation.current === ticket) { busyRef.current = false; setRankingBusy(false); }
    }
  }
  // buildQueryString の結果に選択中タグを足してから遷移する。
  //
  // 素のフル遷移（location.assign）にしている: 記録元チップ・カレンダーの
  // 「今日」と同じで、CI では**一覧の「検索パラメータだけが変わる遷移」**の
  // クライアント遷移が確定しないことがある（E2E がクリック後に URL が変わらない
  // まま数分待って落ちる）。一覧は毎回サーバー描画なのでフル遷移でも体感差がなく、
  // 確実に動く方を取る（decisions.md D37-a）。
  function pushWithTag(qs: string) {
    invalidateRelated();
    if (!activeTagId) {
      window.location.assign(`/${qs}`);
      return;
    }
    const params = new URLSearchParams(qs.startsWith("?") ? qs.slice(1) : qs);
    params.set("tag", activeTagId);
    window.location.assign(`/?${params.toString()}`);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const sourceRaw = String(fd.get("source") || "all");
    const source: RecordSourceFilter = RECORD_SOURCES.includes(
      sourceRaw as RecordSource,
    )
      ? (sourceRaw as RecordSource)
      : "all";
    const sortRaw = String(fd.get("sort") || "date_desc");
    const sort: SortKey = (SORT_KEYS as string[]).includes(sortRaw)
      ? (sortRaw as SortKey)
      : "date_desc";

    // 絞り込みを変えたら 1 ページ目へ戻す
    const next: Filters = {
      q: String(fd.get("q") || "").trim().slice(0, 100),
      from: String(fd.get("from") || ""),
      to: String(fd.get("to") || ""),
      source,
      sort,
      page: 1,
    };
    pushWithTag(buildQueryString(next));
  }

  // 並び替えが既定以外の場合も「条件あり」として扱う —— 畳んだままだと
  // 一覧が非既定の順序になっている理由が見えず、戻す手段も隠れてしまう。
  const active = hasActiveFilters(filters) || filters.sort !== "date_desc";
  // 検索パネルは既定で畳む（UC-H01）。絞り込み中は自動で開く（条件が見えないと
  // 「なぜ一覧が少ないのか」が分からなくなるため）。
  const [openPanel, setOpenPanel] = useState(active);

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => { invalidateRelated(); setOpenPanel((v) => !v); }}
        aria-expanded={openPanel}
        aria-controls="record-filters-panel"
        className="mb-3 flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition hover:bg-surface-muted"
      >
        <Search className="h-4 w-4" aria-hidden="true" />
        検索・絞り込み
        {active && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-primary"
            aria-hidden="true"
          />
        )}
      </button>

      {openPanel && (<>
    <form
      ref={formRef}
      id="record-filters-panel"
      onSubmit={handleSubmit}
      onChange={invalidateRelated}
      className="space-y-3 rounded-2xl bg-surface p-3 shadow-sm ring-1 ring-border"
    >
      {/* キーワード検索 */}
      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          name="q"
          defaultValue={filters.q}
          placeholder="本文・記入者で検索"
          aria-label="本文・記入者で検索"
          maxLength={rankingEnabled ? 200 : undefined}
          className={`${rankingEnabled ? "basis-full min-h-11" : "flex-1"} min-w-0 rounded-lg border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-muted-foreground focus:outline-none`}
        />
        <button
          type="submit"
          className={`${rankingEnabled ? "min-h-11 flex-1 border border-border text-foreground hover:bg-surface-muted" : "shrink-0 bg-primary text-primary-foreground hover:bg-primary-hover"} rounded-lg px-4 py-2 text-sm font-medium transition`}
        >
          検索
        </button>
        {rankingEnabled && <button type="button" onClick={() => void findRelated()} disabled={rankingBusy}
          aria-describedby="related-search-description"
          className="min-h-11 flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60">
          {rankingBusy ? "関連度を確認中…" : "関連度で探す"}
        </button>}
      </div>
      {rankingEnabled && <div id="related-search-description" className="rounded-xl bg-surface-muted p-3 text-xs leading-6 text-muted-foreground">
        <p><strong className="text-foreground">「関連度で探す」を押したときだけ</strong>、入力文と、閲覧できる最近の記録の記録元・本文の一部（最大100件、各600文字以内）をGoogle Cloudへ送って並べ替えます。</p>
        <p>写真は送らず、メール・URL・数字列と把握できる名前を伏せますが、本文の完全な匿名化は保証できません。秘密情報は入力しないでください。東京内での処理は保証されません。</p>
        <p>関連度は200文字、通常検索は先頭100文字が対象です。1日20回まで（全体の利用枠で早く終了する場合があります）。数値や健康状態は評価しません。</p>
      </div>}

      {/* 記録元はホームのチップ選択を維持したまま送る */}
      <input type="hidden" name="source" value={filters.source} />

      {/* 並び替え */}
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted-foreground">
          並び替え
        </span>
        <select
          name="sort"
          defaultValue={filters.sort}
          className="w-full rounded-lg border border-border bg-surface px-2 py-2 text-sm text-foreground focus:border-muted-foreground focus:outline-none"
        >
          {SORT_KEYS.map((k) => (
            <option key={k} value={k}>
              {SORT_LABEL[k]}
            </option>
          ))}
        </select>
      </label>

      {/* 期間。grid の固定 2 列ではなく「入らなければ折り返す」flex にする ——
          日付入力が幅指定どおりに縮まない環境（iOS Safari の固有幅。globals.css で
          解除しているが、下限が残っても列からはみ出して重なることがないように）でも
          縦積みになるだけで済む。 */}
      <div className="flex flex-wrap gap-2">
        <label className="block flex-1 basis-40">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            開始日
          </span>
          <input
            type="date"
            name="from"
            defaultValue={filters.from}
            max={filters.to || undefined}
            className="w-full rounded-lg border border-border bg-surface px-2 py-2 text-sm text-foreground focus:border-muted-foreground focus:outline-none"
          />
        </label>
        <label className="block flex-1 basis-40">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            終了日
          </span>
          <input
            type="date"
            name="to"
            defaultValue={filters.to}
            min={filters.from || undefined}
            className="w-full rounded-lg border border-border bg-surface px-2 py-2 text-sm text-foreground focus:border-muted-foreground focus:outline-none"
          />
        </label>
      </div>

      {(active || rankingEnabled) && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => pushWithTag("")}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
          >
            条件をクリア
          </button>
        </div>
      )}
    </form>
    {rankingEnabled && (rankingBusy || rankingNotice || related) && <div className="mt-4">
      <p id="related-search-status" role="status" aria-live="polite" className="mb-3 text-sm leading-6 text-muted-foreground">{rankingNotice}</p>
      {(rankingBusy || related) && <button type="button" onClick={invalidateRelated} className="mb-3 rounded-lg border border-border px-3 py-2 text-sm font-medium">通常検索に戻す</button>}
      {related && <section aria-label="関連度の検索結果" className="space-y-3">
        {related.records.map((record) => <article key={record.id} className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-border">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><time dateTime={record.recordDate}>{record.recordDate.replaceAll("-", "/")}</time><span className="rounded-full bg-surface-muted px-2 py-1">{SOURCE_LABEL[record.source as RecordSource] ?? "記録"}</span></div>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-7">{record.body.slice(0, 220)}{record.body.length > 220 ? "…" : ""}</p>
          <a href={`/records/${encodeURIComponent(record.id)}`} className="mt-3 inline-block text-sm font-medium text-primary underline underline-offset-4">元の記録を開く</a>
        </article>)}
        <p className="text-xs leading-5 text-muted-foreground">保存された本文との関連順です。内容の正しさや健康状態を判定するものではありません。</p>
      </section>}
      {related && <h2 className="mt-6 text-sm font-semibold text-muted-foreground">通常の記録一覧</h2>}
    </div>}
      </>)}
    </div>
  );
}
