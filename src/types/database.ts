// DB スキーマに対応する型定義 (supabase/migrations/*.sql と同期)
// 将来 `supabase gen types typescript` で自動生成に置き換え可能。

// 記録元: 保育園 / おうち(両親)
export type RecordSource = "daycare" | "home";

export const RECORD_SOURCES: RecordSource[] = ["daycare", "home"];

export const SOURCE_LABEL: Record<RecordSource, string> = {
  daycare: "保育園",
  home: "おうち",
};

export function toSource(value: unknown): RecordSource {
  return value === "home" ? "home" : "daycare";
}

export type DaycareRecord = {
  id: string;
  owner_id: string;
  record_date: string; // YYYY-MM-DD
  source: RecordSource;
  author: string;
  weight_kg: number | null;
  pet_id: string | null; // 対象ペット。未設定は null（段階導入）
  body: string;
  created_at: string;
  updated_at: string;
};

// 読み取り専用の共有リンク。owner_id ベースの RLS で保護。
export type ShareLink = {
  id: string;
  owner_id: string;
  token: string;
  label: string | null;
  from_date: string | null;
  to_date: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

// 共有ビュー（匿名閲覧）に出す最小の記録。写真・id・owner は含めない。
export type SharedRecord = {
  record_date: string;
  source: RecordSource;
  author: string;
  weight_kg: number | null;
  body: string;
};

export type SharedView =
  | { valid: false }
  | { valid: true; label: string | null; records: SharedRecord[] };

// 飼っているペット（多頭飼いに備える素地）。owner_id ベースの RLS で保護。
export type Pet = {
  id: string;
  owner_id: string;
  name: string;
  species: string | null;
  birthday: string | null; // YYYY-MM-DD
  created_at: string;
  updated_at: string;
};

export type RecordPhoto = {
  id: string;
  record_id: string;
  storage_path: string;
  created_at: string;
};

// 一覧表示用: 記録 + 先頭写真のサムネ
export type RecordWithPhotos = DaycareRecord & {
  record_photos: RecordPhoto[];
};

export const PHOTO_BUCKET = "daycare-photos";

// ---------------------------------------------------------------
// 障害報告・機能要望フォーム (feedback)
// ---------------------------------------------------------------

// 種類: うまく動かない(bug) / 要望(request) / 質問・その他(question)
export type FeedbackKind = "bug" | "request" | "question";

export const FEEDBACK_KINDS: FeedbackKind[] = ["bug", "request", "question"];

export const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = {
  bug: "うまく動かない・困っている",
  request: "こうなったらいいな（要望）",
  question: "質問・その他",
};

export function toFeedbackKind(value: unknown): FeedbackKind {
  return value === "request" || value === "question" ? value : "bug";
}

// 困り度（任意）。未選択は null。
export type FeedbackSeverity = "blocker" | "annoying" | "minor" | "idea";

export const FEEDBACK_SEVERITIES: FeedbackSeverity[] = [
  "blocker",
  "annoying",
  "minor",
  "idea",
];

export const FEEDBACK_SEVERITY_LABEL: Record<FeedbackSeverity, string> = {
  blocker: "まったく使えなくて、とても困っている",
  annoying: "使えるけれど、困っている",
  minor: "少し気になる程度",
  idea: "急がない・思いつき",
};

export function toFeedbackSeverity(value: unknown): FeedbackSeverity | null {
  return FEEDBACK_SEVERITIES.includes(value as FeedbackSeverity)
    ? (value as FeedbackSeverity)
    : null;
}

// 起きる頻度（任意）。未選択は null。
export type FeedbackFrequency = "always" | "sometimes" | "once" | "unknown";

export const FEEDBACK_FREQUENCIES: FeedbackFrequency[] = [
  "always",
  "sometimes",
  "once",
  "unknown",
];

export const FEEDBACK_FREQUENCY_LABEL: Record<FeedbackFrequency, string> = {
  always: "毎回そうなる",
  sometimes: "ときどきそうなる",
  once: "一度だけそうなった",
  unknown: "わからない",
};

export function toFeedbackFrequency(value: unknown): FeedbackFrequency | null {
  return FEEDBACK_FREQUENCIES.includes(value as FeedbackFrequency)
    ? (value as FeedbackFrequency)
    : null;
}

// ---------------------------------------------------------------
// ユーザープロフィール / アカウント設定 (profiles)
// ---------------------------------------------------------------

// 1 ユーザーにつき 1 行。owner_id (= auth.uid()) ベースの RLS で保護される。
export type Profile = {
  owner_id: string;
  display_name: string | null;
  default_author: string | null; // 記録フォームの「記入者」の既定値
  created_at: string;
  updated_at: string;
};

// 送信時に自動収集するアプリの状況。
export type FeedbackContext = {
  page_path?: string; // 開いていた画面のパス (例: /records/123)
  page_url?: string; // フルURL
  user_agent?: string; // 端末・ブラウザ情報
  language?: string; // 表示言語
  viewport?: string; // 表示領域サイズ "375x812"
  screen?: string; // 画面サイズ "390x844"
  pixel_ratio?: number; // デバイスピクセル比
  online?: boolean; // 送信時のオンライン状態
  standalone?: boolean; // PWA(ホーム画面)から起動しているか
  timezone?: string; // タイムゾーン
  client_time?: string; // 端末側の送信時刻 (ISO)
};

export type Feedback = {
  id: string;
  owner_id: string;
  kind: FeedbackKind;
  severity: FeedbackSeverity | null;
  frequency: FeedbackFrequency | null;
  title: string | null;
  body: string;
  when_happened: string | null;
  expected: string | null;
  actual: string | null;
  reporter: string | null;
  context: FeedbackContext | null;
  github_issue_url: string | null;
  github_issue_number: number | null;
  created_at: string;
};
