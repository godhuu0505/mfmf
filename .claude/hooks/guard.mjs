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
const ANSI_C_SIMPLE = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b", E: "\x1b" };
// bash が `$'...'` で**認識する**のはこの集合だけ（上の表 ＋ 下の 4 つ ＋ \nnn / \xHH / \uHHHH）。
// **認識しないエスケープは、バックスラッシュごとそのまま残る** —— `$'\_'` は `\_` の 2 文字。
// ここを `esc` だけ返す形にしていると `\` が消え、`env -S` の `\_`（空白扱い）を
// 見落とす（`env -S $'git\_worktree\_remove\_../v\_--force'` が素通りしていた）。
const ANSI_C_LITERAL = new Set(["\\", "'", '"', "?"]);
function decodeAnsiC(body) {
  return body.replace(ANSI_C_ESCAPE, (_m, esc) => {
    if (esc[0] === "x" && esc.length > 1) return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (esc[0] === "u" && esc.length > 1) return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (/^[0-7]+$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    if (esc in ANSI_C_SIMPLE) return ANSI_C_SIMPLE[esc];
    if (ANSI_C_LITERAL.has(esc)) return esc;
    return "\\" + esc;                    // 認識しないものは bash と同じく `\` を残す
  });
}

// シェル文字列を「コマンドの区切り」と「単語」に分解する小さな字句解析器。
// 文字列分割を継ぎ足す形（split → 引用符を剥がす）では、
//   `git commit -m "docs: note; git worktree remove --force is unsafe"`
// のように**引用符の中にある区切り文字**を境界と誤認してしまう。
// 引用状態を持って 1 文字ずつ読むことで、区切り・引用符・エスケープ・
// 行継続・ANSI-C 引用をまとめて正しく扱う。
// envSplit: `env -S` の payload を割るモード。env は payload を**引数に割るだけ**で、
// `;` `|` `&` `(` `)` `<` `>` をシェル演算子として解釈しない（全部ただの文字）。
// 一方で**改行は引数の区切り**として扱い、`\_` も空白として扱う。
// このモードを持たずに通常モードで割ると、
//   env -S $'git worktree remove ../v\n--force'
// の改行をコマンド境界と誤認して `--force` を落としてしまう。
function lexSegments(command, { envSplit = false } = {}) {
  const segments = [];
  let words = [];
  let word = "";
  let hasWord = false;              // 空文字列の引数（"" など）も 1 語として扱うため
  // リダイレクトの**対象**を捨てるためのフラグ。対象はファイル名なので引用符も
  // エスケープも効く（`git >"/tmp/a b" worktree ...`）。だから対象をその場で
  // 読み飛ばすのではなく、**通常の語として読み切ってから捨てる**。
  let dropNextWord = false;
  // ヒアドキュメント（`cat <<EOF` … `EOF`）の**本文はコマンドではない**。
  // 素通りさせると本文の各行を新しいセグメントとして解析してしまい、
  // 「手順書を cat で表示するだけ」のコマンドを誤って拒否する。
  // 区切り語を覚えておき、行末に達した時点で本文を終端まで読み飛ばす。
  const pendingHeredocs = [];
  const endWord = () => {
    if (!hasWord) return;
    if (dropNextWord) dropNextWord = false;   // リダイレクト対象 → 引数にしない
    else words.push(word);
    word = ""; hasWord = false;
  };
  const endSegment = () => { endWord(); dropNextWord = false; if (words.length) segments.push(words); words = []; };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\\") {
      const next = command[i + 1];
      // env -S の `\_` は空白（＝引数の区切り）。GNU env の独自エスケープ。
      if (envSplit && next === "_") { endWord(); i++; continue; }
      // env -S の `\c` は**そこで文字列を打ち切る**（実測: `env -S 'echo aaa\cbbb'` は
      // `aaa` だけを出力する）。以降を literal として繋げると
      // `--force\cignored` が `--forcecignored` になり判定を素通りする。
      if (envSplit && next === "c") { endWord(); i = command.length; break; }
      if (next === "\n") { i++; continue; }          // 行継続: 両方消える
      if (next === undefined) continue;
      word += next; hasWord = true; i++; continue;   // \x → リテラル x
    }
    if (c === "'") {                                  // 単引用: 中身はすべてリテラル
      const end = command.indexOf("'", i + 1);
      const body = end < 0 ? command.slice(i + 1) : command.slice(i + 1, end);
      word += body; hasWord = true; i = end < 0 ? command.length : end; continue;
    }
    if (c === '"') {                                  // 双引用: \ だけ効く
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "\\" && j + 1 < command.length) { j++; word += command[j]; }
        else word += command[j];
      }
      hasWord = true; i = j; continue;
    }
    if (c === "$" && (command[i + 1] === "'" || command[i + 1] === '"')) {
      const q = command[i + 1];
      let j = i + 2, body = "";
      for (; j < command.length && command[j] !== q; j++) {
        if (command[j] === "\\" && j + 1 < command.length) { body += command[j] + command[j + 1]; j++; }
        else body += command[j];
      }
      word += q === "'" ? decodeAnsiC(body) : body;   // $'...' は ANSI-C、$"..." は翻訳（中身はそのまま）
      hasWord = true; i = j; continue;
    }
    // 区切り文字。`(` `)` はサブシェル境界なので、これも区切りとして扱う
    // （扱わないと `(git worktree remove ../x --force)` が `(git` と `--force)` になり一致しない）。
    // 行末に達したら、直前の行で宣言されたヒアドキュメントの本文を終端まで捨てる。
    if (!envSplit && c === "\n" && pendingHeredocs.length) {
      endSegment();
      let j = i + 1;
      while (pendingHeredocs.length) {
        const { delim, dashed } = pendingHeredocs.shift();
        for (;;) {
          const nl = command.indexOf("\n", j);
          const raw = command.slice(j, nl < 0 ? command.length : nl);
          j = nl < 0 ? command.length : nl + 1;
          // `<<-` は行頭のタブを剥がして比較する
          if ((dashed ? raw.replace(/^\t+/, "") : raw) === delim || nl < 0) break;
        }
      }
      i = j - 1;
      continue;
    }
    if (!envSplit && (c === ";" || c === "|" || c === "&" || c === "\n" || c === "(" || c === ")")) {
      endSegment(); continue;
    }
    // envSplit では改行も「引数の区切り」（env は payload を argv に割るだけ）
    if (c === " " || c === "\t" || c === "\r" || (envSplit && c === "\n")) { endWord(); continue; }
    // リダイレクト（`<` `>` `>>` `2>` `2>&1` など）は**引数ではない**。
    // シェルは `git</dev/null worktree ...` を「git を実行し stdin を差し替える」と読む。
    // 演算子と**その対象**をまとめて捨てる（対象を語として残すと、それが引数の位置に
    // 入り込んでサブコマンドの判定がずれる）。
    // ヒアドキュメント `<<EOF` / `<<-EOF` / `<<'EOF'`。区切り語を控えて本文は後で捨てる。
    // ヒアストリング `<<<word` は本文を持たないので、通常のリダイレクト対象として捨てる。
    if (!envSplit && c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      let j = i + 2;
      let dashed = false;
      if (command[j] === "-") { dashed = true; j++; }
      while (j < command.length && /[ \t]/.test(command[j])) j++;
      let delim = "";
      while (j < command.length && !/[\s;|&()<>]/.test(command[j])) {
        const ch = command[j];
        if (ch === "'" || ch === '"') { j++; continue; }        // 引用符は区切り語の一部ではない
        if (ch === "\\") { j++; if (j < command.length) delim += command[j++]; continue; }
        delim += ch; j++;
      }
      endWord();
      pendingHeredocs.push({ delim, dashed });
      i = j - 1;
      continue;
    }
    if (!envSplit && (c === "<" || c === ">")) {
      endWord();
      // 直前の語が fd 番号だけ（`2` など）ならリダイレクト指定なので引数ではない
      if (words.length && /^\d+$/.test(words[words.length - 1])) words.pop();
      let j = i + 1;
      if (command[j] === ">" || command[j] === "<") j++;        // >> / <<
      if (command[j] === "&") j++;                              // 2>&1 の &
      // 対象（ファイル名 / fd）は**次の 1 語**として読ませて捨てる。
      // ここで空白まで読み飛ばす形にすると `>"/tmp/a b"` の引用符内の空白で
      // 打ち切られ、残った `b"` が引数の位置に入ってサブコマンドの判定がずれる。
      dropNextWord = true;
      i = j - 1;
      continue;
    }
    word += c; hasWord = true;
  }
  endSegment();
  return segments;
}

// コマンドの「実行ファイル位置」を求める。先頭の環境変数代入（`FOO=bar git ...`）と
// ラッパー（`env` / `sudo` / `command` / `time` / `nohup` / `xargs`）を読み飛ばす。
// 全トークンから `git` を探すと `echo git worktree remove --force` のように
// **git を実行していないコマンド**まで巻き込んで誤爆する。
// ラッパーごとの「値を取るオプション」。ここまで持つのは、ラッパーの**引数を読み飛ばす**のと
// 「ラッパーが実行する本体」を見分けるのを区別するため。区別しないと
// `env echo git worktree remove --force` の `echo` を飛ばして `git` を本体と誤認する。
// コマンドの前に置ける予約語。`for` / `case` は次に来るのが変数名 / 値なので入れない。
const SHELL_KEYWORDS = new Set([
  "!", "{", "}", "if", "then", "elif", "else", "fi",
  "while", "until", "do", "done",
]);

const WRAPPER_OPTS_WITH_VALUE = {
  sudo: new Set(["-u", "-g", "-p", "-C", "-h", "-r", "-t", "-U"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "--unset", "-S", "--split-string", "-C", "--chdir"]),
  nice: new Set(["-n"]),
  xargs: new Set(["-n", "-P", "-I", "-d", "-a", "-E", "-L", "-s"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  time: new Set(["-f", "-o"]),
  nohup: new Set(),
  command: new Set(),
  // `exec git ...` はシェル自身を git に置き換えて**実行する**（bash の `help exec`）。
  // `-a name` だけ値を取り、`-c` / `-l` は取らない。
  exec: new Set(["-a"]),
};
// 文字列を分割して実行するオプション（GNU env の `-S` / `--split-string`）。
// 値を単に読み飛ばすと、その中にある本体（git ...）を見落とす。
const SPLIT_STRING_OPTS = new Set(["-S", "--split-string"]);
const basenameOf = (t) => (t.includes("/") ? t.slice(t.lastIndexOf("/") + 1) : t);
const isAssignment = (t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);

// **git の引数リスト**を返す（git を実行していなければ null）。
// 環境変数代入とラッパー（とそのオプション）を読み飛ばし、
// ラッパーが実行する本体が git のときだけ返す。
// `env -S` の展開でトークン列が書き換わるため、**位置ではなく配列そのものを返す**
// （位置を返すと、呼び出し側が展開前の配列を切ってしまう）。
function gitArgs(tokenList) {
  let tokens = tokenList;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (isAssignment(t)) { i++; continue; }                 // VAR=value
    // シェルの**予約語**はコマンドの前置詞なので読み飛ばす。語として残すと
    // 「git ではない実行ファイル」に見えて対象外になる。
    //   `! git worktree remove --force`        否定演算子
    //   `{ git worktree remove --force; }`     ブレースグループ（`{` は予約語）
    //   `if git ... ; then`, `while git ...`   複合コマンドの前置詞
    // 引用した `'!'` や `'{'` は bash では予約語にならないが、その形は実在しない
    // コマンド名として失敗するだけなので、区別せず前置詞として扱う（拒否側に倒す）。
    if (SHELL_KEYWORDS.has(t)) { i++; continue; }
    const base = basenameOf(t);
    if (base === "git") return tokens.slice(i + 1);
    const opts = WRAPPER_OPTS_WITH_VALUE[base];
    if (!opts) return null; // git でもラッパーでもない ＝ git を実行していない
    // ラッパー自身のオプションを読み飛ばす。次に来る非オプションが「本体」で、
    // それを次の周回で改めて判定する（git なら採用、そうでなければ対象外）。
    i++;
    while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "-") {
      if (tokens[i] === "--") { i++; break; }
      // `command -v` / `-V` は**実行せず名前を表示するだけ**（bash の `help command`）。
      // 後続の語は「調べたい名前」で引数ではないので、git を実行しているとは見なさない。
      // これを区別しないと `command -v git worktree remove --force` を誤って拒否する。
      if (base === "command" && /^-[a-zA-Z]*[vV]/.test(tokens[i])) return null;
      const opt = tokens[i];
      const eq = opt.indexOf("=");
      const name = eq < 0 ? opt : opt.slice(0, eq);
      // `env -S '...'` / `--split-string=...` は**文字列を分割して実行**する。
      // 値を読み飛ばすと本体（git）を見失うので、中身を語に割ってその場に差し込む。
      //
      // 空白で split してはいけない。env は payload の中の引用符も外すので、
      // `env -S 'git worktree remove ../v "--force"'` は git に**本物の** `--force` を渡す。
      // 空白 split だと `"--force"` のまま残り、判定を素通りする。
      // 同じ字句解析器を **envSplit モード**で通す。env は payload を argv に割るだけで
      // `;` `|` を演算子として解釈せず、一方で**改行は引数の区切り**として扱うため
      // （`env -S $'git worktree remove ../v\n--force'` は本物の `--force` を渡す）。
      // 通常モードで割って最初のセグメントだけ採ると、この改行で `--force` を落とす。
      //
      // 3 つの書き方すべてを受ける。`-S val` / `--split-string=val` / **`-Sval`**
      // （短オプションに値がくっついた形。GNU env はこれを受け付ける ——
      // `env -S'git worktree remove --force'` が実際に動くことを実測した）。
      // `env` に限定するのは、`sudo -S` が「パスワードを標準入力から読む」で
      // 値を取らない別物のため。
      const attachedS = base === "env" && eq < 0 && /^-S./.test(opt);
      if (attachedS || (base === "env" && SPLIT_STRING_OPTS.has(name))) {
        const payload = attachedS ? opt.slice(2) : eq >= 0 ? opt.slice(eq + 1) : tokens[i + 1];
        const consumed = attachedS || eq >= 0 ? 1 : 2;
        const inner = lexSegments(String(payload ?? ""), { envSplit: true }).flat();
        tokens = [...tokens.slice(0, i), ...inner, ...tokens.slice(i + consumed)];
        continue;   // 差し込んだ先頭から改めて読む
      }
      const takesValue = opts.has(name);
      i++;
      if (takesValue && eq < 0) i++;                        // `-u me` の `me`
    }
    if (tokens[i] === "-") i++;                             // env の `-`
    while (i < tokens.length && isAssignment(tokens[i])) i++; // env NAME=VALUE...
  }
  return null;
}

function isForcedWorktreeRemoval(command) {
  for (const tokens of lexSegments(command)) {
    const rest = gitArgs(tokens);
    if (!rest) continue;
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
