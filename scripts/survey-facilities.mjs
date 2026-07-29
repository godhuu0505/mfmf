// =============================================================
// survey-facilities.mjs
//
// 第一種動物取扱業者登録簿（自治体が公開する CSV）を読み、
// 事業所名から「業態」を推定して件数を集計する調査用スクリプト。
//
//   node scripts/survey-facilities.mjs <csv...> [--json] [--samples N]
//   node scripts/survey-facilities.mjs data/*.csv --samples 5
//
// なぜ必要か:
//   docs/explanation/market-analysis.md §16-2 の最大の未検証項目
//   「犬の保育園は何施設あるのか」を数えるため。
//
//   登録簿の業種区分は 販売 / 保管 / 貸出し / 訓練 / 展示 / 競りあっせん / 譲受飼養 の7つで、
//   **「保育園」という区分は存在しない**。犬の保育園は通常「保管」（＋しつけをするなら「訓練」）
//   で登録されるが、「保管」にはペットホテル・トリミング・シッターも全部入るため、
//   保管の件数は **上限（天井）** にしかならない。
//   実数に近づけるには **事業所名のキーワード**で分類するしかない ← 本スクリプトの役目。
//
// 前提:
//   - 外部依存なし（Node 18+ の fetch / TextDecoder のみ）
//   - 自治体 CSV は Shift_JIS が多いので自動判別する
//   - 列名は自治体ごとにばらつくため、ヘッダを推定する
//
// 出力の読み方:
//   「推定」であって「正解」ではない。屋号に業態が出ない事業所（例: 「株式会社○○」）は
//   unknown に落ちる。unknown 比率が高いほど推定の信頼度は下がるので必ず確認すること。
// =============================================================

import { readFileSync } from "node:fs";

// --- 業態の推定ルール ------------------------------------------------------
// 上から順に評価し、最初に当たったものを採用する（優先順位が意味を持つ）。
// 「保育園」系を最優先にするのは、"○○ドッグホテル＆幼稚園" のような複合屋号で
// 我々が知りたい方（保育園）を取りこぼさないため。
const RULES = [
  {
    key: "daycare",
    label: "保育園・幼稚園・デイケア",
    // ひらがな/カタカナ/漢字/英語の揺れを吸収する。
    // ⚠ 語尾の「園」だけを見るルールは置かない。「ペットサロン花園」「○○楽園」のような
    //   無関係な屋号を保育園に誤分類し、その比率が全国推定に直接掛かって過大評価になる。
    //   曖昧な屋号は unknown に落として目視分類へ回す方が安全。
    patterns: [
      /保育園/, /ほいくえん/, /ホイクエン/,
      /幼稚園/, /ようちえん/, /ヨウチエン/,
      /学園/, /スクール/, /school/i,
      /デイケア/, /デイサービス/, /daycare/i, /day\s*care/i,
      // 「園」は犬・ドッグ等の文脈がある場合のみ拾う
      /(犬|いぬ|イヌ|ドッグ|dog|ワン|わん|パピー|puppy)[^、]{0,8}園/i,
    ],
  },
  {
    key: "training",
    label: "しつけ・訓練",
    patterns: [/しつけ/, /躾/, /訓練/, /トレーニング/, /training/i, /ドッグトレーナー/, /training\s*center/i],
  },
  {
    key: "hotel",
    label: "ホテル・預かり",
    patterns: [/ホテル/, /hotel/i, /ペットホテル/, /お預かり/, /預かり/, /シッター/, /sitter/i],
  },
  {
    key: "grooming",
    label: "トリミング・サロン",
    patterns: [/トリミング/, /trimming/i, /グルーミング/, /grooming/i, /サロン/, /salon/i, /美容/],
  },
  {
    key: "clinic",
    label: "動物病院",
    patterns: [/動物病院/, /獣医/, /クリニック/, /clinic/i, /アニマルホスピタル/, /動物医療/],
  },
  {
    key: "shop",
    label: "販売・ショップ",
    patterns: [/ペットショップ/, /ブリーダー/, /繁殖/, /販売/, /shop/i, /ペットプラザ/],
  },
];

// 「保管」業種を表す表記の揺れ
const HOKAN_PATTERNS = [/保管/];

/**
 * 名寄せ用の正規化。全角/半角スペース・記号の揺れで別店舗に割れるのを防ぐ。
 * 住所の「1-1」「１−１」「一丁目1番1号」等の完全な正規化までは踏み込まない
 * （やり過ぎると別店舗を潰す）。
 */
function normalize(v) {
  return String(v ?? "")
    .normalize("NFKC")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[（）()「」【】]/g, "")
    .trim();
}

/** 事業所名から業態を推定する。当たらなければ unknown。 */
export function classify(name) {
  if (!name) return "unknown";
  for (const rule of RULES) {
    if (rule.patterns.some((re) => re.test(name))) return rule.key;
  }
  return "unknown";
}

// --- CSV の読み込み --------------------------------------------------------

/**
 * Shift_JIS / UTF-8 を判別してテキスト化する。
 * UTF-8 として解釈したときに置換文字(U+FFFD)が出るなら Shift_JIS とみなす。
 */
function decode(buf) {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("shift_jis", { fatal: false }).decode(buf);
  } catch {
    return utf8; // shift_jis 非対応環境ならそのまま返す
  }
}

/** 引用符・改行込みの CSV を行×セルに分解する最小実装。 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(cell); cell = "";
    } else if (c === "\n") {
      row.push(cell); rows.push(row); row = []; cell = "";
    } else {
      cell += c;
    }
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

// 事業所名の列を表す表記の揺れ。ヘッダ判定にも列選択にも同じものを使う。
const NAME_PATTERNS = [/事業所.*名/, /施設.*名/, /名称/, /屋号/, /事業者.*名/];

/**
 * ヘッダ行を推定する。自治体ごとに列名も位置もばらつくので、
 * 「実際に事業所名の列を取り出せる」最初の行をヘッダとして扱う。
 *
 * 単に「事業所」を含む行を選ぶと、先頭のタイトル行
 * （例:「第一種動物取扱業登録事業所一覧」）を掴んでしまい、
 * 列が見つからずファイルごとスキップしてしまうため、
 * **候補行に対して実際に列選択を試して**から採用する。
 */
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = rows[i].map((c) => c.trim());
    // 1セルしか無い行はタイトル行とみなす（ヘッダは通常複数列）
    if (cells.filter((c) => c !== "").length < 2) continue;
    if (pickColumn(cells, NAME_PATTERNS) >= 0) return i;
  }
  return 0;
}

function pickColumn(header, patterns, { exclude = [] } = {}) {
  for (const re of patterns) {
    const idx = header.findIndex(
      (h) => re.test(h) && !exclude.some((ex) => ex.test(h)),
    );
    if (idx >= 0) return idx;
  }
  return -1;
}

// --- 集計 ------------------------------------------------------------------

export function survey(files, { samples = 3 } = {}) {
  /** 事業所名 -> { kinds:Set, category } で名寄せする（同一事業所が業種ごとに複数行ある） */
  const byName = new Map();
  const perFile = [];
  // 「業種列が無い」と「業種列はあるが保管が0件」は意味が違うので区別する。
  // 複数ファイルのうち一部しか業種列を持たない場合、保管0件を「意味のあるゼロ」と
  // 断定できない（残りは判定されていない）ので、全ファイルが持つかを見る。
  let filesWithKind = 0;
  let filesEvaluated = 0;

  for (const file of files) {
    const rows = parseCsv(decode(readFileSync(file)));
    if (!rows.length) { perFile.push({ file, rows: 0, note: "空ファイル" }); continue; }

    const h = findHeader(rows);
    const header = rows[h].map((c) => c.trim());
    const nameIdx = pickColumn(header, NAME_PATTERNS);
    // 「業種」の列。法定様式では「業の種類」表記もある。
    // 一方で「動物種別」「取扱動物の種類」といった**動物の種類**の列が併存するため、
    // 汎用の /種別|種類/ でそれを掴まないよう除外する。
    const kindIdx = pickColumn(
      header,
      [/業種/, /業の種類/, /業.*区分/, /登録.*種別/, /種別/, /種類/],
      { exclude: [/動物/, /品種/, /犬種/, /哺乳|鳥類|爬虫/] },
    );
    // 名寄せの鍵は「屋号＋所在地」（＝店舗の実体）。登録番号は業種ごとに振られる
    // 自治体があり、鍵に使うと1店舗が業種の数だけ二重計上されるため使わない。
    const addrIdx = pickColumn(header, [/所在地/, /住所/, /事業所.*所在/]);

    if (nameIdx < 0) {
      perFile.push({ file, rows: rows.length - h - 1, note: "⚠ 事業所名の列を特定できず（スキップ）" });
      continue;
    }

    let n = 0;
    let sitelessRows = 0;
    for (const r of rows.slice(h + 1)) {
      const name = (r[nameIdx] ?? "").trim();
      if (!name) continue;
      n++;
      const kind = kindIdx >= 0 ? (r[kindIdx] ?? "").trim() : "";
      // 数えたいのは「事業所（店舗）」であって「登録（ライセンス）」ではない。
      //   - 同じ店舗が業種ごとに複数行  → まとめたい
      //   - 同名の別店舗（チェーン等）  → 分けたい
      // 登録番号は**業種ごとに別番号**が振られる自治体があり、それを鍵にすると
      // 1店舗が業種の数だけ二重計上される。したがって鍵は
      // **正規化した屋号 + 所在地**（＝店舗の実体）とし、登録番号は鍵に使わない。
      const addr = addrIdx >= 0 ? normalize(r[addrIdx] ?? "") : "";
      const site = addr;
      if (!addr) sitelessRows++;
      const key = `${file}::${normalize(name)}::${site}`;
      if (!byName.has(key)) {
        byName.set(key, { name, category: classify(name), kinds: new Set() });
      }
      if (kind) byName.get(key).kinds.add(kind);
    }
    const idNote = addrIdx >= 0
      ? "屋号＋所在地で名寄せ"
      : "⚠ 所在地列が無く屋号のみで名寄せ（同名の別店舗を1件に潰す＝過小計上）";
    const sitelessNote = sitelessRows
      ? `⚠ 所在地が空の行 ${sitelessRows} 件（同名なら潰れる＝過小計上）`
      : "";
    filesEvaluated++;
    if (kindIdx >= 0) filesWithKind++;
    perFile.push({
      file,
      rows: n,
      kindColumn: kindIdx >= 0 ? header[kindIdx] : null,
      note: [kindIdx < 0 ? "業種列なし（保管の判定は不可）" : `業種列=「${header[kindIdx]}」`, idNote, sitelessNote]
        .filter(Boolean).join(" / "),
    });
  }

  const entries = [...byName.values()];
  const counts = {};
  const examples = {};
  for (const rule of [...RULES, { key: "unknown", label: "不明（屋号から判別不可）" }]) {
    counts[rule.key] = 0;
    examples[rule.key] = [];
  }
  let hokan = 0;
  let hokanDaycare = 0;
  let hokanUnknown = 0;

  for (const e of entries) {
    counts[e.category] = (counts[e.category] ?? 0) + 1;
    if (examples[e.category].length < samples) examples[e.category].push(e.name);
    const isHokan = [...e.kinds].some((k) => HOKAN_PATTERNS.some((re) => re.test(k)));
    if (isHokan) {
      hokan++;
      if (e.category === "daycare") hokanDaycare++;
      if (e.category === "unknown") hokanUnknown++;
    }
  }

  // 全国推定に使うのは hokanDaycare / hokan なので、信頼度は
  // 「全体の不明率」ではなく「保管の中の不明率」で測らないと誤認する。
  // 例) 保管2件（うち不明1）＋ 販売8件 → 全体の不明率10% だが、分母の半分が不明。
  const hokanUnknownRatio = hokan ? hokanUnknown / hokan : null;
  // 不明を全部 daycare と仮定した場合の上限（＝推定のブレ幅）
  const daycareRatioLow = hokan ? hokanDaycare / hokan : null;
  const daycareRatioHigh = hokan ? (hokanDaycare + hokanUnknown) / hokan : null;

  return {
    files: perFile,
    filesWithKind,
    filesEvaluated,
    allFilesHaveKind: filesEvaluated > 0 && filesWithKind === filesEvaluated,
    total: entries.length,
    counts,
    examples,
    hokan,
    hokanDaycare,
    hokanUnknown,
    hokanUnknownRatio,
    daycareRatioLow,
    daycareRatioHigh,
    unknownRatio: entries.length ? counts.unknown / entries.length : 0,
  };
}

// --- CLI -------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const sIdx = argv.indexOf("--samples");
  const samples = sIdx >= 0 ? Number(argv[sIdx + 1]) || 3 : 3;
  const files = argv.filter((a, i) => !a.startsWith("--") && !(sIdx >= 0 && i === sIdx + 1));

  if (!files.length) {
    console.error(`使い方: node scripts/survey-facilities.mjs <csv...> [--json] [--samples N]

第一種動物取扱業者登録簿の CSV を渡すと、事業所名から業態を推定して集計します。
登録簿は各自治体が公開しています（動愛法により知事に公開義務あり）。
  例) 柏市・埼玉県・さいたま市・福岡県・大阪府 ほか
      全国リンク集: https://animals-peace.net/companionanimal/link

Excel しか無い自治体は CSV に書き出してから渡してください。`);
    process.exit(1);
  }

  const r = survey(files, { samples });
  if (asJson) { console.log(JSON.stringify(r, null, 2)); return; }

  console.log("=== 読み込み ===");
  for (const f of r.files) console.log(`  ${f.file}: ${f.rows} 行 ${f.note}`);

  console.log(`\n=== 事業所数（名寄せ後）: ${r.total} ===`);
  const labelOf = Object.fromEntries([...RULES, { key: "unknown", label: "不明（屋号から判別不可）" }].map((x) => [x.key, x.label]));
  const ordered = Object.entries(r.counts).sort((a, b) => b[1] - a[1]);
  for (const [key, n] of ordered) {
    if (!n) continue;
    const pct = ((n / r.total) * 100).toFixed(1);
    console.log(`  ${String(labelOf[key]).padEnd(24)} ${String(n).padStart(5)} (${pct}%)`);
    const ex = r.examples[key];
    if (ex?.length) console.log(`      例: ${ex.join(" / ")}`);
  }

  const pct = (x) => `${(x * 100).toFixed(1)}%`;

  if (r.hokan) {
    console.log(`\n=== 業種「保管」で登録: ${r.hokan} 事業所（全国推定の分母） ===`);
    console.log(`  うち屋号が保育園・幼稚園系: ${r.hokanDaycare}`);
    console.log(`  うち屋号から判別不可      : ${r.hokanUnknown}`);
    console.log(`  ※「保管」にはホテル・トリミング・シッターも含まれるため、これは上限（天井）。`);
    console.log(`\n  保育園比率（全国推定に掛ける値）:`);
    console.log(`    下限 ${pct(r.daycareRatioLow)}  … 不明を全部「保育園でない」とみなす`);
    console.log(`    上限 ${pct(r.daycareRatioHigh)}  … 不明を全部「保育園」とみなす`);
    console.log(`    → この幅がそのまま全国推定のブレ幅になる。`);
  } else if (r.allFilesHaveKind) {
    console.log(`\n=== 業種「保管」で登録: 0 事業所 ===`);
    console.log(`  全ファイルで業種列を読めており、保管の登録が1件も無い（＝意味のあるゼロ）。`);
    console.log(`  該当自治体に保管業態が無いのか、業種の表記が想定と違うのかを確認すること。`);
  } else if (r.filesWithKind > 0) {
    console.log(`\n=== 業種「保管」で登録: 0 事業所（⚠ 部分的な結果） ===`);
    console.log(`  業種列を読めたのは ${r.filesWithKind}/${r.filesEvaluated} ファイルだけ。`);
    console.log(`  残りは保管かどうか判定できていないため、このゼロは「保管が無い」ことを意味しない。`);
    console.log(`  業種列のあるファイルだけで集計し直すか、列名を確認すること。`);
  } else {
    console.log(`\n※ 業種列が無いため「保管」の集計は不可。屋号ベースの推定のみ。`);
  }

  console.log(`\n=== 信頼度 ===`);
  console.log(`  全体の不明率: ${pct(r.unknownRatio)}`);
  if (r.hokanUnknownRatio !== null) {
    console.log(`  保管内の不明率: ${pct(r.hokanUnknownRatio)}  ← こちらが推定の信頼度`);
    if (r.hokanUnknownRatio > 0.4) {
      console.log(`  ⚠ 分母（保管）の4割超が判別不可。この比率で全国推定してはいけない。`);
      console.log(`     保管の事業所を100件サンプリングして目視分類し、補正率を出すこと。`);
    }
  }
  if (r.unknownRatio > 0.4) {
    console.log(`  ⚠ 全体の不明率も高い。屋号に業態が出ない事業所が多い。`);
  }
  console.log(`\n注: これは推定であって census ではない。docs/explanation/market-analysis.md §2 参照。`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
