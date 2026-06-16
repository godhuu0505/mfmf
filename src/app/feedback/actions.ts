"use server";

import { createClient } from "@/lib/supabase/server";
import {
  FEEDBACK_FREQUENCY_LABEL,
  FEEDBACK_KIND_LABEL,
  FEEDBACK_SEVERITY_LABEL,
  toFeedbackFrequency,
  toFeedbackKind,
  toFeedbackSeverity,
  type FeedbackContext,
  type FeedbackKind,
} from "@/types/database";

// useActionState で扱う送信結果。
export type FeedbackState = {
  ok: boolean;
  // 画面に表示するメッセージ（丁寧な日本語）
  message?: string;
  // 自動転記した GitHub Issue の URL（あれば）
  issueUrl?: string;
};

export const initialFeedbackState: FeedbackState = { ok: false };

// 種類ごとの GitHub Issue ラベル。
const KIND_GH_LABEL: Record<FeedbackKind, string> = {
  bug: "bug",
  request: "enhancement",
  question: "question",
};

function trimOrNull(value: FormDataEntryValue | null): string | null {
  const s = String(value ?? "").trim();
  return s === "" ? null : s;
}

// クライアントから送られてきた状況 JSON を安全にパースする。
function parseContext(raw: FormDataEntryValue | null): FeedbackContext | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as FeedbackContext)
      : null;
  } catch {
    return null;
  }
}

// 件名が未入力なら本文の先頭から自動生成する。
function buildTitle(
  explicit: string | null,
  kind: FeedbackKind,
  body: string,
): string {
  if (explicit) return explicit;
  const firstLine = body.split("\n").map((l) => l.trim()).find((l) => l !== "");
  const head = (firstLine ?? "（内容未記入）").slice(0, 60);
  return `[${FEEDBACK_KIND_LABEL[kind]}] ${head}`;
}

// GitHub Issue 本文（Markdown）を組み立てる。
function buildIssueBody(input: {
  kind: FeedbackKind;
  severity: string | null;
  frequency: string | null;
  body: string;
  whenHappened: string | null;
  expected: string | null;
  actual: string | null;
  reporter: string | null;
  reporterEmail: string | null;
  context: FeedbackContext | null;
  createdAt: string;
}): string {
  const lines: string[] = [];

  lines.push("## 内容");
  lines.push(input.body || "（内容未記入）");
  lines.push("");

  const meta: string[] = [];
  meta.push(`- **種類**: ${FEEDBACK_KIND_LABEL[input.kind]}`);
  if (input.severity) {
    const label =
      FEEDBACK_SEVERITY_LABEL[
        input.severity as keyof typeof FEEDBACK_SEVERITY_LABEL
      ] ?? input.severity;
    meta.push(`- **困り度**: ${label}`);
  }
  if (input.frequency) {
    const label =
      FEEDBACK_FREQUENCY_LABEL[
        input.frequency as keyof typeof FEEDBACK_FREQUENCY_LABEL
      ] ?? input.frequency;
    meta.push(`- **頻度**: ${label}`);
  }
  if (input.whenHappened) meta.push(`- **いつ**: ${input.whenHappened}`);
  if (input.reporter) meta.push(`- **記入者**: ${input.reporter}`);
  if (input.reporterEmail) meta.push(`- **アカウント**: ${input.reporterEmail}`);
  lines.push("## 詳細");
  lines.push(...meta);
  lines.push("");

  if (input.expected || input.actual) {
    lines.push("## 期待した動き / 実際の動き");
    if (input.expected) lines.push(`- **期待した動き**: ${input.expected}`);
    if (input.actual) lines.push(`- **実際に起きたこと**: ${input.actual}`);
    lines.push("");
  }

  const c = input.context;
  if (c) {
    lines.push("## アプリの状況（自動収集）");
    if (c.page_path) lines.push(`- 画面: \`${c.page_path}\``);
    if (c.online !== undefined)
      lines.push(`- オンライン状態: ${c.online ? "オンライン" : "オフライン"}`);
    if (c.standalone !== undefined)
      lines.push(`- 起動方法: ${c.standalone ? "ホーム画面アプリ" : "ブラウザ"}`);
    if (c.viewport) lines.push(`- 表示領域: ${c.viewport}`);
    if (c.screen) lines.push(`- 画面サイズ: ${c.screen}`);
    if (c.pixel_ratio) lines.push(`- ピクセル比: ${c.pixel_ratio}`);
    if (c.language) lines.push(`- 言語: ${c.language}`);
    if (c.timezone) lines.push(`- タイムゾーン: ${c.timezone}`);
    if (c.client_time) lines.push(`- 端末時刻: ${c.client_time}`);
    if (c.user_agent) lines.push(`- 端末情報: \`${c.user_agent}\``);
    lines.push("");
  }

  lines.push("---");
  lines.push(`_アプリ内フォームから自動作成 (${input.createdAt})_`);

  return lines.join("\n");
}

// GitHub Issue を作成する。トークン未設定や失敗時は null を返す（DB 保存は維持）。
async function createGithubIssue(input: {
  title: string;
  body: string;
  labels: string[];
}): Promise<{ url: string; number: number } | null> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_FEEDBACK_REPO || "godhuu0505/mfmf";
  if (!token) return null;

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        labels: input.labels,
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      console.error(
        `GitHub Issue 作成に失敗しました: ${res.status} ${await res.text()}`,
      );
      return null;
    }

    const json = (await res.json()) as { html_url: string; number: number };
    return { url: json.html_url, number: json.number };
  } catch (e) {
    console.error("GitHub Issue 作成中にエラーが発生しました", e);
    return null;
  }
}

// フォーム送信を受け取り、Supabase に保存 → GitHub Issue へ自動転記する。
export async function submitFeedback(
  _prevState: FeedbackState,
  formData: FormData,
): Promise<FeedbackState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      message:
        "ログインの有効期限が切れているようです。お手数ですが一度ログインし直してから、もう一度お試しください。",
    };
  }

  const body = String(formData.get("body") ?? "").trim();
  if (body === "") {
    return {
      ok: false,
      message:
        "「どんなことでお困りですか？」の欄が空のようです。一言だけでも大丈夫ですので、内容を入力してください。",
    };
  }

  const kind = toFeedbackKind(formData.get("kind"));
  const severity = toFeedbackSeverity(formData.get("severity"));
  const frequency = toFeedbackFrequency(formData.get("frequency"));
  const title = trimOrNull(formData.get("title"));
  const whenHappened = trimOrNull(formData.get("when_happened"));
  const expected = trimOrNull(formData.get("expected"));
  const actual = trimOrNull(formData.get("actual"));
  const reporter = trimOrNull(formData.get("reporter"));
  const context = parseContext(formData.get("context"));

  // まず DB に保存（GitHub 転記に失敗しても内容を失わないため）。
  const { data: saved, error: insertError } = await supabase
    .from("feedback")
    .insert({
      owner_id: user.id,
      kind,
      severity,
      frequency,
      title,
      body,
      when_happened: whenHappened,
      expected,
      actual,
      reporter,
      context,
    })
    .select("id")
    .single();

  if (insertError || !saved) {
    return {
      ok: false,
      message:
        "申し訳ありません。送信に失敗してしまいました。通信状況を確認して、もう一度お試しください。",
    };
  }

  // GitHub Issue へ自動転記（任意・失敗しても送信自体は成功扱い）。
  const computedTitle = buildTitle(title, kind, body);
  const issue = await createGithubIssue({
    title: computedTitle,
    body: buildIssueBody({
      kind,
      severity,
      frequency,
      body,
      whenHappened,
      expected,
      actual,
      reporter,
      reporterEmail: user.email ?? null,
      context,
      createdAt: new Date().toISOString(),
    }),
    labels: ["feedback", KIND_GH_LABEL[kind]],
  });

  if (issue) {
    // 転記できたら Issue の情報を控えておく（失敗時は DB の控えのみ）。
    await supabase
      .from("feedback")
      .update({ github_issue_url: issue.url, github_issue_number: issue.number })
      .eq("id", saved.id);
  }

  return {
    ok: true,
    message:
      "送信ありがとうございました！内容はしっかり届きました。いただいた声をもとに、よりよいアプリにしていきます。",
    issueUrl: issue?.url,
  };
}
