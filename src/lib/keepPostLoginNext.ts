// ログイン後の戻り先（招待リンク等）をサーバ側で貼り直す（延長する）。
// 実体と理由は src/app/auth/next/route.ts のコメントを参照。
// 確認メール / 再設定メールを送る直前に呼ぶ。失敗しても本来のフローは止めない。
export async function keepPostLoginNext(next: string): Promise<void> {
  if (next === "/") return;
  try {
    await fetch("/auth/next", {
      method: "POST",
      body: new URLSearchParams({ next }),
    });
  } catch {
    // 戻り先が失われるだけなので、登録 / 再設定そのものは続行する
  }
}
