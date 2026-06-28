"use client";

import { useFormStatus } from "react-dom";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  pendingLabel?: ReactNode;
  children: ReactNode;
};

// useFormStatus で囲っている <form> の送信状態を読み、押下中は disabled + 別ラベルを出す。
// Server Action を action に持つ form 内であれば Server / Client どちらの親でも使える。
export default function SubmitButton({
  pendingLabel = "送信中…",
  children,
  disabled,
  ...props
}: Props) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      {...props}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
