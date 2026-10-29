"use client";

import { PawPrint } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { failureText, loginHref, type BrowserFailure } from "./browser";

export function McpFrame({ children }: { children: ReactNode }) {
  return <><header className="safe-px safe-pt border-b border-border bg-surface"><div className="mx-auto flex max-w-2xl items-center justify-between gap-3 py-4"><Link href="/" prefetch={false} className="flex min-h-11 items-center gap-2 text-xl font-bold tracking-tight text-primary"><PawPrint className="h-6 w-6" aria-hidden="true" />mfmf</Link><span className="rounded-full bg-surface-muted px-3 py-1 text-xs font-medium text-muted-foreground">AIとの接続</span></div></header><main id="main" className="mx-auto max-w-2xl px-4 pb-12 pt-6 sm:pt-8">{children}</main></>;
}

export function McpFailure({ kind, returnTo, retry }: { kind: BrowserFailure; returnTo: string; retry?: () => void }) {
  return <div className="space-y-3 rounded-xl border border-border bg-surface-muted p-4"><p role="alert" className="text-sm leading-relaxed text-foreground">{failureText[kind]}</p><div className="flex flex-wrap gap-3">{retry && kind !== "expired" && kind !== "unauthenticated" && <button type="button" onClick={retry} className="min-h-11 rounded-lg border border-border bg-surface px-4 text-sm font-semibold">もう一度確認する</button>}<a href={loginHref(returnTo)} className="inline-flex min-h-11 items-center rounded-lg border border-border bg-surface px-4 text-sm font-semibold">ログインし直す</a><a href="/menu" className="inline-flex min-h-11 items-center px-2 text-sm text-muted-foreground">mfmfへ戻る</a></div></div>;
}

