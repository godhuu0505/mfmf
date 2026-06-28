"use client";

import { useMemo, useRef, useState } from "react";
import { TAG_NAME_MAX_LENGTH } from "@/types/database";

type Props = {
  /** 初期で付与済みのタグ名 */
  defaultTags?: string[];
  /** サジェスト用の既存タグ名（オーナーの辞書） */
  suggestions?: string[];
};

function normalize(value: string): string {
  return value.trim().slice(0, TAG_NAME_MAX_LENGTH);
}

// 記録に付与するタグを編集する入力。選択中のタグは hidden input `tag_names` として
// 送信され、Server Action 側で tags / record_tags に同期される。
export default function TagInput({ defaultTags = [], suggestions = [] }: Props) {
  const [tags, setTags] = useState<string[]>(() => {
    // 初期値も正規化・重複排除（大小無視）しておく。
    const seen = new Set<string>();
    const result: string[] = [];
    for (const t of defaultTags) {
      const name = normalize(t);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(name);
    }
    return result;
  });
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const hasTag = (name: string) =>
    tags.some((t) => t.toLowerCase() === name.toLowerCase());

  function addTag(raw: string) {
    const name = normalize(raw);
    if (!name || hasTag(name)) {
      setInput("");
      return;
    }
    setTags((prev) => [...prev, name]);
    setInput("");
  }

  function removeTag(name: string) {
    setTags((prev) => prev.filter((t) => t !== name));
  }

  // まだ付与していない候補のみをサジェストする。
  const remainingSuggestions = useMemo(
    () => suggestions.filter((s) => !hasTag(s)),
    // hasTag は tags 依存なので tags を依存に含める
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [suggestions, tags],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(input);
    } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
      // 入力が空のときの Backspace で末尾のタグを削除
      removeTag(tags[tags.length - 1]);
    }
  }

  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-foreground">
        タグ
        <span className="ml-1 text-xs font-normal text-muted-foreground">（任意）</span>
      </span>

      {/* 送信用 hidden inputs（選択中のタグ名） */}
      {tags.map((t) => (
        <input key={t} type="hidden" name="tag_names" value={t} />
      ))}

      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border px-2 py-2 focus-within:border-muted-foreground focus-within:ring-1 focus-within:ring-muted-foreground">
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-surface-muted py-0.5 pl-2.5 pr-1 text-sm text-foreground"
          >
            #{t}
            <button
              type="button"
              onClick={() => removeTag(t)}
              aria-label={`タグ「${t}」を外す`}
              className="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => addTag(input)}
          list="tag-suggestions"
          maxLength={TAG_NAME_MAX_LENGTH}
          placeholder={tags.length === 0 ? "体調 / 食欲 / トリミング など" : ""}
          className="min-w-[8rem] flex-1 border-0 bg-transparent px-1 py-0.5 text-sm text-foreground outline-none"
        />
      </div>

      <datalist id="tag-suggestions">
        {remainingSuggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      {remainingSuggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {remainingSuggestions.slice(0, 12).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => addTag(s)}
              className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground transition hover:border-border hover:bg-surface-muted hover:text-foreground"
            >
              ＋ {s}
            </button>
          ))}
        </div>
      )}

      <p className="mt-1.5 text-xs text-muted-foreground">
        Enter またはカンマで追加できます。
      </p>
    </div>
  );
}
