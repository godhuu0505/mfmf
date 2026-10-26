import { NextResponse } from "next/server";
import { sanitizeNextPath } from "./nextPath";

// Next standalone の Route Handler は request.url に内部 listen address を使うことがある。
// Location は公開 origin を推測せず、ブラウザが現在の origin で解決できるサイト内パスにする。
export function siteRelativeLocation(path: string): string {
  const base = "https://redirect.invalid";
  const url = new URL(sanitizeNextPath(path), base);
  if (url.origin !== base) return "/";
  // URL で Unicode を符号化する。dot-segment 正規化後の //evil 等も再検証する。
  return sanitizeNextPath(`${url.pathname}${url.search}${url.hash}`);
}

export function siteRedirect(path: string, status: 303 | 307 = 307): NextResponse {
  // NextResponse.redirect は絶対URLを要求するため、HTTPで有効な相対Locationを直接設定する。
  return new NextResponse(null, { status, headers: { Location: siteRelativeLocation(path) } });
}
