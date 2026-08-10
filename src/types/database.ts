// DB スキーマに対応する型定義 (supabase/migrations/*.sql と同期)
// 将来 `supabase gen types typescript` で自動生成に置き換え可能。

// 種類（どう過ごす日か）。もとは「記録元」だったが、予定を持つにあたって
// 通院・おでかけなどへ広げた（D34）。列名は source のまま。
export type RecordSource =
  | "daycare"
  | "home"
  | "family"
  | "clinic"
  | "outing"
  | "other";

export const RECORD_SOURCES: RecordSource[] = [
  "daycare",
  "home",
  "family",
  "clinic",
  "outing",
  "other",
];

export const SOURCE_LABEL: Record<RecordSource, string> = {
  daycare: "保育園",
  home: "おうち",
  family: "家族が来る",
  clinic: "通院",
  outing: "おでかけ",
  other: "その他",
};

// バッジの配色。種類が増えたので、非 home をすべて保育園色にしない
export const SOURCE_BADGE: Record<RecordSource, string> = {
  daycare: "bg-sky-100 text-sky-900",
  home: "bg-amber-100 text-amber-900",
  family: "bg-emerald-100 text-emerald-900",
  clinic: "bg-violet-100 text-violet-900",
  outing: "bg-rose-100 text-rose-900",
  other: "bg-slate-100 text-slate-900",
};

// クイック記録とゲストの記入で選べる種類。ここは「記録元」の意味のままにする
// （通院・おでかけは予定から作るものなので、最小の記入経路には出さない）
export const QUICK_SOURCES: RecordSource[] = ["daycare", "home"];

// 種類ごとの絵文字（プロトで合意した見た目。アイコンは SourceIcon 側）
export const SOURCE_EMOJI: Record<RecordSource, string> = {
  daycare: "🏫",
  home: "🏡",
  family: "👵",
  clinic: "🏥",
  outing: "✈️",
  other: "📌",
};

// 種類ごとの既定の時間帯。種類を選んだ時点で入り、手で触るまで追従する
export const SOURCE_DEFAULT_TIME: Record<
  RecordSource,
  { start: string; end: string }
> = {
  daycare: { start: "09:00", end: "18:00" },
  home: { start: "09:00", end: "18:00" },
  family: { start: "10:00", end: "17:00" },
  clinic: { start: "09:30", end: "11:00" },
  outing: { start: "10:00", end: "16:00" },
  other: { start: "10:00", end: "11:00" },
};

export function toSource(value: unknown): RecordSource {
  return RECORD_SOURCES.includes(value as RecordSource)
    ? (value as RecordSource)
    : "daycare";
}

// 予定 → 記録のステータス（D34）。同じ行の状態違いとして持つ。
export const RECORD_STATUSES = ["planned", "done", "skipped"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export const STATUS_LABEL: Record<RecordStatus, string> = {
  planned: "予定",
  done: "記録ずみ",
  skipped: "見送り",
};

export function toStatus(value: unknown): RecordStatus {
  return RECORD_STATUSES.includes(value as RecordStatus)
    ? (value as RecordStatus)
    : "done";
}

// 担当の役割。種類ごとに必要なものだけが画面に出る
export const ASSIGNEE_ROLES = ["drop", "pick", "care"] as const;
export type AssigneeRole = (typeof ASSIGNEE_ROLES)[number];

export const ASSIGNEE_ROLE_LABEL: Record<AssigneeRole, string> = {
  drop: "送り",
  pick: "お迎え",
  care: "みる人",
};

// その種類で決める担当（おでかけ・その他は担当なし）
export const SOURCE_ROLES: Record<RecordSource, AssigneeRole[]> = {
  daycare: ["drop", "pick"],
  home: ["care"],
  family: ["care"],
  clinic: ["care"],
  outing: [],
  other: [],
};

export type RecordAssignee = {
  record_id: string;
  role: AssigneeRole;
  user_id: string;
  created_at: string;
};

// 毎週の予定ルール。版（since）で積み、その日に効くのは since がその日以前で最新のもの。
// kind が null の版は「この日以降はルールなし」を表す墓標。
export type ScheduleRule = {
  id: string;
  household_id: string;
  weekday: number; // 0=日曜
  since: string; // YYYY-MM-DD
  kind: RecordSource | null;
  start_time: string | null; // HH:MM
  end_time: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type ScheduleRuleAssignee = {
  rule_id: string;
  role: AssigneeRole;
  user_id: string;
  created_at: string;
};

// その日だけ曜日ルールを効かせない（打ち消し）
export type ScheduleRuleSkip = {
  household_id: string;
  on_date: string; // YYYY-MM-DD
  created_by: string;
  created_at: string;
};

export type DaycareRecord = {
  id: string;
  owner_id: string;
  household_id: string; // 所属世帯（NOT NULL・S1 手順6で確定）
  record_date: string; // YYYY-MM-DD
  source: RecordSource;
  status: RecordStatus; // planned=予定 / done=記録ずみ / skipped=見送り（D34）
  start_time: string | null; // HH:MM。null は時刻なし。end_time と対
  end_time: string | null;
  overrides_rule: boolean; // true ならその日の曜日ルールを隠す
  author: string;
  weight_kg: number | null;
  pet_id: string | null; // 対象ペット。未設定は null（段階導入）
  body: string;
  guest_visible: boolean; // 対象ペットのゲストに見せるか（D8: 既定 false）
  created_at: string;
  updated_at: string;
};

// 外部ゲスト（保育園/シッター）への対象ペット・期間限定アクセス付与（S4 / UC-G01）。
export const GUEST_ROLES = ["guest:daycare", "guest:sitter"] as const;
export type GuestRole = (typeof GUEST_ROLES)[number];

export type GuestGrant = {
  id: string;
  household_id: string;
  user_id: string;
  scope_pet_id: string;
  role: GuestRole;
  valid_from: string; // YYYY-MM-DD
  valid_to: string | null; // null = 取り消しまで有効
  revoked_at: string | null;
  created_by: string;
  created_at: string;
};

// ---------------------------------------------------------------
// 世帯（テナント）/ メンバーシップ (households / household_members)
// Phase 3.5 S1: owner_id から household メンバーシップ判定への段階移行。
// 本スライスではスキーマ追加とバックフィルのみ（RLS 本切替・アプリ改修は後続 PR）。
// ---------------------------------------------------------------
export type Household = {
  id: string;
  name: string;
  avatar_path: string | null; // avatars バケット内の世帯アバターパス（任意）
  created_at: string;
};

export type HouseholdMember = {
  household_id: string;
  user_id: string;
  role: string; // 既定 'owner'
  created_at: string;
};

// 飼っているペット（多頭飼いに備える素地）。owner_id ベースの RLS で保護。
export type Pet = {
  id: string;
  owner_id: string;
  household_id: string; // 所属世帯（NOT NULL・S1 手順6で確定）
  name: string;
  species: string | null;
  birthday: string | null; // YYYY-MM-DD
  avatar_path: string | null; // avatars バケット内のアバターパス（任意）。世帯で共有。
  created_at: string;
  updated_at: string;
};

export type RecordPhoto = {
  id: string;
  record_id: string;
  household_id: string; // 所属世帯（NOT NULL・親 daycare_records から継承）
  storage_path: string;
  created_at: string;
};

// 記録に付与する自由タグ（世帯で共有する辞書。owner_id は作成者）
export type Tag = {
  id: string;
  owner_id: string;
  household_id: string | null; // 所属世帯。移行期は null
  name: string;
  created_at: string;
};

// タグ名の正規化（前後空白の除去）と妥当性の上限。
// DB 制約（tags_name_not_blank: 1〜50 文字）と合わせる。
export const TAG_NAME_MAX_LENGTH = 50;

export function normalizeTagName(value: unknown): string {
  return String(value ?? "").trim().slice(0, TAG_NAME_MAX_LENGTH);
}

// 一覧/詳細でタグを埋め込み取得するときの形（record_tags 経由の join）。
export type RecordTagJoin = {
  tags: Pick<Tag, "id" | "name"> | null;
};

// 一覧表示用: 記録 + 先頭写真のサムネ + タグ
export type RecordWithPhotos = DaycareRecord & {
  record_photos: RecordPhoto[];
  record_tags?: RecordTagJoin[];
};

// 埋め込み join からタグ配列（名前順）を取り出すヘルパー。
export function tagsFromJoin(
  rows: RecordTagJoin[] | null | undefined,
): Pick<Tag, "id" | "name">[] {
  return (rows ?? [])
    .map((r) => r.tags)
    .filter((t): t is Pick<Tag, "id" | "name"> => Boolean(t))
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

export const PHOTO_BUCKET = "daycare-photos";

// アバター画像（ペット / 世帯 / ユーザー）の private バケット。
// パス規約: {scope_id}/avatars/{uuid}-{filename}（scope_id = household_id または owner_id）
export const AVATAR_BUCKET = "avatars";

// ---------------------------------------------------------------
// Google Drive 連携クレデンシャル (google_credentials)
// refresh_token_enc はアプリ層で暗号化済みの文字列 (src/lib/google/crypto.ts)
// ---------------------------------------------------------------
export type GoogleCredential = {
  owner_id: string;
  refresh_token_enc: string;
  created_at: string;
  updated_at: string;
};

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
  avatar_path: string | null; // avatars バケット内のユーザーアバターパス（任意・個人スコープ）
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

export type FeedbackStatus = "open" | "triaged" | "closed";

export const FEEDBACK_STATUSES: FeedbackStatus[] = ["open", "triaged", "closed"];

export const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
  open: "未対応",
  triaged: "整理済み",
  closed: "対応完了",
};

export function toFeedbackStatus(value: unknown): FeedbackStatus {
  return FEEDBACK_STATUSES.includes(value as FeedbackStatus)
    ? (value as FeedbackStatus)
    : "open";
}

export type Feedback = {
  id: string;
  owner_id: string;
  household_id: string; // 所属世帯（NOT NULL・S1 手順6で確定）
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
  status: FeedbackStatus;
  status_changed_at: string;
  created_at: string;
};
