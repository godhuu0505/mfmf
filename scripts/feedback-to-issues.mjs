// =============================================================
// feedback-to-issues.mjs
//
// Supabase の feedback テーブルから「まだ GitHub に登録していない投稿」を読み取り、
// 個人情報・秘匿情報をマスクしてから GitHub Issue に登録するメンテナンス用スクリプト。
// 公開リポジトリに生の内容が漏れないよう、アプリ本体は GitHub に何も送らない設計とし、
// Issue 化はこのスクリプトを「非公開(private)リポジトリ宛て」に手動実行して行う。
//
// 認証は夫婦共用ログイン（email/password）で行い、RLS 経由で自分の投稿だけを取得する。
// service_role キーは使わない（CLAUDE.md のセキュリティ方針に従う）。
//
// 使い方:
//   # まずはマスク結果の確認（GitHub には登録しない）
//   node --env-file=.env.local scripts/feedback-to-issues.mjs --dry-run
//   # 問題なければ登録
//   node --env-file=.env.local scripts/feedback-to-issues.mjs
//
// 必要な環境変数（.env.local などに設定）:
//   NEXT_PUBLIC_SUPABASE_URL       アプリと同じ Supabase URL
//   NEXT_PUBLIC_SUPABASE_ANON_KEY  アプリと同じ anon/publishable key
//   FEEDBACK_USER_EMAIL            投稿を読むための共用ログインのメール
//   FEEDBACK_USER_PASSWORD         同パスワード
//   GITHUB_TOKEN                   Issues 書き込み権を持つ Fine-grained PAT
//   GITHUB_FEEDBACK_REPO           登録先 owner/repo（★ 必ず非公開リポジトリを指定）
//
// オプション:
//   --dry-run     GitHub に登録せず、マスク後の Issue タイトル/本文を表示するだけ
//   --limit=N     一度に処理する最大件数（既定 20）
// =============================================================

import { createClient } from "@supabase/supabase-js";

// ---- ラベル（src/types/database.ts と対応） ----
const KIND_LABEL = {
  bug: "うまく動かない・困っている",
  request: "こうなったらいいな（要望）",
  question: "質問・その他",
};
const KIND_GH_LABEL = { bug: "bug", request: "enhancement", question: "question" };
const SEVERITY_LABEL = {
  blocker: "まったく使えなくて、とても困っている",
  annoying: "使えるけれど、困っている",
  minor: "少し気になる程度",
  idea: "急がない・思いつき",
};
const FREQUENCY_LABEL = {
  always: "毎回そうなる",
  sometimes: "ときどきそうなる",
  once: "一度だけそうなった",
  unknown: "わからない",
};

// ---- 引数 ----
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Math.max(1, Number(limitArg.split("=")[1]) || 20) : 20;

function fail(message) {
  console.error(`\n[エラー] ${message}\n`);
  process.exit(1);
}

// ---- 個人情報・秘匿情報のマスク ----
// 名前など一般語は自動検出できないため、--dry-run で必ず目視確認してから登録すること。
function mask(text) {
  if (text === null || text === undefined) return text;
  let t = String(text);
  // メールアドレス
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "［メール非表示］");
  // JWT 形式（Supabase のトークン等）
  t = t.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "［トークン非表示］");
  // よくある API キー/トークンの接頭辞
  t = t.replace(
    /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|sk|pk|rk|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g,
    "［トークン非表示］",
  );
  // URL のクエリ・フラグメント（トークンが入りがち）は落とし、パスまでに留める
  t = t.replace(/(https?:\/\/[^\s?#]+)(?:[?#]\S*)?/g, "$1");
  // 電話番号（日本のゆるい検出）
  t = t.replace(/0\d{1,4}[-‐ (（]?\d{1,4}[-‐ )）]?\d{3,4}/g, "［電話番号非表示］");
  // 11 桁以上の連続数字（会員番号・カード番号など）
  t = t.replace(/\d{11,}/g, "［番号非表示］");
  return t;
}

function firstLine(text) {
  return (
    String(text || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") || "（内容未記入）"
  );
}

function buildTitle(row) {
  const kindLabel = KIND_LABEL[row.kind] || row.kind;
  const head = mask(firstLine(row.body)).slice(0, 60);
  return `[${kindLabel}] ${head}`;
}

function buildBody(row) {
  const lines = [];

  lines.push("## 内容");
  lines.push(mask(row.body) || "（内容未記入）");
  lines.push("");

  lines.push("## 詳細");
  lines.push(`- **種類**: ${KIND_LABEL[row.kind] || row.kind}`);
  if (row.severity)
    lines.push(`- **困り度**: ${SEVERITY_LABEL[row.severity] || row.severity}`);
  if (row.frequency)
    lines.push(`- **頻度**: ${FREQUENCY_LABEL[row.frequency] || row.frequency}`);
  if (row.when_happened) lines.push(`- **いつ**: ${mask(row.when_happened)}`);
  if (row.reporter) lines.push(`- **記入者**: ${mask(row.reporter)}`);
  lines.push(`- **受付日時**: ${row.created_at}`);
  lines.push("");

  if (row.expected || row.actual) {
    lines.push("## 期待した動き / 実際の動き");
    if (row.expected) lines.push(`- **期待した動き**: ${mask(row.expected)}`);
    if (row.actual) lines.push(`- **実際に起きたこと**: ${mask(row.actual)}`);
    lines.push("");
  }

  const c = row.context;
  if (c && typeof c === "object") {
    lines.push("## アプリの状況（自動収集）");
    if (c.page_path) lines.push(`- 画面: \`${mask(c.page_path)}\``);
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
    if (c.user_agent) lines.push(`- 端末情報: \`${mask(c.user_agent)}\``);
    lines.push("");
  }

  lines.push("---");
  lines.push("_アプリ内フォームから受け付け、マスク処理のうえ自動転記しました。_");
  return lines.join("\n");
}

async function createIssue({ repo, token, title, body, labels }) {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body, labels }),
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return { url: json.html_url, number: json.number };
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const email = process.env.FEEDBACK_USER_EMAIL;
  const password = process.env.FEEDBACK_USER_PASSWORD;
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_FEEDBACK_REPO;

  if (!url || !anonKey) {
    fail("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY が未設定です。");
  }
  if (!email || !password) {
    fail("FEEDBACK_USER_EMAIL / FEEDBACK_USER_PASSWORD が未設定です。");
  }
  if (!dryRun && (!token || !repo)) {
    fail(
      "GITHUB_TOKEN / GITHUB_FEEDBACK_REPO が未設定です（登録先は必ず非公開リポジトリにしてください）。" +
        " 先に --dry-run で内容を確認できます。",
    );
  }

  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) fail(`ログインに失敗しました: ${signInError.message}`);

  // まだ Issue 化していない投稿のみ取得（古い順）。
  const { data: rows, error } = await supabase
    .from("feedback")
    .select("*")
    .is("github_issue_number", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) fail(`feedback の取得に失敗しました: ${error.message}`);

  if (!rows || rows.length === 0) {
    console.log("未登録のフィードバックはありません。");
    return;
  }

  console.log(
    `未登録 ${rows.length} 件を処理します${dryRun ? "（--dry-run: 登録はしません）" : `（登録先: ${repo}）`}\n`,
  );

  let posted = 0;
  for (const row of rows) {
    const title = buildTitle(row);
    const body = buildBody(row);
    const labels = ["feedback", KIND_GH_LABEL[row.kind] || "question"];

    if (dryRun) {
      console.log("────────────────────────────────────────");
      console.log(`TITLE: ${title}`);
      console.log(`LABELS: ${labels.join(", ")}`);
      console.log(body);
      console.log("");
      continue;
    }

    try {
      const issue = await createIssue({ repo, token, title, body, labels });
      const { error: updateError } = await supabase
        .from("feedback")
        .update({ github_issue_url: issue.url, github_issue_number: issue.number })
        .eq("id", row.id);
      if (updateError) {
        // Issue は作られたが控えの更新に失敗。二重登録を避けるため明示する。
        console.warn(
          `⚠ Issue #${issue.number} は作成しましたが DB 更新に失敗しました（手動で github_issue_number を設定してください）: ${updateError.message}`,
        );
      } else {
        console.log(`✓ #${issue.number} ${issue.url}`);
      }
      posted += 1;
    } catch (e) {
      console.error(`✗ id=${row.id} の登録に失敗: ${e.message}`);
    }
  }

  if (!dryRun) console.log(`\n完了: ${posted}/${rows.length} 件を登録しました。`);
}

main().catch((e) => fail(e.message));
