"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import { resizeImages } from "@/lib/imageResize";
import { buildStoragePath } from "@/lib/storagePath";
import { takeQuickDraft } from "@/lib/quickDraft";
import TagInput from "@/components/TagInput";
import {
  ConfirmCancelButton,
  ConfirmDialog,
} from "@/components/FormConfirm";
import {
  PHOTO_BUCKET,
  RECORD_SOURCES,
  SOURCE_LABEL,
  type RecordSource,
} from "@/types/database";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

type PetOption = { id: string; name: string };

type Props = {
  action: (formData: FormData) => void | Promise<void>;
  /** ログイン中ユーザーの id（household 未所属時の Storage パスと RLS のフォールバック） */
  ownerId: string;
  /** 記録が属する世帯 id。あれば Storage パスは {household_id}/{record_id}/... で生成する。 */
  householdId?: string | null;
  /** 編集時は既存 record id。新規時は内部生成して record_id として送る。 */
  recordId?: string;
  defaultDate: string; // YYYY-MM-DD
  defaultBody?: string;
  defaultSource?: RecordSource;
  defaultAuthor?: string;
  defaultWeightKg?: number | null;
  /** 選択可能なペット一覧（owner_id スコープ）。空ならペット欄を出さない。 */
  pets?: PetOption[];
  defaultPetId?: string | null;
  /** この記録に付与済みのタグ名 */
  defaultTags?: string[];
  /** サジェスト用の既存タグ名（オーナーの辞書） */
  tagSuggestions?: string[];
  submitLabel: string;
  cancelHref: string;
};

export default function RecordForm({
  action,
  ownerId,
  householdId = null,
  recordId: existingRecordId,
  defaultDate,
  defaultBody = "",
  defaultSource = "daycare",
  defaultAuthor = "",
  defaultWeightKg = null,
  pets = [],
  defaultPetId = null,
  defaultTags = [],
  tagSuggestions = [],
  submitLabel,
  cancelHref,
}: Props) {
  // 新規作成時も先に id を確定し、Storage パス {scope_id}/{record_id}/... と一致させる。
  const recordId = useMemo(
    () => existingRecordId ?? crypto.randomUUID(),
    [existingRecordId],
  );
  // Storage パスの先頭セグメント。**世帯があるときだけアップロードが成立する。**
  // ⚠️ owner_id へのフォールバックは insert ポリシーが無いので RLS で落ちる
  // （daycare_photos_insert_own は 20260704000000 で drop 済み）。
  // 未所属ユーザーは /onboarding で世帯作成へ回されるため通常は到達しないが、
  // この経路を消すか明示的に失敗させるかは未決（PR #127 の判断待ち項目）。
  const storageScopeId = householdId ?? ownerId;
  const [source, setSource] = useState<RecordSource>(defaultSource);

  const formRef = useRef<HTMLFormElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [processing, setProcessing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // 保存の確認ダイアログ（D33）。確認済みフラグが立っているときだけ実送信する。
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmedRef = useRef(false);

  const busy = processing || uploading || isPending;

  // クイック記録からの下書き（本文・記録元）を取り込む（新規作成のみ。
  // sessionStorage 経由なので URL・履歴には載らない。src/lib/quickDraft.ts）。
  useEffect(() => {
    if (existingRecordId) return;
    const draft = takeQuickDraft();
    if (!draft) return;
    if (draft.body && bodyRef.current && !bodyRef.current.value) {
      bodyRef.current.value = draft.body;
    }
    setSource(draft.source);
  }, [existingRecordId]);

  // 選択画像をアップロード前に縮小・圧縮し、送信用に保持する。
  async function handleFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.currentTarget.files ?? []);
    setError(null);
    if (selected.length === 0) {
      setFiles([]);
      setSummary(null);
      return;
    }

    setProcessing(true);
    setSummary(null);
    try {
      const before = selected.reduce((sum, f) => sum + f.size, 0);
      const resized = await resizeImages(selected);
      const after = resized.reduce((sum, f) => sum + f.size, 0);
      setFiles(resized);

      const saved = before > 0 ? Math.round((1 - after / before) * 100) : 0;
      setSummary(
        `${resized.length}枚を最適化しました（${formatBytes(before)} → ${formatBytes(after)}` +
          (saved > 0 ? ` / -${saved}%` : "") +
          "）",
      );
    } catch {
      // 失敗しても元の選択ファイルで送信できるので致命的ではない
      setFiles(selected);
      setSummary("画像の最適化をスキップしました（そのままアップロードします）");
    } finally {
      setProcessing(false);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    // 確認ダイアログを挟む（UC-F01）。確認後の requestSubmit で再入してくる。
    if (!confirmedRef.current) {
      setConfirmOpen(true);
      return;
    }
    confirmedRef.current = false;
    const form = e.currentTarget;
    setError(null);

    // 1. 写真は Supabase Storage へブラウザから直接アップロード（Vercel の本体 4.5MB 制限を回避）。
    const supabase = createClient();
    const paths: string[] = [];
    try {
      setUploading(true);
      for (const file of files) {
        if (!file || file.size === 0) continue;
        const path = buildStoragePath(storageScopeId, recordId, file.name);
        const { error: uploadError } = await supabase.storage
          .from(PHOTO_BUCKET)
          .upload(path, file, { contentType: file.type, upsert: false });
        if (uploadError) throw uploadError;
        paths.push(path);
      }
    } catch (err) {
      // 途中まで成功したアップロードはオーファンになるため取り消す。
      if (paths.length > 0) {
        await supabase.storage
          .from(PHOTO_BUCKET)
          .remove(paths)
          .catch(() => {});
      }
      const message = err instanceof Error ? err.message : String(err);
      setError(`写真のアップロードに失敗しました: ${message}`);
      setUploading(false);
      return;
    }
    setUploading(false);

    // 2. メタデータ（日付・本文・record_id・アップロード済みパス）だけを Server Action へ送る。
    const fd = new FormData(form);
    fd.delete("photos"); // 画像本体は送らない
    fd.set("record_id", recordId);
    // フォームを描画（= 写真をアップロード）した世帯を明示して送る。Server Action は
    // Cookie の「現在の世帯」ではなくこの値を検証して使う（別タブで世帯を切り替えた
    // 後に送信しても、記録と写真パスの世帯が食い違わない）。
    if (householdId) fd.set("household_id", householdId);
    paths.forEach((p) => fd.append("photo_paths", p));

    // action を await して、リダイレクト完了まで isPending=true を維持し二重送信を防ぐ。
    startTransition(async () => {
      await action(fd);
    });
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-5">
      {/* アクション行は上部固定（notes.md「キャンセル・保存を上部固定 = IME に隠れない」）。
          フォーム画面は全画面モーダル型でヘッダーを出さない（HideOnFormRoute）ため、
          セーフエリア直下に貼り付く。 */}
      <div className="safe-pt sticky top-0 z-10 -mx-4 flex items-center justify-between gap-3 border-b border-border bg-background/90 px-4 py-2.5 backdrop-blur">
        <ConfirmCancelButton
          href={cancelHref}
          className="text-sm text-muted-foreground transition hover:text-foreground"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-primary px-5 py-2 font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
        >
          {uploading ? "写真を保存中…" : isPending ? "保存中…" : submitLabel}
        </button>
      </div>

      <div>
        <span className="mb-1 block text-sm font-medium text-foreground">
          記録元
        </span>
        <input type="hidden" name="source" value={source} />
        <div className="inline-flex rounded-lg border border-border p-0.5">
          {RECORD_SOURCES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSource(s)}
              aria-pressed={source === s}
              className={
                "rounded-md px-4 py-1.5 text-sm font-medium transition " +
                (source === s
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-surface-muted")
              }
            >
              {SOURCE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {pets.length > 0 && (
        <div>
          <label htmlFor="pet_id" className="mb-1 block text-sm font-medium text-foreground">
            ペット
          </label>
          <select
            id="pet_id"
            name="pet_id"
            defaultValue={defaultPetId ?? ""}
            className="w-full rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground"
          >
            {/* 未設定を明示。pet_id=null の既存記録を勝手に付け替えないため、
                fallback で先頭ペットを選ばない。 */}
            <option value="">（未設定）</option>
            {pets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label
          htmlFor="record_date"
          className="mb-1 block text-sm font-medium text-foreground"
        >
          記録の日付
        </label>
        <input
          id="record_date"
          name="record_date"
          type="date"
          required
          defaultValue={defaultDate}
          className="rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground"
        />
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="flex-1 min-w-[10rem]">
          <label
            htmlFor="author"
            className="mb-1 block text-sm font-medium text-foreground"
          >
            記入者
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              （任意）
            </span>
          </label>
          <input
            id="author"
            name="author"
            type="text"
            defaultValue={defaultAuthor}
            placeholder={source === "home" ? "おかあさん など" : "担当スタッフ名"}
            className="w-full rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground"
          />
        </div>
        <div className="w-32">
          <label
            htmlFor="weight_kg"
            className="mb-1 block text-sm font-medium text-foreground"
          >
            体重(kg)
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              （任意）
            </span>
          </label>
          <input
            id="weight_kg"
            name="weight_kg"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            defaultValue={defaultWeightKg ?? ""}
            placeholder="2.25"
            className="w-full rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground"
          />
        </div>
      </div>

      {/* 写真は上段（proto 合意 / notes.md「写真を上段へ」。長いフォームの
          末尾まで辿らなくても、主目的の写真を先に選べる） */}
      <div>
        <label
          htmlFor="photos"
          className="mb-1 block text-sm font-medium text-foreground"
        >
          写真を追加（複数選択可）
        </label>
        <input
          id="photos"
          name="photos"
          type="file"
          accept="image/*"
          multiple
          onChange={handleFilesChange}
          className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-surface-muted file:px-4 file:py-2 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted"
        />
        <p className="mt-1.5 text-xs text-muted-foreground" aria-live="polite">
          {processing
            ? "画像を最適化しています…"
            : summary ?? "アップロード時に自動で縮小・圧縮します（長辺 1600px）。"}
        </p>
      </div>

      <div>
        <label
          htmlFor="body"
          className="mb-1 block text-sm font-medium text-foreground"
        >
          {source === "home" ? "おうちでの記録" : "保育園からの記録"}
        </label>
        <textarea
          ref={bodyRef}
          id="body"
          name="body"
          rows={8}
          defaultValue={defaultBody}
          placeholder="今日の様子などを記録します"
          className="w-full rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground"
        />
      </div>

      <TagInput defaultTags={defaultTags} suggestions={tagSuggestions} />

      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      {confirmOpen && (
        <ConfirmDialog
          title="この内容で保存しますか？"
          message="保存したあともいつでも編集できます。"
          confirmLabel="保存する"
          confirmClassName="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover"
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            confirmedRef.current = true;
            formRef.current?.requestSubmit();
          }}
        />
      )}
    </form>
  );
}
