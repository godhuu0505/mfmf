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
      // 「スクール」「学園」は単体で使わない。「トリミングスクール」「東京愛犬美容学園」
      // （いずれもトリマー養成校）が保育園に化けて分子を膨らませるため、
      // 犬・パピー・しつけ等の文脈を要求する。
      /(犬|いぬ|イヌ|ドッグ|dog|ワン|わん|パピー|puppy|しつけ|obedience)[^、]{0,8}(スクール|school|学園)/i,
      /デイケア/, /デイサービス/, /daycare/i, /day\s*care/i,
      // 「園」は犬・ドッグ等の**直後**に来る場合のみ拾う（「犬の○○園」の形）。
      // 距離を空けると「ドッグサロン花園」の「ドッグ…花園」まで拾ってしまう。
      // さらに下の looksGrooming() でサロン系を除外している。
      /(犬|いぬ|イヌ|ドッグ|dog|ワン|わん|パピー|puppy)の?[^、]{0,3}園/i,
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

// 法定の業種区分。列見出しだけで業種列と決めつけず、**中身がこれらを含むか**で検証する
// （「事業者種別（法人/個人）」のような無関係な列を業種列と誤認しないため）。
const STATUTORY_KINDS = [/販売/, /保管/, /貸出/, /訓練/, /展示/, /競り/, /譲受/];

// 犬の保育園の推定分子に寄与するカテゴリ。
// しつけ・訓練も「保管」を持てば定期通園の預かり業態（market-analysis.md §18-6）。
const TARGET_CATEGORIES = ["daycare", "training"];

// classify() が返しうるが RULES に無い擬似カテゴリ（集計・表示用）
const EXTRA_CATEGORIES = [
  { key: "non_dog", label: "犬以外の動物向け（犬の推定から除外）" },
  { key: "unknown", label: "不明（屋号から判別不可）" },
];
const ALL_CATEGORIES = () => [...RULES, ...EXTRA_CATEGORIES];

// 犬/猫の判別。推定したいのは **犬の**保育園なので、「猫の保育園」を分子に入れない。
// 犬側はゆるく（誤検知しても「猫のみ」判定を避けるだけなので安全側）、
// 猫側は厳密に（誤検知すると分子から落ちて過小評価になるため）。
// 英単語は **語境界**で判定する。EDUCATION / CATCH のような語の内部に cat が入る屋号を
// 猫扱いしてしまうため（この判定はスペースを残した文字列に対して行う）。
const DOG_PATTERNS = [/犬/, /いぬ/, /イヌ/, /ドッグ/, /dog/i, /わん/, /ワン/, /パピー/, /puppy/i];
// 犬以外の動物が明示されている屋号。犬の語が無ければ推定分子から外す。
// ⚠ 「犬の語が無い＝除外」にはしない。「ペット保育園さくら」のように種を書かない
//    屋号が多く、そこまで要求すると取りこぼしで過小評価になる。
//    **別の種が明示されている**ときだけ落とす。
const OTHER_SPECIES_PATTERNS = [
  /猫/, /ねこ/, /ネコ/, /キャット/, /にゃん/, /ニャン/, /\bcats?\b/i,
  /うさぎ/, /ウサギ/, /兎/, /\brabbits?\b/i,
  /馬/, /ホース/, /\bhorses?\b/i,
  /鳥/, /インコ/, /\bbirds?\b/i,
  /フェレット/, /ハムスター/, /爬虫/, /リクガメ/, /\breptiles?\b/i,
];

// トリマー/訓練士の**養成校**。屋号に犬の語が入る（「愛犬」等）ため犬の文脈を
// 要求しても弾けない。美容・トリミング系の語と学校系の語が同居したら養成校とみなす。
// 例) 東京愛犬美容学園 / ○○トリミングスクール
const GROOMING_WORDS = [/美容/, /トリミング/, /グルーミング/, /trimming/i, /grooming/i, /サロン/, /salon/i];
const SCHOOL_WORDS = [/学園/, /スクール/, /school/i, /専門学校/, /養成/, /学院/];
// 人材（トリマー・訓練士）の養成校を示す語。犬の語を含むので通常の判定では弾けない。
const VOCATIONAL_WORDS = [/養成/, /専門学校/, /学院/, /トレーナー(養成|科)/, /訓練士/, /資格/];

function isGroomingSchool(name) {
  // 美容・サロン系 × 学校系 → トリマー養成校
  if (GROOMING_WORDS.some((re) => re.test(name)) && SCHOOL_WORDS.some((re) => re.test(name))) return true;
  // 「ドッグトレーナー養成スクール」のように、人を育てる語 × 学校系 → 訓練士養成校
  if (VOCATIONAL_WORDS.some((re) => re.test(name)) && SCHOOL_WORDS.some((re) => re.test(name))) return true;
  return false;
}

/** 屋号にトリミング・サロン系の語があるか（「園」の緩い判定を上書きするために使う）。 */
function looksGrooming(name) {
  return GROOMING_WORDS.some((re) => re.test(name));
}

/** 屋号が「犬以外の動物向け」を示すか（別の種が明示され、犬の語が無い）。 */
function isNonDog(name) {
  return OTHER_SPECIES_PATTERNS.some((re) => re.test(name)) && !DOG_PATTERNS.some((re) => re.test(name));
}

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

/**
 * 住所が「全国で一意」と言える形か（都道府県または市区町村から始まる）。
 * 「中央1-1」のような相対住所は自治体をまたぐと衝突するため、
 * ファイルを横断した名寄せに使えない。
 */
const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
  "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

function isQualifiedAddress(v) {
  const n = normalize(v);
  if (!n) return false;
  // ⚠ 文字が「含まれる」だけでは判定できない。
  //    「府中町1-1」は府を、「市川1-1」は市を含むが、どちらも全国で一意ではない。
  //    **先頭が実在の都道府県名**か、**先頭付近で市/郡が閉じている**ことを要求する。
  if (PREFECTURES.some((pref) => n.startsWith(pref))) return true;
  // 「柏市…」「市原市…」は可。「市川1-1」（市が先頭）や「府中町…」は不可。
  return /^.{1,5}[市郡]/.test(n);
}

/**
 * 分類用の正規化。全角→半角は行うが **スペースは1つに詰めるだけで消さない**。
 * 消すと "CATCH PET SCHOOL" が "CATCHPETSCHOOL" になり、英単語の語境界判定が壊れる。
 */
function normalizeForMatch(v) {
  return String(v ?? "")
    .normalize("NFKC")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

/**
 * 事業所名から業態を推定する。当たらなければ unknown。
 *
 * 「ＤＯＧ ＳＣＨＯＯＬ」「ﾄﾘﾐﾝｸﾞ」のような全角英数・半角カナは日本の屋号に頻出するので、
 * **正規化してから**判定する（していないと軒並み unknown に落ちて過小評価になる）。
 */
export function classify(name) {
  const n = normalizeForMatch(name);
  if (!n) return "unknown";
  // 養成校（トリマー/訓練士）は「犬」の語を含むので、通常の優先順位だと保育園に化ける。先に落とす。
  if (isGroomingSchool(n)) return "grooming";
  // 「ドッグサロン花園」のようにサロン名に「園」が入るケースだけを救済する。
  // ⚠ サロンの語があるだけで早期 return しない。「ドッグサロンABCしつけ教室」のように
  //    しつけ（＝対象業態）が明示されている複合屋号まで grooming にしてしまうため。
  const EXPLICIT_DAYCARE = /保育園|幼稚園|ようちえん|ほいくえん|ヨウチエン|ホイクエン|デイケア|デイサービス|daycare/i;
  const EXPLICIT_TRAINING = /しつけ|躾|訓練|トレーニング|training/i;
  const salonOverridesEn = looksGrooming(n) && !EXPLICIT_DAYCARE.test(n) && !EXPLICIT_TRAINING.test(n);
  for (const rule of RULES) {
    // 「園」だけを根拠に daycare にする緩い判定は、サロン系の屋号では採らない
    const patterns = rule.key === "daycare" && salonOverridesEn
      ? rule.patterns.filter((re) => !String(re).includes("園/i"))
      : rule.patterns;
    if (patterns.some((re) => re.test(n))) {
      // 犬の推定分子に入るカテゴリ（保育園系・しつけ系）のうち「猫だけ」の施設は外す。
      // ⚠ 分子に寄与するカテゴリ**すべて**に適用すること。片方だけだと
      //    「猫のしつけ教室」が犬の分子に入る。
      if (TARGET_CATEGORIES.includes(rule.key) && isNonDog(n)) return "non_dog";
      return rule.key;
    }
  }
  return "unknown";
}

// --- CSV の読み込み --------------------------------------------------------

/**
 * Shift_JIS / UTF-8 を判別してテキスト化する。
 * UTF-8 として解釈したときに置換文字(U+FFFD)が出るなら Shift_JIS とみなす。
 */
function decode(buf) {
  // U+FFFD の有無で判定してはいけない。正しい UTF-8 のファイルでも、値の中に
  // 置換文字が1つ紛れていれば全体を Shift_JIS と誤認し、ヘッダごと文字化けして
  // 全行スキップになる。**不正なバイト列かどうか**を fatal デコーダで判定する。
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    // UTF-8 として不正 → Shift_JIS（自治体 CSV に多い）とみなす
    try {
      return new TextDecoder("shift_jis", { fatal: false }).decode(buf);
    } catch {
      return new TextDecoder("utf-8", { fatal: false }).decode(buf);
    }
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
// ⚠ 順序に意味がある（pickColumn は最初に当たったものを採る）。
// 「法人名称」と「屋号」が併存する登録簿で、汎用の /名称/ を先に置くと
// **法人名を掴んで屋号を取り逃す**（＝その施設が unknown に落ちて分子から消える）。
// 施設固有の見出しを先に、法人・汎用の見出しを後に置く。
const NAME_PATTERNS = [
  /屋号/,
  /事業所.*名/, /施設.*名/, /店舗.*名/,
  /名称/, /事業者.*名/, /法人.*名/,
];

// ⚠ 人名の列を掴まないための除外。「事業所代表者氏名」は /事業所.*名/ に当たるため、
// 除外しないと代表者名を屋号として分類してしまい（→ unknown）、施設が分子から消える。
const NAME_EXCLUDE = [/氏名/, /代表者/, /責任者/, /担当者/, /管理者/];

/**
 * 「事業者（法人）の名称」を指す見出し。**施設の実体を表さない**ので、
 * 名寄せの一致判定には使わない（分類の材料としては引き続き使う）。
 * これを一致判定に混ぜると、同じ法人が同じ住所で出している別業態の店舗
 * （「ABCトリミング」と「犬の保育園XYZ」）が法人名だけで1件に潰れる。
 * ⚠ /事業者/ は「事業所」には当たらない（「者」と「所」は別字）。
 */
const OPERATOR_NAME_HEADINGS = [/事業者/, /法人/, /会社/, /申請者/, /設置者/, /団体/];
const isOperatorName = (heading) => OPERATOR_NAME_HEADINGS.some((re) => re.test(heading));

/** 「事業者（法人）の住所」を指す見出し。施設の所在地ではないので鍵にしない。 */
const OPERATOR_ADDR_HEADINGS = [/事業者/, /法人/, /本社/, /本店/, /代表者/];

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
  // ヘッダらしさは「名前列があること」だけでは足りない。
  //   例) 「第一種動物取扱業事業所名簿, 2026年7月」
  // は2セルあり /事業所.*名/ にも当たるが、これはタイトル行。
  // **名前列に加えて、他の既知の列（所在地・業種・番号）が最低1つある**ことを要求する。
  const OTHER_COLUMN_PATTERNS = [
    [/所在地/, /住所/],
    [/業種/, /業の種類/, /業.*区分/, /種別/, /種類/],
    [/登録番号/, /許可番号/, /番号/],
    [/登録年月日/, /有効期間/, /責任者/],
  ];
  // 日付らしいセルを含む行はタイトル行とみなす（「2026年7月」等）
  const looksDated = (cells) =>
    cells.some((c) => /\d{4}\s*年|\d{4}[/-]\d{1,2}|現在/.test(c));

  let relaxed = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = rows[i].map((c) => c.trim());
    if (cells.filter((c) => c !== "").length < 2) continue;
    if (pickColumn(cells, NAME_PATTERNS, { exclude: NAME_EXCLUDE }) < 0) continue;
    const others = OTHER_COLUMN_PATTERNS.filter(
      (group) => pickColumn(cells, group) >= 0,
    ).length;
    if (others >= 1) return i;
    // 名前列はあるが他の既知列が無い行。タイトル行でなければ次善の候補として控える。
    if (relaxed < 0 && !looksDated(cells)) relaxed = i;
  }
  // ⚠ 見つからないときに 0（＝タイトル行）へ落とさない。
  //    落とすと本物のヘッダ行が1件の「事業所」として数えられ、総数と不明率が汚れる。
  return relaxed;
}

/** マッチする列を優先順位の順に**すべて**返す（重複は除く）。 */
function pickColumns(header, patterns, { exclude = [] } = {}) {
  const found = [];
  for (const re of patterns) {
    header.forEach((h, i) => {
      if (re.test(h) && !exclude.some((ex) => ex.test(h)) && !found.includes(i)) found.push(i);
    });
  }
  return found;
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
  /** バケツ（住所 or ファイル） -> 施設クラスタの配列。1クラスタ = 1事業所 */
  const byName = new Map();
  const perFile = [];
  // 「業種列が無い」と「業種列はあるが保管が0件」は意味が違うので区別する。
  // 複数ファイルのうち一部しか業種列を持たない場合、保管0件を「意味のあるゼロ」と
  // 断定できない（残りは判定されていない）ので、全ファイルが持つかを見る。
  let filesWithKind = 0;
  let filesEvaluated = 0;
  // 事業所名の列を特定できずスキップしたファイル。中身に保管があっても集計されないので、
  // 「全ファイルを評価した」と言ってはいけない。
  let filesSkipped = 0;

  for (const file of files) {
    const rows = parseCsv(decode(readFileSync(file)));
    if (!rows.length) { perFile.push({ file, rows: 0, note: "空ファイル" }); continue; }

    const h = findHeader(rows);
    if (h < 0) {
      filesSkipped++;
      perFile.push({ file, rows: rows.length, note: "⚠ ヘッダ行を特定できず（スキップ）" });
      continue;
    }
    const header = rows[h].map((c) => c.trim());
    // 名前列は**優先順位つきで複数**保持する。「屋号」を優先しつつ、
    // その行で空なら「事業所の名称」へ落ちる（屋号は任意入力の登録簿が多く、
    // 1列に固定すると空の行を丸ごと捨ててしまう）。
    const nameIdxs = pickColumns(header, NAME_PATTERNS, { exclude: NAME_EXCLUDE });
    const nameIdx = nameIdxs.length ? nameIdxs[0] : -1;
    // 「業種」の列。法定様式では「業の種類」表記もある。
    // 一方で「動物種別」「取扱動物の種類」といった**動物の種類**の列が併存するため、
    // 汎用の /種別|種類/ でそれを掴まないよう除外する。
    const kindIdxsRaw = pickColumns(
      header,
      [/業種/, /業の種類/, /業.*区分/, /登録.*種別/, /種別/, /種類/],
      // 除外は**動物の種類**を指す見出しに限る。/動物/ で丸ごと弾くと、
      // 法定の「動物取扱業種別」まで落ちて、そのファイルが集計から消える。
      // 「動物の種別」のように助詞が入る表記もあるため /動物の?種別/ で拾う
      // （「動物取扱業種別」は 動物 の直後が「取」なので該当しない）。
      { exclude: [/動物の?種別/, /動物の?種類/, /取扱動物/, /品種/, /犬種/, /哺乳|鳥類|爬虫/] },
    );
    // 「業種1」「業種2」のように登録業種が複数列に分かれる登録簿があるため、
    // 1列だけ読むと保管を取り逃す。該当する列は**すべて**見る。
    // さらに、見出しが当たっても**中身が法定業種でない列は捨てる**
    // （「事業者種別=法人/個人」を業種列と誤認すると、評価済み扱いのまま
    //   保管ゼロを「意味のあるゼロ」と報告してしまう）。
    const dataRows = rows.slice(h + 1);
    const validKindIdxs = kindIdxsRaw.filter((i) =>
      dataRows.some((r) => STATUTORY_KINDS.some((re) => re.test(normalize(r[i] ?? "")))),
    );
    const kindIdxs = validKindIdxs;
    // 名寄せの鍵は「屋号＋所在地」（＝店舗の実体）。登録番号は業種ごとに振られる
    // 自治体があり、鍵に使うと1店舗が業種の数だけ二重計上されるため使わない。
    // ⚠ 順序に意味がある。「事業者所在地」と「事業所所在地」が併存する場合、
    // 汎用の /所在地/ を先に置くと**事業者（本社）の住所**を掴み、
    // 同じ屋号の別店舗が1件に潰れる。施設固有の見出しを先に。
    // 「所在地（市区町村）」「所在地（町名番地）」のように住所が複数列に分かれる登録簿が
    // あるため、**該当する列をすべて連結**する。1列だけ読むと、市区町村だけが鍵になって
    // その自治体の全事業所が1件に潰れる。
    // ⚠ 「事業者（本社）所在地」を鍵に混ぜないこと。ある業種の行では埋まっていて
    //    別の業種の行では空、という登録簿があり、混ぜると同じ施設が別バケツに割れて
    //    **二重計上**される。施設側の住所列が1つでもあるならそちらだけを使い、
    //    施設側が存在しない登録簿（1事業者1事業所の様式）でのみ事業者住所に落ちる。
    const addrIdxsAll = pickColumns(header, [
      /事業所.*所在/, /施設.*所在/, /店舗.*所在/,
      /事業所.*住所/, /施設.*住所/, /店舗.*住所/,
      /所在地/, /住所/,
    ]);
    const addrIdxsFacility = addrIdxsAll.filter(
      (i) => !OPERATOR_ADDR_HEADINGS.some((re) => re.test(header[i])),
    );
    const addrIdxs = addrIdxsFacility.length ? addrIdxsFacility : addrIdxsAll;
    const addrIdx = addrIdxs.length ? addrIdxs[0] : -1;

    if (nameIdx < 0) {
      filesSkipped++;
      perFile.push({ file, rows: rows.length - h - 1, note: "⚠ 事業所名の列を特定できず（スキップ）" });
      continue;
    }

    let n = 0;
    let sitelessRows = 0;
    let unqualifiedAddrRows = 0;
    let lastEntry = null;
    for (const r of dataRows) {
      // 候補列の値を**すべて**拾う。行によって埋まっている列が違うため、
      // 「その行で最初に埋まっていた値」を鍵にすると同じ店舗が割れる。
      // 列の優先順位（屋号 > 事業所名 > … > 法人名）を**保持したまま**拾う。
      // 順位を捨てて集約すると、法人名（「犬の保育園株式会社」）が実際の店舗の
      // 屋号（「ABCトリミング」）を上書きしてしまう。
      const rowNamed = nameIdxs
        .map((i, rank) => ({
          name: (r[i] ?? "").trim(),
          rank,
          operator: isOperatorName(header[i]),
        }))
        .filter((x) => x.name);
      const rowNames = rowNamed.map((x) => x.name);
      // Excel の結合セルを CSV 化すると、業種ごとに「,保管,」のような**継続行**が出る。
      // 名前が空だからと捨てると、その施設の保管登録が丸ごと失われる。
      // 直前の施設に業種だけを足す。
      if (!rowNames.length) {
        const contKinds = kindIdxs.map((i) => normalize(r[i] ?? "")).filter(Boolean);
        if (lastEntry && contKinds.length) {
          n++;
          for (const k of contKinds) lastEntry.kinds.add(k);
        }
        continue;
      }
      n++;
      // 業種の値は表記ゆれ（「保　管」等）があるので正規化してから保持する
      const kinds = kindIdxs.map((i) => normalize(r[i] ?? "")).filter(Boolean);
      // 数えたいのは「事業所（店舗）」であって「登録（ライセンス）」ではない。
      //   - 同じ店舗が業種ごとに複数行  → まとめたい
      //   - 同名の別店舗（チェーン等）  → 分けたい
      // 登録番号は**業種ごとに別番号**が振られる自治体があり、それを鍵にすると
      // 1店舗が業種の数だけ二重計上される。したがって鍵は
      // **正規化した屋号 + 所在地**（＝店舗の実体）とし、登録番号は鍵に使わない。
      const rawAddr = addrIdxs.map((i) => (r[i] ?? "").trim()).filter(Boolean).join("");
      const addr = normalize(rawAddr);
      if (!addr) sitelessRows++;
      // 相対住所（「中央1-1」等）は自治体をまたぐと衝突するので、
      // その行だけファイル名で名前空間を切る。全国で一意な住所ならファイル横断で名寄せする
      // （自治体が業種ごとに別 CSV を出すケースを潰さないため）。
      const qualified = addr ? isQualifiedAddress(rawAddr) : false;
      if (addr && !qualified) unqualifiedAddrRows++;
      // ⚠ 住所が空のときに `${file}|` のような truthy な鍵を作らないこと。
      //    作ると住所の無い行が**全部1件に統合**される。
      const bucket = addr
        ? (qualified ? `site::${addr}` : `site::${file}|${addr}`)
        : `noaddr::${file}`;

      // 同じ住所でも**別テナント**（屋号が全く違う）は別施設として数える。
      // 逆に、行ごとに埋まる列が違って呼称が揺れるケースは**別名を共有していれば**統合する。
      const norm = rowNames.map(normalize);
      // 一致判定に使う別名は**施設名（屋号・事業所名）のみ**。法人名まで含めると、
      // 同じ法人が同じ住所で出している別業態の店舗が1件に潰れる。
      // 法人名しか無い行（施設名の列が空 or 存在しない登録簿）に限り、
      // 代替として法人名を鍵にする（そうしないと行ごとに別施設として増殖する）。
      const facilityNorm = rowNamed.filter((x) => !x.operator).map((x) => normalize(x.name));
      const compat = facilityNorm.length ? facilityNorm : norm;
      const clusters = byName.get(bucket) ?? [];
      const hit = [];
      for (const c of clusters) {
        if (compat.some((nm) => c.compat.has(nm))) hit.push(c);
      }
      let entry;
      if (!hit.length) {
        entry = { names: new Set(), normNames: new Set(), compat: new Set(), kinds: new Set(), ranked: [] };
        clusters.push(entry);
        byName.set(bucket, clusters);
      } else {
        // 複数クラスタに跨って一致したら1つに畳む（推移的に同一施設とみなす）
        entry = hit[0];
        for (const other of hit.slice(1)) {
          for (const v of other.names) entry.names.add(v);
          for (const v of other.normNames) entry.normNames.add(v);
          for (const v of other.compat) entry.compat.add(v);
          for (const v of other.kinds) entry.kinds.add(v);
          entry.ranked.push(...other.ranked);
          clusters.splice(clusters.indexOf(other), 1);
        }
      }
      rowNamed.forEach((x, i) => {
        entry.names.add(x.name);
        entry.normNames.add(norm[i]);
        entry.ranked.push(x);
      });
      for (const nm of compat) entry.compat.add(nm);
      for (const k of kinds) entry.kinds.add(k);
      lastEntry = entry;
    }
    const idNote = addrIdx >= 0
      ? "所在地で名寄せ（屋号は別名として集約）"
      : "⚠ 所在地列が無く屋号のみで名寄せ（同名の別店舗を1件に潰す＝過小計上）";
    const sitelessNote = sitelessRows
      ? `⚠ 所在地が空の行 ${sitelessRows} 件（同名なら潰れる＝過小計上）`
      : "";
    const unqualifiedNote = unqualifiedAddrRows
      ? `⚠ 都道府県/市区町村から始まらない住所 ${unqualifiedAddrRows} 件`
        + `（自治体をまたぐ衝突を避けるためファイル単位で分離。同一自治体を複数 CSV に`
        + `分けている場合は結合してから渡すこと）`
      : "";
    filesEvaluated++;
    if (kindIdxs.length > 0) filesWithKind++;
    perFile.push({
      file,
      rows: n,
      kindColumns: kindIdxs.map((i) => header[i]),
      note: [kindIdxs.length === 0 ? "業種列なし（保管の判定は不可）" : `業種列=「${kindIdxs.map((i) => header[i]).join("」「")}」`, idNote, sitelessNote, unqualifiedNote]
        .filter(Boolean).join(" / "),
    });
  }

  // 1つの事業所に複数の呼称（法人名・屋号）が集まるので、
  // **業態が判別できる呼称**を優先して分類する（法人名だけ見て unknown にしない）。
  const entries = [...byName.values()].flat().map((e) => {
    const names = [...e.names];
    // 分類の優先順位は **①列の優先度（屋号＞…＞法人名） → ②RULES の宣言順**。
    //   ① を先に見るのは、実際の店舗を表すのは屋号であって法人名ではないため
    //      （「屋号=ABCトリミング / 法人名=犬の保育園株式会社」は grooming）。
    //   ② を後段に置くのは、同順位で複数の別名が並んだときに CSV の行順で
    //      結果が変わらないようにするため。
    const order = [...RULES.map((r) => r.key), "non_dog"];
    const rank2 = (c) => { const i = order.indexOf(c); return i < 0 ? order.length : i; };
    const ranked = [...e.ranked]
      .map((x) => ({ ...x, c: classify(x.name) }))
      .sort((a, b) => a.rank - b.rank || rank2(a.c) - rank2(b.c));
    let category = "unknown";
    let display = names[0] ?? "";
    const first = ranked.find((x) => x.c !== "unknown");
    if (first) { category = first.c; display = first.name; }
    return { name: display, names, category, kinds: e.kinds };
  });
  const counts = {};
  const examples = {};
  for (const rule of ALL_CATEGORIES()) {
    counts[rule.key] = 0;
    examples[rule.key] = [];
  }
  let hokan = 0;
  let hokanDaycare = 0;
  let hokanTraining = 0;
  let hokanUnknown = 0;

  for (const e of entries) {
    counts[e.category] = (counts[e.category] ?? 0) + 1;
    if (examples[e.category].length < samples) examples[e.category].push(e.name);
    const isHokan = [...e.kinds].some((k) => HOKAN_PATTERNS.some((re) => re.test(normalize(k))));
    if (isHokan) {
      hokan++;
      if (e.category === "daycare") hokanDaycare++;
      // 「保管」を持つしつけ・訓練施設は、預かって面倒を見ている＝保育園業態。
      // market-analysis.md §18-6 が「定期通園するしつけ教室はターゲットに含む」と
      // 定めているので、分子から落とすと過小評価になる。
      if (e.category === "training") hokanTraining++;
      if (e.category === "unknown") hokanUnknown++;
    }
  }

  // 全国推定に使うのは hokanDaycare / hokan なので、信頼度は
  // 「全体の不明率」ではなく「保管の中の不明率」で測らないと誤認する。
  // 例) 保管2件（うち不明1）＋ 販売8件 → 全体の不明率10% だが、分母の半分が不明。
  const hokanUnknownRatio = hokan ? hokanUnknown / hokan : null;
  // 分子は「保育園系」＋「保管を持つしつけ・訓練系」（＝定期通園の預かり業態）
  const hokanTarget = hokanDaycare + hokanTraining;
  // 不明を全部ターゲットと仮定した場合の上限（＝推定のブレ幅）
  const daycareRatioLow = hokan ? hokanTarget / hokan : null;
  const daycareRatioHigh = hokan ? (hokanTarget + hokanUnknown) / hokan : null;

  return {
    files: perFile,
    filesWithKind,
    filesEvaluated,
    filesSkipped,
    allFilesHaveKind:
      filesEvaluated > 0 && filesWithKind === filesEvaluated && filesSkipped === 0,
    total: entries.length,
    counts,
    examples,
    hokan,
    hokanDaycare,
    hokanTraining,
    hokanTarget,
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
  const labelOf = Object.fromEntries(ALL_CATEGORIES().map((x) => [x.key, x.label]));
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
    console.log(`  うち屋号が保育園・幼稚園系  : ${r.hokanDaycare}`);
    console.log(`  うちしつけ・訓練系（保管あり）: ${r.hokanTraining}  ← 定期通園の預かり業態として分子に含む`);
    console.log(`  合計（推定の分子）          : ${r.hokanTarget}`);
    console.log(`  うち屋号から判別不可        : ${r.hokanUnknown}`);
    console.log(`  ※「保管」にはホテル・トリミング・シッターも含まれるため、これは上限（天井）。`);
    console.log(`\n  対象業態の比率（全国推定に掛ける値）:`);
    console.log(`    下限 ${pct(r.daycareRatioLow)}  … 不明を全部「対象業態でない」とみなす`);
    console.log(`    上限 ${pct(r.daycareRatioHigh)}  … 不明を全部「対象業態」とみなす`);
    console.log(`    → この幅がそのまま全国推定のブレ幅になる。`);
    if (!r.allFilesHaveKind) {
      console.log(`\n  ⚠ この比率は入力の一部だけから計算されている`);
      console.log(`     （業種列を読めたのは ${r.filesWithKind}/${r.filesEvaluated} ファイル`
        + `${r.filesSkipped ? `、さらに ${r.filesSkipped} ファイルは列を特定できずスキップ` : ""}）。`);
      console.log(`     残りのファイルの事業所は分母に入っていないため、そちらの業態構成が`);
      console.log(`     違えば比率は偏る。全国推定に使う前に、全ファイルで業種列を読める状態にすること。`);
    }
  } else if (r.allFilesHaveKind) {
    console.log(`\n=== 業種「保管」で登録: 0 事業所 ===`);
    console.log(`  全ファイルで業種列を読めており、保管の登録が1件も無い（＝意味のあるゼロ）。`);
    console.log(`  該当自治体に保管業態が無いのか、業種の表記が想定と違うのかを確認すること。`);
  } else if (r.filesWithKind > 0) {
    console.log(`\n=== 業種「保管」で登録: 0 事業所（⚠ 部分的な結果） ===`);
    console.log(`  業種列を読めたのは ${r.filesWithKind}/${r.filesEvaluated} ファイルだけ`
      + `${r.filesSkipped ? `、さらに ${r.filesSkipped} ファイルはスキップ` : ""}。`);
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
