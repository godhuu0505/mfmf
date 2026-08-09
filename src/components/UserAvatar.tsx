import Image from "next/image";
import { UserRound } from "lucide-react";

type Props = {
  /** 表示する画像 URL（アプリ内アバターの署名付き URL / Google の画像）。無ければ null。 */
  url: string | null;
  /** 画像が無いときに出す頭文字。空なら人型アイコンにフォールバックする。 */
  initial: string;
  /** 一辺 px。 */
  size: number;
  /** 画像の代替テキスト（装飾扱いにしたいときは空文字）。 */
  alt?: string;
  /** 外枠に足すクラス（背景・リング・文字色など）。 */
  className?: string;
};

// ユーザーアイコンの共通表示。優先順位は
// アプリ内で設定したアバター > Google アカウントの画像 > 名前の頭文字 > 人型アイコン。
// URL の解決は `src/lib/userAvatar.ts` の getUserAvatarData が持つ。
export default function UserAvatar({
  url,
  initial,
  size,
  alt = "",
  className = "",
}: Props) {
  return (
    <span
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full ${className}`}
      style={{ width: size, height: size }}
    >
      {url ? (
        <Image
          src={url}
          alt={alt}
          fill
          sizes={`${size}px`}
          // Supabase の署名付き URL / Google の画像を最適化に通さず素で出す。
          unoptimized
          className="object-cover"
        />
      ) : initial ? (
        <span aria-hidden="true">{initial}</span>
      ) : (
        <UserRound style={{ width: size / 2, height: size / 2 }} aria-hidden="true" />
      )}
    </span>
  );
}
