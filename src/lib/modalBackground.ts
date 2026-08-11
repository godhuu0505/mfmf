// モーダル（ボトムシート・ダイアログ）を開いているあいだ、背景
// （`[data-app-modal-bg]` = ヘッダー・本文・タブバー）を inert にして、
// Tab / 支援技術がモーダルの外へ出ないようにする。
//
// **開いている数を数えて持つ**のが要点 —— 「作成」シートから
// カレンダーの日別シートへ持ち替えるように、2 つのモーダルが同じコミットで
// 入れ替わる経路がある。それぞれが直に `inert = false` へ戻すと、React が
// cleanup をまとめて流したあとで、開いたままの側の inert まで消えてしまう
// （背景とタブバーが操作できる aria-modal ダイアログになる）。
let locks = 0;

function apply() {
  document
    .querySelectorAll<HTMLElement>("[data-app-modal-bg]")
    .forEach((el) => {
      el.inert = locks > 0;
    });
}

/**
 * 背景を inert にする。戻り値を呼ぶと解除する（useEffect の cleanup にそのまま渡せる）。
 * 二重解除は無視するので、cleanup が複数回走っても数がずれない。
 */
export function lockModalBackground(): () => void {
  locks += 1;
  apply();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks = Math.max(0, locks - 1);
    apply();
  };
}
