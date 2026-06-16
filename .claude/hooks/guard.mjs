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
}

process.exit(0);
