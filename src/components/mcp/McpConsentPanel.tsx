"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { consentRedirect, consentSchema, failureOf, mcpJson, McpBrowserError, type BrowserFailure, type Consent } from "./browser";
import { McpFailure, McpFrame } from "./McpFrame";

const roles = { owner: "管理者", editor: "編集できるメンバー", viewer: "閲覧のみのメンバー" };
const callbackSchema = z.strictObject({ redirectTo: z.string().min(1).max(4096) });

export default function McpConsentPanel({ transactionId }: { transactionId: string }) {
  const [data, setData] = useState<Consent | null>(null);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<BrowserFailure | null>(null);
  const [decision, setDecision] = useState<boolean | null>(null);
  const pending = useRef(false);
  const revision = useRef(0);
  const returnTo = `/oauth/consent/${transactionId}`;

  const load = useCallback(async (signal?: AbortSignal) => {
    const request = ++revision.current;
    setLoading(true); setData(null); setSelected(""); setFailure(null);
    try {
      const result = await mcpJson(`/api/oauth/consent?transactionId=${encodeURIComponent(transactionId)}`, consentSchema, { signal });
      if (result.transactionId !== transactionId) throw new McpBrowserError("unavailable");
      if (request === revision.current && !signal?.aborted) setData(result);
    } catch (error) {
      if (request === revision.current && !signal?.aborted) setFailure(failureOf(error));
    } finally {
      if (request === revision.current && !signal?.aborted) setLoading(false);
    }
  }, [transactionId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function decide(approved: boolean) {
    if (pending.current || !data || data.transactionId !== transactionId ||
        approved && !data.eligibleHouseholds.some(household => household.householdId === selected)) return;
    pending.current = true; setDecision(approved); setFailure(null);
    try {
      const result = await mcpJson("/api/oauth/consent", callbackSchema, {
        method: "POST", csrf: data.csrfToken,
        body: { transactionId, approved, ...(approved ? { householdId: selected } : {}) },
      });
      const destination = consentRedirect(result.redirectTo);
      if (!destination) throw new McpBrowserError("unavailable");
      window.location.assign(destination);
    } catch (error) {
      // An ambiguous result is never replayed automatically. Reconfirm from a fresh GET.
      setData(null); setSelected(""); setFailure(failureOf(error));
      setDecision(null); pending.current = false;
    }
  }

  return <McpFrame>
    <nav aria-label="AIとの接続" className="mb-6 grid grid-cols-2 gap-1 rounded-xl border border-border bg-surface p-1">
      <span aria-current="page" className="flex min-h-11 items-center justify-center rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground">接続の確認</span>
      <a href="/connections" className="flex min-h-11 items-center justify-center rounded-lg px-3 text-sm font-semibold text-muted-foreground hover:bg-surface-muted">接続の管理</a>
    </nav>
    <section aria-labelledby="consent-title" className="space-y-6 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border sm:p-6" aria-busy={loading || decision !== null}>
      <div className="space-y-3"><span className="inline-flex rounded-full bg-surface-muted px-3 py-1 text-xs font-medium text-primary">閲覧のみ</span>
        <h1 id="consent-title" className="break-words text-2xl font-bold leading-snug">{data ? <>{data.clientName}に<br />家族の記録をつなぐ</> : "AIとの接続を確認"}</h1>
        {data && <p className="text-sm leading-relaxed text-muted-foreground">許可した家族の記録を、{data.clientName}から振り返れるようにします。</p>}
      </div>
      {loading && <p role="status" className="text-sm text-muted-foreground">接続の申し込みを確認しています…</p>}
      {failure && <McpFailure kind={failure} returnTo={returnTo} retry={() => void load()} />}
      {data && <>
        <div className="rounded-xl bg-surface-muted p-4"><p className="text-xs text-muted-foreground">ログイン中のアカウント</p><p className="mt-1 break-all text-sm font-medium">{data.accountLabel ?? "ログイン中のmfmfアカウント"}</p></div>
        <fieldset className="space-y-3" disabled={decision !== null}><legend className="mb-3 text-sm font-semibold">どの家族の記録をつなぎますか？</legend>
          {data.eligibleHouseholds.map(household => <label key={household.householdId} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4 has-checked:border-primary has-checked:bg-surface-muted">
            <input type="radio" name="household" value={household.householdId} checked={selected === household.householdId} onChange={() => setSelected(household.householdId)} className="mt-1 h-4 w-4 shrink-0 accent-primary" />
            <span className="min-w-0"><span className="block break-words text-sm font-semibold">{household.householdName}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{roles[household.role]}</span></span>
          </label>)}
          {data.eligibleHouseholds.length === 0 && <div className="rounded-xl border border-border bg-surface-muted p-4"><p className="text-sm font-semibold">接続できる家族がありません</p><p className="mt-2 text-sm leading-relaxed text-muted-foreground">家族のメンバーとして参加してからお申し込みください。ゲストとしての閲覧権限は、AI接続には使えません。</p></div>}
        </fieldset>
        <section className="space-y-3 border-t border-border pt-5" aria-labelledby="scope-title"><h2 id="scope-title" className="text-sm font-semibold">AIへ渡る情報</h2>
          <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed"><li>選んだ家族の、保存済みの記録の日付・本文・記録の種類・入力済みの体重</li><li>その家族のペットの名前など、記録を読むための基本情報</li></ul>
          <p className="text-xs leading-relaxed text-muted-foreground">家族が書いた記録も含みます。記録の本文に個人情報が書かれている場合、その内容がAIへ渡ることがあります。</p>
          <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm font-medium">AIへ渡る記録の例を見る</summary><p className="mt-3 text-sm leading-relaxed text-muted-foreground">架空の例：「ごはんを食べて、いつものおもちゃで遊びました。」日付・記録の種類・入力済みの体重も含まれます。</p></details>
        </section>
        <div className="space-y-2 rounded-xl bg-surface-muted p-4 text-sm leading-relaxed"><p className="font-semibold">写真や動画は渡しません</p><p className="text-muted-foreground">写真・動画の本体や閲覧用リンク、メンバー一覧・メールアドレスなどの会員情報は対象外です。下書きと削除済みの記録も含みません。</p><p className="pt-1 text-muted-foreground">記録の追加・変更・削除、家族への招待はできません。</p></div>
        <div className="space-y-2 text-sm leading-relaxed text-muted-foreground"><p>接続の有効期限は<strong className="text-foreground">最長30日</strong>。いつでも「AIとの接続」から解除できます。</p><p>許可した内容は{data.clientName}へ送られ、そのサービスのデータの扱いに従います。</p><p>この接続先の家族は固定です。mfmfで表示する家族を切り替えても変わりません。</p></div>
        <div className="space-y-3 border-t border-border pt-5">
          <p className="break-words text-sm font-medium" role="status">{selected ? `${data.eligibleHouseholds.find(household => household.householdId === selected)?.householdName}の記録をつなぎます` : "接続する家族を1つ選んでください"}</p>
          <button type="button" onClick={() => void decide(true)} disabled={!selected || decision !== null} className="min-h-12 w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40">{decision === true ? "接続しています…" : "この家族の記録の閲覧を許可"}</button>
          <button type="button" onClick={() => void decide(false)} disabled={decision !== null} className="min-h-12 w-full rounded-xl border border-border px-4 py-3 text-sm font-medium hover:bg-surface-muted disabled:opacity-40">{decision === false ? "取り消しています…" : "許可しない"}</button>
        </div>
      </>}
    </section>
  </McpFrame>;
}
