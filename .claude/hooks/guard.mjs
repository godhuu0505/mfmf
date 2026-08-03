#!/usr/bin/env node
// PreToolUse ガード — 機密情報の漏洩・破壊的操作を未然に防ぐ。
//
// permissions.deny は Read/Edit には効くが、Bash 経由の `cat .env.local` 等は
// すり抜ける。このフックは Bash も含めて多層防御する（defense in depth）。
//
// 入力: stdin に PreToolUse の JSON（tool_name, tool_input ...）
// 出力: 拒否する場合のみ permissionDecision=deny を stdout に出す。許可は無出力 exit 0。
//
// ⚠️ **ここに「コマンドの形を列挙して塞ぐ」判定を足さないこと。**
// シェル文字列から静的に意図を判定する形は収束しない（変数展開・コマンド置換・eval は
// 原理的に見抜けない）。実際に `git worktree remove --force` を止める判定を足したときは
// 22 巡かけても抜け道が尽きず、その約半分は前巡の修正自身が作った穴だった（D17）。
// **強制力が要るものは `.claude/settings.json` の deny に書く**（allow に無ければ
// 承認プロンプトが出るので、無確認で実行されることはない）。
// このフックは「deny/allow では表現できない、値の中身に依存する漏洩」だけを見る。
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

// 読み取り可: .env.local.example などのテンプレート（プレースホルダのみ）。
// 保護: 実際の env / 鍵ファイル。
//
// **env は「守る名前を並べる」形にしない。** 以前は
//   .env / .env.local / .env.*.local / .env.production / .env.development / .env.test
// を列挙していたが、`.env.staging` `.env.preview` `.env.prod` は素通りしていた（実測）。
// 環境名は無数にあるので、列挙する限り必ず漏れる。
// **原則拒否にして、通すのはテンプレートだけ**という向きに反転する。
const ENV_FILE = /(^|\/)\.env(\.|$)/;
const ENV_TEMPLATE = /(^|\/)\.env(\.[^/]*)?\.(example|sample|template|dist)$/;
const KEY_FILE = /\.pem$|(^|\/)id_(rsa|ed25519)$|\.p12$|\.key$/;
const isSecretFile = (p) => (ENV_FILE.test(p) && !ENV_TEMPLATE.test(p)) || KEY_FILE.test(p);

// ファイル系ツールでの機密ファイルアクセスを拒否
if (["Read", "Edit", "Write", "NotebookEdit"].includes(tool)) {
  const p = ti.file_path || ti.notebook_path || "";
  if (p && isSecretFile(p)) {
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
