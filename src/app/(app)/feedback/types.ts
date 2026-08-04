// useActionState で扱う送信結果。
// "use server" ファイルからは async 関数以外を export できないため、
// 型・定数はここに切り出してクライアント側からも import できるようにする。
export type FeedbackState = {
  ok: boolean;
  // 画面に表示するメッセージ（丁寧な日本語）
  message?: string;
};

export const initialFeedbackState: FeedbackState = { ok: false };
