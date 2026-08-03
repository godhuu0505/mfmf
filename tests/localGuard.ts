// テストの seed が本物（ホスト済み Supabase = 本番プロジェクト）へ向かう事故を
// 構造的に塞ぐ（V3: 起きないようにする。検知は次善）。
//
// .env.local に本番値が入ったまま test:integration / test:e2e を実行しても、
// ここでループバック以外を拒否し、1 リクエストも送らせない。seed は実ユーザーの
// 作成と確認メールの送信を伴うため、宛先の検証は「安全なものだけ通す」（V2）。
// integration と e2e の両 globalSetup が使う。

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function assertLocalSupabase(supabaseUrl: string, dbUrl: string): void {
  const targets: [label: string, raw: string][] = [
    ["NEXT_PUBLIC_SUPABASE_URL", supabaseUrl],
    ["E2E_DB_URL", dbUrl],
  ];
  for (const [label, raw] of targets) {
    let host: string;
    try {
      host = new URL(raw).hostname;
    } catch {
      throw new Error(`${label} が URL として解釈できません: ${raw}`);
    }
    if (!LOCAL_HOSTS.has(host)) {
      throw new Error(
        `${label} がローカル（127.0.0.1 / localhost）以外を指しています: ${host}\n` +
          "テストの seed は実ユーザー作成・メール送信を伴うため、" +
          "ホスト済み Supabase に対しては実行しません。`npx supabase start` の" +
          "ローカル値を設定してください。",
      );
    }
  }
}
