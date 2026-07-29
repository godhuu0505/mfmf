#!/usr/bin/env node
// PreToolUse ガード — 機密情報の漏洩・破壊的操作を未然に防ぐ。
//
// permissions.deny は Read/Edit には効くが、Bash 経由の `cat .env.local` 等は
// すり抜ける。このフックは Bash も含めて多層防御する（defense in depth）。
//
// 入力: stdin に PreToolUse の JSON（tool_name, tool_input ...）
// 出力: 拒否する場合のみ permissionDecision=deny を stdout に出す。許可は無出力 exit 0。
import { readFileSync } from "node:fs";

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

// `git ... worktree remove ...` に force 相当のオプションが付いているか。
// 正規表現 1 本ではなくトークン列で判定する（省略形・語順・グローバルオプションに強い）。
//
// ⚠️ これは多層防御の 1 枚であって、シェルの完全な解釈ではない。
// シェル文字列から静的に意図を判定する以上、変数展開・コマンド置換・eval
// （`git worktree remove "$WT" $FLAGS` など）は原理的に見抜けない。
// 「うっかり」を止めるための層であり、意図的な回避に対する境界ではない。
// 本当の安全策は worktree の中身を消される前に確認すること（deny の文言で誘導している）。
// ANSI-C 引用 `$'...'` の中身を復元する。`\x2d` `\055` `\u002d` `\n` などを実際の文字に戻す。
// エスケープの「形」を 1 つずつ潰すのではなく、この構文をまとめて解釈することで
// `$'\x2d\x2dforce'` `$'\055\055force'` `--fo$'\x72'ce` をすべて同じ `--force` に落とす。
// git のグローバルオプションのうち、**次のトークンを値として取る**もの（`git -h` の
// `git [-C <path>] [-c <name>=<value>] ...`）。サブコマンドの位置を正しく求めるために要る。
// `--git-dir=...` のように `=` を含む形は値を持たないものとして扱えるので、ここには要らない。
const GIT_OPTS_WITH_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace",
  "--exec-path", "--config-env", "--super-prefix", "--attr-source",
]);

const ANSI_C_ESCAPE = /\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|[0-7]{1,3}|.)/g;
const ANSI_C_SIMPLE = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b" };
function decodeAnsiCQuotes(token) {
  return token.replace(/\$'((?:[^'\\]|\\.)*)'/g, (_, body) =>
    body.replace(ANSI_C_ESCAPE, (_m, esc) => {
      if (esc[0] === "x" && esc.length > 1) return String.fromCharCode(parseInt(esc.slice(1), 16));
      if (esc[0] === "u" && esc.length > 1) return String.fromCharCode(parseInt(esc.slice(1), 16));
      if (/^[0-7]+$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
      return ANSI_C_SIMPLE[esc] ?? esc;
    }),
  );
}

function isForcedWorktreeRemoval(command) {
  // 構文としての引用符・エスケープを外す。シェルは `"--force"` も `--fo"rce"` も
  // `\-\-force` も `$'--force'` も `$'\x2d\x2dforce'` も、git には同じ `--force` として渡す。
  // ANSI-C の中身は**バックスラッシュを落とす前に**復元する（順序を逆にすると `\x2d` が
  // `x2d` になって一致しなくなる）。`$` は引用符が続くときだけ落とす
  // （`$FLAGS` のような変数参照は残す＝下記の限界）。
  const unquote = (t) => decodeAnsiCQuotes(t).replace(/\$(?=["'])/g, "").replace(/["'\\]/g, "");
  // 行継続（バックスラッシュ + 改行）はシェルが 1 行に繋ぐので、**区切る前に**繋ぐ。
  // 先に改行で割ると `--\<改行>force` が `--` と `force` に分かれて一致しなくなる。
  const joined = command.replace(/\\\r?\n/g, "");
  // パイプ・リスト区切りでコマンド単位に割る
  for (const segment of joined.split(/[|;&\n]+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
    const gitAt = tokens.findIndex((t) => t === "git" || t.endsWith("/git"));
    if (gitAt < 0) continue;
    const rest = tokens.slice(gitAt + 1);
    // `--force` の曖昧でない省略形（--f 〜 --force）と、-f を含む短オプション束
    const isForce = (t) =>
      /^--f(?:o(?:r(?:c(?:e)?)?)?)?$/.test(t) || /^-[A-Za-z]*f[A-Za-z]*$/.test(t);
    // **サブコマンドの位置を求める。** 引数の中を漁ると
    // `git commit -m "... worktree remove --force ..."` のような
    // 「その操作の話をしているだけ」のコマンドまで巻き込んで誤爆する。
    // git のグローバルオプションを読み飛ばして、最初の非オプショントークンを取る。
    let i = 0;
    while (i < rest.length) {
      const t = rest[i];
      if (t === "--") { i++; break; }
      if (!t.startsWith("-")) break;                       // ← ここがサブコマンド
      if (t.includes("=")) { i += 1; continue; }            // --git-dir=... 形式
      if (GIT_OPTS_WITH_VALUE.has(t)) { i += 2; continue; } // -C <path> / -c <k=v> など
      i += 1;                                              // --no-pager 等の値なしオプション
    }
    if (rest[i] !== "worktree" || rest[i + 1] !== "remove") continue;
    if (rest.slice(i + 2).some(isForce)) return true;
  }
  return false;
}

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0); // パース不能なら通常フローに委ねる
}

const tool = input.tool_name || "";
const ti = input.tool_input || {};

// 読み取り可: .env.local.example（プレースホルダのみ）。保護: 実際の env / 鍵ファイル。
const SECRET_FILE = /(^|\/)\.env($|\.local$|\.[^/]*\.local$|\.production$|\.development$|\.test$)|\.pem$|(^|\/)id_(rsa|ed25519)$|\.p12$|\.key$/;

// ファイル系ツールでの機密ファイルアクセスを拒否
if (["Read", "Edit", "Write", "NotebookEdit"].includes(tool)) {
  const p = ti.file_path || ti.notebook_path || "";
  if (p && SECRET_FILE.test(p)) {
    deny(
      `機密ファイル（${p}）へのアクセスはガードによりブロックされました。` +
        `Supabase の URL / anon key は public ですが、service_role key やセッションは秘匿してください。` +
        `設定例は .env.local.example を参照してください。`,
    );
  }
}

// Bash 経由の漏洩・破壊操作を拒否
if (tool === "Bash") {
  const cmd = String(ti.command || "");

  // .env / 鍵ファイルを読み出すコマンド
  if (
    /\b(cat|less|more|head|tail|bat|xxd|od|strings|nl|cp|mv|scp|rsync|base64|openssl)\b[^|;&]*\.env(\.|\b)/.test(cmd) ||
    /\.env[^\s]*\.local\b/.test(cmd) && /\b(cat|less|more|head|tail|cp|mv|scp|base64)\b/.test(cmd)
  ) {
    deny(
      ".env 系ファイルを読み出すコマンドはガードによりブロックされました。" +
        "秘密情報を標準出力やネットワークに流さないでください。",
    );
  }

  // service_role key を環境やコマンドから露出させる操作
  if (/SUPABASE_SERVICE_ROLE|service_role/i.test(cmd) && /\b(echo|printenv|env|curl|wget|cat)\b/.test(cmd)) {
    deny("service_role key を露出させる操作はガードによりブロックされました。");
  }

  // 破壊的・取り返しのつかない操作
  if (/\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease=|-f\b)/.test(cmd) && !/--force-with-lease(\s|$)/.test(cmd)) {
    deny("git の強制 push はガードによりブロックされました。必要なら --force-with-lease を使い、ユーザーに確認してください。");
  }
  if (/\brm\s+-rf?\s+(\/|~|\$HOME|\*\s*$)/.test(cmd)) {
    deny("ルート/ホーム/ワイルドカードに対する rm -rf はガードによりブロックされました。");
  }
  if (/\bgit\s+(reset\s+--hard\s+origin|clean\s+-[a-z]*f[a-z]*d|push\b.*:.*\bmain\b)/.test(cmd)) {
    deny("履歴を失う恐れのある git 操作はガードによりブロックされました。ユーザーに確認してください。");
  }
  // worktree の強制削除。1 本の正規表現で書こうとして 3 回取りこぼした
  // （①パスが先 ②git -C 等のグローバルオプション ③--for のような省略形）ので、
  // 「コマンド全体に当てる正規表現」をやめてトークン列として見る。
  // git は曖昧でない限り長オプションの省略を受け付けるため、--f/--fo/--for/--forc も --force。
  // 逆に --no-force は「強制しない」なので通す。
  if (isForcedWorktreeRemoval(cmd)) {
    deny(
      "git worktree の強制削除はガードによりブロックされました。" +
        "--force は無視対象でない未コミットの変更ごと削除します。" +
        "まず `git -C <worktree> status` で中身を確認し、--force なしで削除してください" +
        "（gitignore 済みの node_modules / .next / env ファイルが残っていても --force は不要です）。",
    );
  }
}

process.exit(0);
