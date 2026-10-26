// /auth/next 専用。Host / X-Forwarded-* から公開 origin を推測しない。
// Sec-* はブラウザJSが変更できず、same-origin はredirect chain全体の同originを示す。
// https://www.w3.org/TR/fetch-metadata/#sec-fetch-site-header
// https://fetch.spec.whatwg.org/#forbidden-request-header
export function isSameOriginPost(request: Pick<Request, "url" | "headers">): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  // Fetch Metadata を持たないクライアントでは従来の厳密な Origin 比較へ戻す。
  // Origin がない、または standalone の内部 origin と異なる場合は fail closed。
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}
